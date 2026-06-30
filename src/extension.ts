import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { exec } from 'child_process';

/**
 * AutoContinue: a toggleable timer that monitors for chat API errors
 * (503, MODEL_CAPACITY_EXHAUSTED, rate limiting) and automatically
 * sends a configurable prompt to resume the AI agent.
 *
 * Error detection strategies (in priority order):
 *
 *   0. getDiagnostics log parsing — calls `antigravity.getDiagnostics`
 *      which returns a ~176KB JSON containing ALL log streams and recent
 *      conversation trajectories. Parses `mainThreadLogs`, `rendererLogs`,
 *      and `languageServerLogs` for error patterns (503, rate limit, capacity).
 *      Also monitors `recentTrajectories[0].lastStepIndex` for stalls.
 *      MOST RELIABLE — requires no focus management, no context key scoping.
 *
 *   1. Context key inspection — reads `chatSessionResponseError` via
 *      `getContext`. This key is SCOPED to the chat response element,
 *      so it only works when a response item is in the focus chain.
 *
 *   2. Focus probe with response navigation — focuses the chat panel
 *      and attempts to navigate to the last response element to bring
 *      scoped context keys into the focus chain.
 *
 *   3. Idle timeout — tracks `chatSessionRequestInProgress` (readable
 *      at chat-view scope) and triggers recovery when the agent has
 *      been idle for a configurable period after being active.
 *
 *   4. Manual trigger — the `helmAutoContinue.reportError` command lets
 *      the user manually signal an error they see in the chat.
 *
 * Error response state machine:
 *   MONITORING     → error detected → WAITING_IDLE (if busy) or COOLDOWN (if idle)
 *   WAITING_IDLE   → agent goes idle → COOLDOWN
 *   COOLDOWN       → timer expires  → send Continue → MONITORING
 *   (repeat forever — no retry limit, no backoff)
 *
 * Dispatch strategy:
 *   1. antigravity.sendPromptToAgentPanel — native Antigravity API
 *   2. workbench.action.chat.open with query — standard VS Code Chat API
 *   3. Clipboard fallback — copies prompt and opens chat panel
 */

// ─── Types ────────────────────────────────────────────────────────────────

type LogLevel = 'minimal' | 'normal' | 'verbose';
const LOG_LEVEL_ORDER: LogLevel[] = ['minimal', 'normal', 'verbose'];

/**
 * Error state machine:
 *   MONITORING     → error detected → WAITING_IDLE (if busy) or COOLDOWN (if idle)
 *   WAITING_IDLE   → agent goes idle → COOLDOWN
 *   COOLDOWN       → timer expires  → send Continue → MONITORING
 */
type ErrorState = 'monitoring' | 'waiting_idle' | 'cooldown';

interface SessionStats {
  totalPolls: number;
  errorsDetected: number;
  continuesSent: number;
  lastState: string;
  startedAt: number | null;
}

interface ProbeResult {
  hasError: boolean;
  /** True if the agent is actively processing RIGHT NOW on this poll. */
  isBusy: boolean;
  /**
   * True if the agent was active within the configured busy window.
   * Used by WAITING_IDLE — broader than isBusy, covers in-progress
   * tool calls where the step index hasn't ticked yet.
   */
  isRecent: boolean;
  source?: string;
}

/** Circular step-index history entry */
interface StepEntry {
  ts: number;   // Date.now() when observed
  step: number; // lastStepIndex value
}

// Default error patterns — trigger auto-continue (configurable via settings)
const DEFAULT_ERROR_PATTERNS = [
  '\\b503\\b',
  'rate.?limit',
  'capacity.?exhaust',
  'model.?capacity',
  'overloaded',
  'too.?many.?requests',
  'service.?unavailable',
  'quota.?exceeded',
  'temporarily.?unavailable',
  'RESOURCE_EXHAUSTED',
  'server.?error',
  'internal.?server.?error',
  'high.?traffic',
  'try.?again.?in',
  'please.?try.?again',
  'experiencing.?high',
  'No capacity available',
  'MODEL_CAPACITY_EXHAUSTED',
];

// Default suppress patterns — non-retryable, stop monitoring (configurable via settings)
const DEFAULT_SUPPRESS_PATTERNS = [
  'insufficient.?ai.?credits',
  'insufficient.?credits',
  'no.?credits.?remaining',
  'billing.?required',
  'payment.?required',
  'subscription.?expired',
];

// ─── AutoContinue ─────────────────────────────────────────────────────────

class AutoContinue {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _statusBar: vscode.StatusBarItem;
  private _debugBar: vscode.StatusBarItem;
  private _running = false;

  /** Timestamp when monitoring started — used for cold-start detection */
  private _monitoringStartedAt = 0;

  /** Whether we've EVER seen the agent busy since monitoring started */
  private _everSeenBusy = false;

  /** Manual error flag — set by `reportError` command, consumed on next tick */
  private _manualErrorFlag = false;

  /** Output channel for logging */
  private _output: vscode.OutputChannel;

  /** Settings webview panel */
  private _settingsPanel: vscode.WebviewPanel | undefined;

  /** Whether a test run is active — enables live log pushes to webview */
  private _testRunActive = false;

  /** Whether context keys are available (null = unknown) */
  private _contextKeysAvailable: boolean | null = null;

  // ─── Diagnostics-based Detection (Strategy 0) ─────────────────────────

  /** Whether antigravity.getDiagnostics is available */
  private _diagnosticsAvailable: boolean | null = null;

  /** Tracked state per log source for detecting new entries.
   *  Stores both length and tail fingerprint to handle fixed-size
   *  circular buffers where old entries drop and length stays constant. */
  private _lastLogState: Record<string, { length: number; lastEntry: string }> = {};

  /**
   * Circular buffer of the last N observed (timestamp, stepIndex) pairs.
   * Used to determine both "changed this poll" (isBusy) and "changed
   * recently" (isRecent) without relying on lastModifiedTime at all.
   */
  private _stepHistory: StepEntry[] = [];
  private static readonly STEP_HISTORY_SIZE = 8;

  /**
   * Trajectory ID (googleAgentId) that we've bound to for this window.
   * Bound on the FIRST step-index change that comes from a trajectory
   * modified after this window's monitoring session started.
   * Once set, only this specific trajectory is used for busy/stall detection.
   */
  private _boundTrajectoryId: string | null = null;

  /** How often to call getDiagnostics (expensive — every N polls) */
  private _diagPollCounter = 0;

  // ─── Idle Timeout Tracking ────────────────────────────────────────────

  /** Was the agent busy on the previous poll? (for transition detection) */
  private _lastSeenBusy = false;

  /** Timestamp when agent transitioned from busy to idle */
  private _idleSince: number | null = null;

  /** Timestamp when agent first became busy in current cycle */
  private _busyStart: number | null = null;

  // ─── Error State Machine ──────────────────────────────────────────────

  /**
   * Current error state:
   *   monitoring    — polling for errors, no error active
   *   waiting_idle  — error detected, agent is busy, waiting for !busy
   *   cooldown      — agent is idle, waiting cooldown before sending Continue
   */
  private _errorState: ErrorState = 'monitoring';

  /** When the cooldown period started (Date.now()) */
  private _cooldownStartedAt = 0;

  // ─── Diagnostic Capture ──────────────────────────────────────────────

  /** Whether we've already captured diagnostics for the current error cycle */
  private _capturedThisCycle = false;

  /** When set, _checkDiagnostics returns a synthetic error on the next call. */
  private _simulatedErrorPending = false;

  // ────────────────────────────────────────────────────────────────────────

  /** Session statistics */
  private _stats: SessionStats = {
    totalPolls: 0,
    errorsDetected: 0,
    continuesSent: 0,
    lastState: 'idle',
    startedAt: null,
  };

  /** CDP Auto Clicker — independent DOM-injection subsystem */
  private _cdpAutoClicker!: CdpAutoClicker;

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._output = vscode.window.createOutputChannel('Antigravity Recovery Auto Continue');
    _context.subscriptions.push(this._output);

    // Main status bar button (opens settings)
    this._statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this._statusBar.command = 'helmAutoContinue.openSettings';
    this._updateStatusBar();
    this._statusBar.show();
    _context.subscriptions.push(this._statusBar);

    // Debug status bar button (opens output channel)
    this._debugBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this._debugBar.command = 'helmAutoContinue.showLog';
    this._updateDebugBar();
    this._debugBar.show();
    _context.subscriptions.push(this._debugBar);

    // Listen for config changes that affect the timer interval
    _context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('helmAutoContinue.intervalSeconds') && this._running) {
          this._log('Config changed — restarting timer with new interval');
          this._stopTimer();
          this._startTimer();
        }
      })
    );

    // One-time availability checks
    void this._checkContextKeyAvailability();
    void this._checkDiagnosticsAvailability();

    // CDP Auto Clicker — instantiate and optionally auto-start
    this._cdpAutoClicker = new CdpAutoClicker(
      _context,
      (msg) => this._log(msg)
    );
    _context.subscriptions.push({ dispose: () => this._cdpAutoClicker.dispose() });
    if (this._getConfig<boolean>('cdpAutoClick', false)) {
      this._cdpAutoClicker.start();
    }

    // Auto-start error-recovery monitor if configured
    const autoStart = this._getConfig<boolean>('startOnActivation', true);
    if (autoStart) {
      this.start();
    }
  }

  start(): void {
    if (this._running) return;

    this._running = true;
    this._errorState = 'monitoring';
    this._cooldownStartedAt = 0;
    this._lastSeenBusy = false;
    this._everSeenBusy = false;
    this._idleSince = null;
    // Do NOT seed _busyStart — we must actually observe the agent
    // working before idle timeout can fire. This prevents false
    // positives when monitoring starts with no active agent.
    this._busyStart = null;
    this._boundTrajectoryId = null;
    this._monitoringStartedAt = Date.now();
    this._lastLogState = {};
    this._stepHistory = [];
    this._diagPollCounter = 0;
    this._capturedThisCycle = false;
    this._stats.startedAt = Date.now();
    this._updateStatusBar();
    this._updateDebugBar();

    // Set cross-extension context key
    void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isActive', true);

    this._startTimer();
    this._pushRunningState();

    const intervalSec = this._getConfig<number>('intervalSeconds', 5);
    this._log(`Started (polling every ${intervalSec}s)`);
    vscode.window.showInformationMessage(
      `Antigravity Recovery Auto Continue started (checking every ${intervalSec}s)`
    );
  }

  stop(): void {
    if (!this._running) return;

    this._stopTimer();
    this._running = false;
    this._errorState = 'monitoring';
    this._cooldownStartedAt = 0;
    this._lastSeenBusy = false;
    this._everSeenBusy = false;
    this._idleSince = null;
    this._busyStart = null;
    this._manualErrorFlag = false;
    this._simulatedErrorPending = false;
    this._capturedThisCycle = false;
    this._updateStatusBar();
    this._updateDebugBar();

    // Clear cross-extension context keys
    void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isActive', false);
    void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isRetrying', false);

    this._pushRunningState();

    this._log('Stopped');
    this._logStats();
    vscode.window.showInformationMessage('Antigravity Recovery Auto Continue stopped');
  }

  toggle(): void {
    this._running ? this.stop() : this.start();
  }

  showLog(): void {
    this._output.show(true);
  }

  openSettings(): void {
    if (this._settingsPanel) {
      this._settingsPanel.reveal();
      return;
    }

    this._settingsPanel = vscode.window.createWebviewPanel(
      'helmAutoContinueSettings',
      'Antigravity Recovery Auto Continue',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
      }
    );

    const logoUri = this._settingsPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'helm-logo.svg')
    );
    this._settingsPanel.webview.html = this._getSettingsHtml(logoUri);

    // Handle messages from the webview
    this._settingsPanel.webview.onDidReceiveMessage(
      (msg: { type: string; key?: string; value?: unknown }) => {
        if (msg.type === 'updateSetting' && msg.key) {
          const config = vscode.workspace.getConfiguration('helmAutoContinue');
          void config.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        } else if (msg.type === 'toggleMonitoring') {
          this.toggle();
        } else if (msg.type === 'simulateError') {
          this.simulateError();
        } else if (msg.type === 'markWindowActive') {
          this.markWindowActive();
        } else if (msg.type === 'runFullTest') {
          this.runFullTest();
        } else if (msg.type === 'toggleCdp') {
          // Toggle CDP Auto Clicker and persist to config
          const nowEnabled = this._cdpAutoClicker.isEnabled;
          if (nowEnabled) {
            this._cdpAutoClicker.stop();
          } else {
            this._cdpAutoClicker.start();
          }
          const config = vscode.workspace.getConfiguration('helmAutoContinue');
          void config.update('cdpAutoClick', !nowEnabled, vscode.ConfigurationTarget.Global);
        }
      },
      undefined,
      this._context.subscriptions
    );

    // Give the CDP clicker a reference to this panel so it can push live status updates
    this._cdpAutoClicker.setSettingsPanelRef(this._settingsPanel);
    // Push the current CDP state immediately so the panel reflects reality on first open
    this._cdpAutoClicker.pushCdpStatus();

    this._settingsPanel.onDidDispose(() => {
      this._settingsPanel = undefined;
      this._cdpAutoClicker.setSettingsPanelRef(undefined);
    });
  }

  /**
   * Manually report a chat error.
   */
  reportError(): void {
    this._manualErrorFlag = true;
    this._log('⚠ Manual error reported — will send Continue on next tick');
    vscode.window.showInformationMessage(
      'Antigravity Recovery Auto Continue: Error reported — will retry automatically.'
    );

    if (!this._running) {
      this.start();
    }
  }

  /**
   * Inject a synthetic "503 error" into the diagnostics scanning path.
   *
   * Sets a flag that _checkDiagnostics will detect on its next call and
   * return as a real error — exercising the full detection → state machine
   * → send Continue pipeline without needing an actual API error.
   */
   simulateError(): void {
    if (!this._running) {
      this.start();
    }
    this._simulatedErrorPending = true;
    // Bypass Window Scope Recovery — simulated errors should always fire
    this._everSeenBusy = true;
    this._testRunActive = true;
    this._pushTestLog('info', '🧪 Synthetic "503 error" queued — will fire on next diagnostics poll');
    this._log('🧪 Test: synthetic "503 error" queued — will fire on next diagnostics poll');
    vscode.window.showInformationMessage(
      'Auto Continue: Synthetic error queued. Watch the test console for the recovery cycle.'
    );
  }

  /**
   * Mark this window as having seen the agent active.
   * Sets _everSeenBusy = true so window scope recovery doesn’t suppress
   * error detection. Use this before simulateError() when testing in a
   * fresh window where the agent hasn’t actually been busy yet.
   */
  markWindowActive(): void {
    this._everSeenBusy = true;
    this._log('🧪 Test: window marked as active (_everSeenBusy = true)');
    vscode.window.showInformationMessage(
      'Auto Continue: Window marked as active — window scope check will no longer suppress errors.'
    );
  }

  /**
   * Run the full test pipeline: Mark Active + Simulate Error.
   *
   * Combines both steps into a single action and clears the test console
   * so the user gets a clean trace of the detect → cooldown → send cycle.
   */
  runFullTest(): void {
    // Clear the test console for a clean run
    this._pushTestLog('clear', '');
    this._pushTestLog('info', '🧪 === Full Pipeline Test ===');

    // Step 1: Ensure monitoring is running (must happen BEFORE setting
    // _everSeenBusy because start() resets it to false).
    if (!this._running) {
      this.start();
      this._pushTestLog('info', '⚡ Monitoring was stopped — auto-started');
    } else {
      // Already running — reset gates that could suppress the test error:
      // - _idleSince: prevents recovery timeout gate from swallowing it
      // - _errorState: ensures we're in monitoring state to detect new errors
      // - _capturedThisCycle: allows diagnostics capture for this test run
      this._idleSince = null;
      this._errorState = 'monitoring';
      this._capturedThisCycle = false;
      this._pushTestLog('info', '📡 Monitoring already active — gates reset for test');
    }

    // Step 2: Mark window active AFTER start() — bypasses window scope
    // recovery gate that would otherwise suppress the simulated error.
    // (start() resets _everSeenBusy = false, so this MUST come after.)
    this._everSeenBusy = true;
    this._pushTestLog('ok', '✔ Window marked as active (_everSeenBusy = true)');
    this._log('🧪 Full test: window marked as active');

    // Step 3: Queue synthetic 503 error
    this._simulatedErrorPending = true;
    this._testRunActive = true;
    this._pushTestLog('info', '🧪 Synthetic "503 error" queued — will fire on next diagnostics poll');
    this._pushTestLog('info', '⏳ Watching pipeline: detect → cooldown → send Continue...');
    this._log('🧪 Full test: synthetic "503 error" queued — pipeline trace active');

    // Show info message for visibility when called from command palette
    // (the test console is only visible in the settings webview)
    vscode.window.showInformationMessage(
      'Auto Continue: Full test started — synthetic 503 queued. Open settings panel to watch the pipeline trace.'
    );
  }

  dispose(): void {
    this.stop();
    this._cdpAutoClicker.dispose();
    this._settingsPanel?.dispose();
    this._statusBar.dispose();
    this._debugBar.dispose();
  }

  /** Push the current running state to the settings webview */
  private _pushRunningState(): void {
    this._settingsPanel?.webview.postMessage({
      type: 'runningState',
      running: this._running,
    });
  }

  /**
   * Push a test log message to the settings webview's test console.
   * Only sends when a test run is active AND the panel is open.
   */
  private _pushTestLog(level: 'info' | 'ok' | 'warn' | 'error' | 'clear', message: string): void {
    this._settingsPanel?.webview.postMessage({
      type: 'testLog',
      level,
      message,
      ts: new Date().toLocaleTimeString(),
    });
  }

  // ─── Timer Management ──────────────────────────────────────────────────

  /**
   * Start the self-scheduling timer loop.
   *
   * Uses setTimeout instead of setInterval to guarantee sequential
   * execution — the next tick is only scheduled after the previous
   * one completes. Prevents overlapping ticks when _tick() is slow.
   */
  private _startTimer(): void {
    const loop = async () => {
      if (!this._running) return;
      await this._tick();
      if (this._running) {
        const intervalSec = this._getConfig<number>('intervalSeconds', 5);
        this._timer = setTimeout(loop, intervalSec * 1000);
      }
    };
    // Run immediately, then schedule
    void loop();
  }

  private _stopTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  // ─── Core Logic ──────────────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    this._stats.totalPolls++;
    const level = this._getLogLevel();

    // Detect error and busy state using all available strategies
    const result = await this._detectState();
    const { hasError, isBusy } = result;

    // Build state label for logging/debug bar
    const stateLabel = this._errorState === 'monitoring'
      ? (hasError ? (isBusy ? 'ERROR+BUSY' : 'ERROR') : (isBusy ? 'BUSY' : 'OK'))
      : this._errorState === 'waiting_idle'
        ? 'WAIT_IDLE'
        : 'COOLDOWN';

    this._stats.lastState = stateLabel;

    // Log poll summary — full at verbose, silent at normal/minimal
    if (level === 'verbose') {
      this._log(
        `Poll #${this._stats.totalPolls}: error=${hasError} busy=${isBusy} → ${stateLabel} (phase=${this._errorState})`
      );
    }
    // normal/minimal: no per-tick line — only state changes are logged

    this._updateDebugBar();

    // ─── State Machine ─────────────────────────────────────────────────

    switch (this._errorState) {

      // ─── MONITORING: polling for errors ──────────────────────────────
      case 'monitoring': {
        if (!hasError) return; // All good — nothing to do

        // Error detected — begin error→send cycle
        this._stats.errorsDetected++;
        this._log(`⚠ Error detected${result.source ? ` [${result.source}]` : ''}`);
        if (this._testRunActive) {
          this._pushTestLog('warn', `⚠ Error detected [${result.source ?? 'unknown'}]`);
        }

        // Capture diagnostics once per error cycle
        if (!this._capturedThisCycle) {
          this._capturedThisCycle = true;
          void this._captureDiagnostics('error');
        }

        if (result.isRecent) {
          this._errorState = 'waiting_idle';
          this._log('  Agent recently active — waiting for idle before cooldown');
          if (this._testRunActive) {
            this._pushTestLog('info', '⏳ Agent recently active → WAITING_IDLE');
          }
        } else {
          this._errorState = 'cooldown';
          this._cooldownStartedAt = Date.now();
          const cooldownMs = this._getConfig<number>('postSendCooldownMs', 10000);
          this._log(`  Agent is idle — starting ${Math.round(cooldownMs / 1000)}s cooldown`);
          if (this._testRunActive) {
            this._pushTestLog('info', `⏳ Agent idle → COOLDOWN (${Math.round(cooldownMs / 1000)}s)`);
          }
        }

        void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isRetrying', true);
        this._updateStatusBar();
        this._updateDebugBar();
        break;
      }

      // ─── WAITING_IDLE: error detected, agent recently active, waiting for !recent ─
      case 'waiting_idle': {
        if (!result.isRecent) {
          this._errorState = 'cooldown';
          this._cooldownStartedAt = Date.now();
          const cooldownMs = this._getConfig<number>('postSendCooldownMs', 10000);
          this._log(`  Agent no longer active — starting ${Math.round(cooldownMs / 1000)}s cooldown`);
          this._updateDebugBar();
        } else {
          this._logAt('normal', `  Still active — waiting for idle...`);
        }
        break;
      }

      // ─── COOLDOWN: agent idle, waiting timer before sending Continue ──
      case 'cooldown': {
        const cooldownMs = this._getConfig<number>('postSendCooldownMs', 10000);
        const elapsed = Date.now() - this._cooldownStartedAt;

        if (elapsed >= cooldownMs) {
          // Cooldown complete — send Continue
          const prompt = this._getConfig<string>('continuePrompt', 'Continue');
          this._stats.continuesSent++;
          this._manualErrorFlag = false;

          this._log(`↻ Sending "${prompt}" (total sends: ${this._stats.continuesSent})`);
          if (this._testRunActive) {
            this._pushTestLog('ok', `↻ Sending "${prompt}" to chat panel...`);
          }

          // Reset state for next cycle
          this._errorState = 'monitoring';
          this._capturedThisCycle = false;

          // Reset idle tracking so timeout re-arms for next cycle
          this._idleSince = null;
          this._busyStart = null;
          this._lastSeenBusy = false;
          // Seed a synthetic step entry at the send time so busy-window
          // detection doesn't immediately fire again before the agent responds.
          this._stepHistory = [{ ts: Date.now(), step: -1 }];

          this._updateStatusBar();
          this._updateDebugBar();

          await this._sendToChatPanel(prompt);

          if (this._testRunActive) {
            this._pushTestLog('ok', '✅ Continue sent! Full pipeline test passed.');
            this._testRunActive = false;
          }

          void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isRetrying', false);
        } else {
          const remaining = Math.round((cooldownMs - elapsed) / 1000);
          this._logAt('normal', `  ⏳ Cooldown: ${remaining}s remaining`);
          if (this._testRunActive) {
            this._pushTestLog('info', `⏳ Cooldown: ${remaining}s remaining...`);
          }
        }
        break;
      }
    }
  }

  // ─── Error Detection ────────────────────────────────────────────────────

  /**
   * Detect chat error AND agent busy state.
   *
   * Detection strategies (in priority order):
   *   0. getDiagnostics log parsing — most reliable, no focus needed
   *   1. Context key — fast path when chat response element is already focused
   *   2. Focus probe — focuses chat, navigates to last response, reads keys
   *   3. Idle timeout — triggers when agent is idle too long after being busy
   *   4. Manual error flag — set by `reportError` command
   *
   * Also tracks busy/idle transitions for idle timeout detection via
   * `chatSessionRequestInProgress` (readable at the chat view-level scope).
   */
  private async _detectState(): Promise<ProbeResult> {
    const level = this._getLogLevel();

    // Strategy 0: getDiagnostics log parsing (most reliable, no focus needed)
    // NOTE: This runs BEFORE the recovery timeout gate so that busy/step
    // tracking always executes. If the agent wakes up after being idle,
    // _trackIdleState(true) clears _idleSince and the gate won't fire.
    const diagFrequency = this._getConfig<number>('diagnosticsFrequency', 1);
    this._diagPollCounter++;
    const diagDue = (this._diagnosticsAvailable && this._diagPollCounter >= diagFrequency) || this._simulatedErrorPending;
    if (level === 'verbose') {
      this._log(`  [S0:diag] available=${this._diagnosticsAvailable} due=${diagDue} (counter=${this._diagPollCounter}/${diagFrequency})`);
    }

    let diagResult: ProbeResult | null = null;
    if (diagDue) {
      this._diagPollCounter = 0;
      diagResult = await this._checkDiagnostics();
      if (level === 'verbose') {
        this._log(`  [S0:diag] result: error=${diagResult.hasError} busy=${diagResult.isBusy} recent=${diagResult.isRecent} source=${diagResult.source ?? 'none'}`);
      }
      // Track busy state FIRST — this may clear _idleSince if agent woke up
      this._trackIdleState(diagResult.isBusy);
    }

    // ─── Recovery Timeout Gate ──────────────────────────────────────────
    // Now that busy tracking has run, check if the agent is STILL idle
    // beyond the recovery threshold. This prevents stale errors from
    // triggering recovery in inactive windows, while still allowing the
    // gate to clear when the agent starts working again.
    const recoveryTimeoutSec = this._getConfig<number>('recoveryTimeoutSeconds', 300);
    if (recoveryTimeoutSec > 0 && this._idleSince) {
      const idleDuration = (Date.now() - this._idleSince) / 1000;
      if (idleDuration >= recoveryTimeoutSec) {
        if (level === 'verbose') {
          this._log(`  [recovery-timeout] Agent idle for ${Math.round(idleDuration)}s (threshold: ${recoveryTimeoutSec}s) — suppressing error detection`);
        }
        return { hasError: false, isBusy: false, isRecent: false };
      }
    }

    // Process diagnostics error result (deferred from above)
    if (diagResult?.hasError) {
      // Window Scope Recovery: require this window's agent was recently active
      const windowScope = this._getConfig<boolean>('windowScopeRecovery', true);
      if (windowScope && !this._everSeenBusy) {
        this._logAt('normal', `  [S0:diag] Error suppressed by Window Scope Recovery — agent never active in this window`);
      } else {
        this._log(`  [detect] ★ Diagnostics: error found via ${diagResult.source}`);
        return diagResult;
      }
    }

    // Strategy 1: Context key from current focus (fast, no side effects)
    const contextKeyError = await this._hasChatError();
    if (level === 'verbose') {
      this._log(`  [S1:ctxKey] chatSessionResponseError=${contextKeyError}`);
    }
    if (contextKeyError) {
      this._log('  [detect] ★ Context key: chatSessionResponseError=true');
      const busy = await this._readBusyKey();
      this._trackIdleState(busy);
      return { hasError: true, isBusy: busy, isRecent: busy || this._lastSeenBusy };
    } else if (this._contextKeysAvailable) {
      // Even when no error, try to read busy state for idle tracking
      const busy = await this._readBusyKey();
      this._trackIdleState(busy);
    }

    // Strategy 2: Focus probe
    const probeEnabled = this._getConfig<boolean>('focusProbe', false);
    if (level === 'verbose') {
      this._log(`  [S2:probe] enabled=${probeEnabled}`);
    }
    if (probeEnabled) {
      const probeResult = await this._probeChatState();
      if (level === 'verbose') {
        this._log(`  [S2:probe] result: error=${probeResult.hasError} busy=${probeResult.isBusy}`);
      }
      this._trackIdleState(probeResult.isBusy);

      if (probeResult.hasError) {
        this._log('  [detect] ★ Focus probe: chatSessionResponseError=true');
        return { ...probeResult, isRecent: probeResult.isBusy || this._lastSeenBusy };
      }
    }

    // Strategy 3: Idle timeout
    const idleTimeoutSec = this._getConfig<number>('idleTimeoutSeconds', 0);
    const idleElapsed = this._idleSince ? Math.round((Date.now() - this._idleSince) / 1000) : null;
    const busyElapsed = this._busyStart ? Math.round((Date.now() - this._busyStart) / 1000) : null;
    const idleTriggered = idleTimeoutSec > 0 && this._everSeenBusy && this._checkIdleTimeout(idleTimeoutSec);
    if (level === 'verbose') {
      this._log(`  [S3:idle] timeout=${idleTimeoutSec}s busyStart=${busyElapsed !== null ? busyElapsed + 's ago' : 'never'} idleSince=${idleElapsed !== null ? idleElapsed + 's ago' : 'never'} lastSeenBusy=${this._lastSeenBusy} everSeenBusy=${this._everSeenBusy} triggered=${idleTriggered}`);
    }
    if (idleTriggered) {
      this._log(
        `  [detect] ★ Idle timeout: agent inactive for ${idleElapsed}s (threshold: ${idleTimeoutSec}s)`
      );
      return { hasError: true, isBusy: false, isRecent: false };
    }

    // Strategy 4: Manual trigger
    if (this._manualErrorFlag) {
      this._log('  [detect] ★ Manual: error flag set by user');
      return { hasError: true, isBusy: false, isRecent: false };
    }

    if (level === 'verbose') {
      this._log(`  [detect] No error detected by any strategy`);
    }
    return { hasError: false, isBusy: this._lastSeenBusy, isRecent: this._lastSeenBusy };
  }

  // ─── Idle Timeout Tracking ──────────────────────────────────────────────

  /**
   * Track busy/idle state transitions from `chatSessionRequestInProgress`.
   *
   * Called on every probe to build a timeline of agent activity. The idle
   * timeout strategy uses this to detect when the agent has been silent
   * for too long after being active (likely due to an undetectable error).
   */
  private _trackIdleState(isBusy: boolean): void {
    if (isBusy) {
      this._everSeenBusy = true;
      if (!this._busyStart) {
        this._busyStart = Date.now();
        this._logAt('normal', '● Agent busy');
      }
      this._idleSince = null;
      this._lastSeenBusy = true;
    } else if (this._lastSeenBusy) {
      this._idleSince = Date.now();
      this._lastSeenBusy = false;
      const busyDuration = this._busyStart
        ? Math.round((Date.now() - this._busyStart) / 1000)
        : '?';
      this._logAt('normal', `○ Agent idle (was busy ${busyDuration}s)`);
    }
  }

  /**
   * Check if the agent has been idle long enough to trigger recovery.
   *
   * Triggers when:
   *   1. `_idleSince` is set (either from a real busy→idle transition
   *      or from the cold-start fallback)
   *   2. Idle duration exceeds the configured threshold
   *
   * NOTE: `_busyStart` guard was removed — cold-start detection seeds
   * `_busyStart` at extension start, but even without it, if `_idleSince`
   * is set we should respect the timeout.
   */
  private _checkIdleTimeout(timeoutSec: number): boolean {
    if (!this._idleSince) return false;
    const idleDuration = Date.now() - this._idleSince;
    return idleDuration >= timeoutSec * 1000;
  }

  // ─── Chat API Inspection ─────────────────────────────────────────────

  /**
   * Check if the chat session's last response ended with an error.
   * Fast check from current focus — no side effects.
   *
   * NOTE: This key is SCOPED to the chat response widget element.
   * Only readable when a specific response item is focused, NOT when
   * just the chat input box has focus.
   */
  private async _hasChatError(): Promise<boolean> {
    try {
      const hasError = await vscode.commands.executeCommand<boolean>(
        'getContext',
        'chatSessionResponseError'
      );
      if (this._getLogLevel() === 'verbose') this._log(`  [S1:ctxKey] raw chatSessionResponseError = ${JSON.stringify(hasError)}`);
      return hasError === true;
    } catch (e: any) {
      if (this._getLogLevel() === 'verbose') this._log(`  [S1:ctxKey] getContext threw: ${e.message ?? 'unknown'}`);
      return false;
    }
  }

  /**
   * Focus probe: briefly focus the chat panel, attempt to navigate to the
   * last response element (bringing scoped context keys into the focus
   * chain), read BOTH error and busy keys, then conditionally restore
   * editor focus.
   *
   * The probe attempts two focus strategies:
   *   1. `workbench.action.chat.open` — focuses the chat input box
   *      (brings `requestInProgress` into chat-view scope but NOT
   *       `responseHasError` which is response-element scoped)
   *   2. `list.focusLast` — generic list navigation that may move focus
   *      from the input box into the message list, potentially bringing
   *      response-level context keys into scope
   *
   * Focus restoration is SKIPPED when:
   *   - An error was detected → keep chat focused for recovery
   *   - We're currently retrying → chat should stay focused
   *   - The "active editor" is an output channel → prevent log stealing focus
   */
  private async _probeChatState(): Promise<ProbeResult> {
    const level = this._getLogLevel();
    const activeEditor = vscode.window.activeTextEditor;
    const activeDoc = activeEditor?.document;
    const activeViewColumn = activeEditor?.viewColumn;

    if (level === 'verbose') {
      this._log(`  [S2:probe] activeDoc=${activeDoc?.uri.toString().substring(0, 60) ?? 'none'} scheme=${activeDoc?.uri.scheme ?? 'n/a'}`);
    }

    let result: ProbeResult = { hasError: false, isBusy: false, isRecent: false };
    let isBusy = false;

    const focusStrategies: Array<{
      name: string;
      commands: Array<{ cmd: string; args?: any; delayAfter: number }>;
    }> = [
      {
        name: 'A: chat.open → list.focusLast',
        commands: [
          { cmd: 'workbench.action.chat.open', delayAfter: 100 },
          { cmd: 'list.focusLast', delayAfter: 80 },
        ],
      },
      {
        name: 'B: agentPanel.focus → list.focusLast',
        commands: [
          { cmd: 'antigravity.agentPanel.focus', delayAfter: 100 },
          { cmd: 'list.focusLast', delayAfter: 80 },
        ],
      },
      {
        name: 'C: toggleChatFocus → list.focusLast',
        commands: [
          { cmd: 'antigravity.toggleChatFocus', delayAfter: 100 },
          { cmd: 'list.focusLast', delayAfter: 80 },
        ],
      },
      {
        name: 'D: chat.open → list.focusFirst → list.focusLast',
        commands: [
          { cmd: 'workbench.action.chat.open', delayAfter: 100 },
          { cmd: 'list.focusFirst', delayAfter: 50 },
          { cmd: 'list.focusLast', delayAfter: 80 },
        ],
      },
    ];

    for (const strategy of focusStrategies) {
      try {
        for (const step of strategy.commands) {
          await vscode.commands.executeCommand(step.cmd, step.args);
          if (step.delayAfter > 0) {
            await new Promise(r => setTimeout(r, step.delayAfter));
          }
        }

        const errorVal = await vscode.commands.executeCommand<boolean>(
          'getContext',
          'chatSessionResponseError'
        );
        const busyVal = await vscode.commands.executeCommand<boolean>(
          'getContext',
          'chatSessionRequestInProgress'
        );

        if (level === 'verbose') {
          this._log(`  [S2:probe:${strategy.name}] error=${JSON.stringify(errorVal)} busy=${JSON.stringify(busyVal)}`);
        }

        if (busyVal === true) isBusy = true;

        if (errorVal === true) {
          this._log(`  [S2:probe] ★ Strategy "${strategy.name}" detected error!`);
          result = { hasError: true, isBusy, isRecent: false };
          break;
        }

        if (errorVal === false) {
          if (level === 'verbose') {
            this._log(`  [S2:probe] Strategy "${strategy.name}" can read error key (value=false, no error)`);
          }
          result = { hasError: false, isBusy, isRecent: false };
          break;
        }

        if (level === 'verbose') {
          this._log(`  [S2:probe] Strategy "${strategy.name}" → error key not in scope (undefined)`);
        }
      } catch (e: any) {
        if (level === 'verbose') {
          this._log(`  [S2:probe] Strategy "${strategy.name}" threw: ${e.message ?? 'unknown'}`);
        }
      }
    }

    const shouldRestore = !result.hasError
      && this._errorState === 'monitoring'
      && activeDoc
      && activeDoc.uri.scheme !== 'output';

    if (level === 'verbose') this._log(`  [S2:probe] shouldRestore=${shouldRestore} result: error=${result.hasError} busy=${result.isBusy}`);

    if (shouldRestore) {
      try {
        await vscode.window.showTextDocument(activeDoc!, {
          viewColumn: activeViewColumn,
          preserveFocus: false,
        });
      } catch {
        // Editor may have been closed — ignore
      }
    }

    return result;
  }

  /**
   * Read the `chatSessionRequestInProgress` context key.
   *
   * Used by the fast path (strategy 1) when chat is already focused.
   * Same scoping limitations — only readable when the chat panel is
   * in the focus chain. But this key is at the VIEW level, not the
   * response-element level, so it works with the chat input focused.
   */
  private async _readBusyKey(): Promise<boolean> {
    try {
      const inProgress = await vscode.commands.executeCommand<boolean>(
        'getContext',
        'chatSessionRequestInProgress'
      );
      return inProgress === true;
    } catch {
      return false;
    }
  }

  /**
   * One-time check: verify that `getContext` is available.
   */
  private async _checkContextKeyAvailability(): Promise<void> {
    try {
      await vscode.commands.executeCommand('getContext', 'chatSessionResponseError');
      this._contextKeysAvailable = true;
      this._logAt('normal', 'Context key API available');
    } catch {
      this._contextKeysAvailable = false;
      this._log('⚠ Context key API not available — will rely on diagnostics, idle timeout, and manual reporting');
    }
  }

  /**
   * Parse the result of `antigravity.getDiagnostics` into a usable object.
   *
   * The command may return:
   *   - A JSON string (original format) — needs JSON.parse
   *   - A parsed object (newer format) — use directly
   *   - null/undefined/empty — invalid
   *
   * Returns the parsed object, or null if the result is invalid.
   */
  private _parseDiagnosticsResult(raw: unknown): Record<string, unknown> | null {
    if (!raw) return null;

    // Already a parsed object — use directly
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }

    // JSON string — parse it
    if (typeof raw === 'string' && raw.length > 100) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * One-time check: verify that `antigravity.getDiagnostics` is available.
   */
  private async _checkDiagnosticsAvailability(): Promise<void> {
    try {
      const raw = await vscode.commands.executeCommand<unknown>('antigravity.getDiagnostics');
      const parsed = this._parseDiagnosticsResult(raw);
      if (parsed) {
        this._diagnosticsAvailable = true;
        const trajectoryCount = (parsed.recentTrajectories as any[])?.length ?? 0;
        // Initialize log indices to current lengths so we only scan NEW entries
        const allSources = this._extractAllLogSources(parsed);
        for (const [name, entries] of allSources) {
          this._lastLogState[name] = {
            length: entries.length,
            lastEntry: entries.length > 0 ? entries[entries.length - 1] : '',
          };
        }
        this._logAt('normal', `✓ getDiagnostics available (${trajectoryCount} trajectories, ${allSources.length} log sources)`);
      } else {
        this._diagnosticsAvailable = false;
        this._log('⚠ getDiagnostics returned empty/invalid — strategy 0 disabled');
      }
    } catch (e: any) {
      this._diagnosticsAvailable = false;
      this._log(`⚠ getDiagnostics not available: ${e.message ?? 'unknown error'} — strategy 0 disabled`);
    }
  }

  // ─── Diagnostics-based Error Detection (Strategy 0) ─────────────────────

  /**
   * Extract leaf-level log entries from a diagnostics log field value.
   *
   * Returns entries as a flat string[]. Handles:
   *   - A flat string → split on newlines
   *   - An array of strings → return directly
   *   - An object with { $typeName, logs: string[] } → return .logs
   *   - null/undefined → empty array
   *
   * Does NOT recurse into sub-fields — that's handled by _extractAllLogSources
   * which produces separate tracked sources for each leaf.
   */
  private _extractLeafEntries(value: unknown): string[] {
    if (!value) return [];
    if (typeof value === 'string') {
      return value.length > 0 ? value.split('\n').filter(l => l.length > 0) : [];
    }
    if (Array.isArray(value)) {
      return value.filter(v => typeof v === 'string' && v.length > 0);
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      // Format: { $typeName: string, logs: string[] }
      if ('logs' in obj && Array.isArray(obj.logs)) {
        return obj.logs.filter(v => typeof v === 'string' && v.length > 0);
      }
    }
    return [];
  }

  /**
   * Check if a value is a container object with named sub-fields
   * (as opposed to a leaf log source).
   *
   * A container looks like: { cloudcode: [...], auth: [...], 'ls-main': [...] }
   * A leaf looks like: string | string[] | { $typeName, logs: string[] }
   */
  private _isContainerObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    // If it has a 'logs' key, it's the { $typeName, logs } leaf format
    if ('logs' in obj && Array.isArray(obj.logs)) return false;
    // If it has non-$ keys that are arrays/strings/objects, it's a container
    const keys = Object.keys(obj).filter(k => !k.startsWith('$'));
    return keys.length > 0;
  }

  /**
   * Extract ALL log sources from the diagnostics payload.
   *
   * Returns an array of [sourceName, entries[]] tuples. Each leaf-level
   * log source gets its own entry with a dotted key (e.g., 'mainThreadLogs.ls-main')
   * so that incremental index tracking is stable even when the payload
   * structure has nested sub-fields.
   *
   * This handles the evolving payload format where fields like mainThreadLogs
   * can be:
   *   - A flat string (legacy)
   *   - { $typeName, logs: string[] } 
   *   - { cloudcode: string[], auth: string[], 'ls-main': string[] } (current)
   */
  private _extractAllLogSources(diag: Record<string, unknown>): Array<[string, string[]]> {
    const sources: Array<[string, string[]]> = [];
    const logFields = [
      'languageServerLogs',
      'rendererLogs',
      'mainThreadLogs',
    ];
    for (const field of logFields) {
      if (!(field in diag) || !diag[field]) continue;
      const value = diag[field];

      if (this._isContainerObject(value)) {
        // Nested: extract each sub-field as a separate tracked source
        const obj = value as Record<string, unknown>;
        for (const subKey of Object.keys(obj)) {
          if (subKey.startsWith('$')) continue;
          const entries = this._extractLeafEntries(obj[subKey]);
          if (entries.length > 0) {
            sources.push([`${field}.${subKey}`, entries]);
          }
        }
      } else {
        // Flat leaf: string, string[], or { logs: string[] }
        const entries = this._extractLeafEntries(value);
        if (entries.length > 0) {
          sources.push([field, entries]);
        }
      }
    }
    return sources;
  }

  /**
   * Check for errors by parsing the diagnostics payload.
   *
   * This calls `antigravity.getDiagnostics` which returns a ~6MB JSON
   * containing all log streams and recent conversation trajectories.
   *
   * Detection methods:
   *   A. Scan NEW entries across ALL log sources for error patterns
   *   B. Monitor `recentTrajectories[0].lastStepIndex` for stalls
   *
   * Log entry indices are tracked between calls so we only scan NEW entries,
   * avoiding false positives from old errors that have already been handled.
   */
  private async _checkDiagnostics(): Promise<ProbeResult> {
    const level = this._getLogLevel();
    try {
      // ─── Simulated error injection (dev/test) ─────────────────────────
      if (this._simulatedErrorPending) {
        this._simulatedErrorPending = false;
        this._log('🧪 [diag] Simulated error firing — returning synthetic 503');
        if (this._testRunActive) {
          this._pushTestLog('warn', '🧪 Simulated 503 detected by diagnostics scanner');
        }
        return { hasError: true, isBusy: false, isRecent: false, source: 'simulated 503 (test)' };
      }

      const raw = await vscode.commands.executeCommand<unknown>('antigravity.getDiagnostics');
      const diag = this._parseDiagnosticsResult(raw);
      if (!diag) {
        if (level === 'verbose') this._log(`  [diag] getDiagnostics returned empty/unparseable (type=${typeof raw})`);
        return { hasError: false, isBusy: false, isRecent: false };
      }

      const sizeEstimate = typeof raw === 'string' ? Math.round(raw.length / 1024) : Math.round(JSON.stringify(raw).length / 1024);
      if (level === 'verbose') this._log(`  [diag] Payload: ${sizeEstimate}KB (${typeof raw === 'string' ? 'string' : 'object'})`);

      // ─── A. Scan ALL log sources for error patterns ────────────────
      const allSources = this._extractAllLogSources(diag);

      for (const [sourceName, entries] of allSources) {
        const prev = this._lastLogState[sourceName];
        const currentLen = entries.length;
        const currentTail = currentLen > 0 ? entries[currentLen - 1] : '';

        if (!prev) {
          // First snapshot — record state and skip scanning
          this._lastLogState[sourceName] = { length: currentLen, lastEntry: currentTail };
          if (level === 'verbose') this._log(`  [diag:${sourceName}] first snapshot: ${currentLen} entries (skipping scan)`);
          continue;
        }

        // Detect new entries via BOTH length growth AND tail change.
        // Fixed-size circular buffers keep the same length but rotate content.
        const lengthGrew = currentLen > prev.length;
        const tailChanged = currentTail !== prev.lastEntry;
        const hasNew = lengthGrew || (currentLen > 0 && tailChanged);

        if (level === 'verbose') {
          this._log(`  [diag:${sourceName}] entries=${currentLen} prev=${prev.length} lengthGrew=${lengthGrew} tailChanged=${tailChanged} hasNew=${hasNew}`);
        }

        if (hasNew) {
          // Find how many entries are new:
          //   - If length grew: new entries = slice from prev.length
          //   - If length same but tail changed (circular buffer): find the
          //     last occurrence of the previous tail entry, scan after it.
          //     If prev tail is gone entirely, scan all entries.
          let newEntries: string[];
          if (lengthGrew) {
            newEntries = entries.slice(prev.length);
          } else {
            // Circular buffer — find where old tail is in current array
            let overlapEnd = -1;
            for (let i = currentLen - 2; i >= 0; i--) {
              if (entries[i] === prev.lastEntry) {
                overlapEnd = i;
                break;
              }
            }
            if (overlapEnd >= 0) {
              newEntries = entries.slice(overlapEnd + 1);
            } else {
              // Previous tail completely rotated out — scan all entries
              newEntries = entries;
            }
          }

          // Update state
          this._lastLogState[sourceName] = { length: currentLen, lastEntry: currentTail };

          if (level === 'verbose') {
            const lastFew = newEntries.slice(-3).join(' | ').substring(0, 300);
            this._log(`  [diag:${sourceName}] scanning ${newEntries.length} new entries, latest: ${lastFew.replace(/\n/g, '\\n')}`);
          }

          const combinedNew = newEntries.join('\n');

          // Compile patterns from user config
          const suppressPatterns = this._compilePatterns(
            this._getConfig<string[]>('suppressPatterns', DEFAULT_SUPPRESS_PATTERNS)
          );
          const errorPatterns = this._compilePatterns(
            this._getConfig<string[]>('errorPatterns', DEFAULT_ERROR_PATTERNS)
          );

          // Check suppression patterns first — non-retryable errors
          for (const pattern of suppressPatterns) {
            const match = combinedNew.match(pattern);
            if (match) {
              this._log(`  [diag] ⛔ ${sourceName} NON-RETRYABLE: "${match[0]}" — suppressing Continue`);
              vscode.window.showWarningMessage(
                `Antigravity Recovery Auto Continue: Non-retryable error detected ("${match[0]}"). Auto-continue paused.`
              );
              this.stop();
              return { hasError: false, isBusy: false, isRecent: false };
            }
          }

          for (const pattern of errorPatterns) {
            const match = combinedNew.match(pattern);
            if (match) {
              this._log(`  [diag] ★ ${sourceName} error: "${match[0]}" in ${newEntries.length} new entries`);
              return { hasError: true, isBusy: false, isRecent: false, source: `${sourceName}: ${match[0]}` };
            }
          }
          if (level === 'verbose') this._log(`  [diag:${sourceName}] No error patterns matched`);
        } else {
          // No changes — update state anyway (in case length shrank)
          this._lastLogState[sourceName] = { length: currentLen, lastEntry: currentTail };
        }
      }

      // ─── B. Monitor trajectory step index, agentStateDebug, and stalls ──
      const trajectories = diag.recentTrajectories;
      let diagBusy = false;      // changed step THIS poll (hard fact)
      let diagRecent = false;    // changed step within busy window (softer)

      if (Array.isArray(trajectories) && trajectories.length > 0) {
        const active = trajectories[0];
        const trajectoryId: string = active.googleAgentId ?? '';
        const currentStep: number = active.lastStepIndex ?? 0;

        const lastModified = active.lastModifiedTime ? new Date(active.lastModifiedTime).getTime() : 0;
        // Only consider trajectories that were modified after this window started.
        // This prevents another window's older trajectory from polluting our detection.
        const trajectoryIsFromThisSession = lastModified > this._monitoringStartedAt;

        // ── Step history management ────────────────────────────────────────
        // Record this poll's observation. We do this regardless of whether
        // the step changed, so the buffer always reflects real poll cadence.
        const prevEntry = this._stepHistory.length > 0
          ? this._stepHistory[this._stepHistory.length - 1]
          : null;
        const stepChangedThisPoll = prevEntry !== null && prevEntry.step !== currentStep;

        this._stepHistory.push({ ts: Date.now(), step: currentStep });
        if (this._stepHistory.length > AutoContinue.STEP_HISTORY_SIZE) {
          this._stepHistory.shift();
        }

        // Check if there is an active local chat session request in progress in this window.
        // This prevents binding to active trajectories in other windows.
        const isLocalWindowBusy = await this._readBusyKey();

        // ── Trajectory binding ─────────────────────────────────────────────
        // Bind to a trajectory on a step-change if it is from this session and a local request
        // is in progress in this window.
        if (stepChangedThisPoll && trajectoryIsFromThisSession && isLocalWindowBusy) {
          if (this._boundTrajectoryId !== trajectoryId) {
            this._logAt('normal', `  [diag:traj] Bound to trajectory ${trajectoryId.substring(0, 8)}... (step ${prevEntry?.step ?? '?'} → ${currentStep})`);
            this._boundTrajectoryId = trajectoryId;
          }
          // A step change IS direct proof the agent ran — set _everSeenBusy
          // so busy/stall detection and window scope recovery work correctly.
          if (!this._everSeenBusy) {
            this._everSeenBusy = true;
            this._logAt('normal', `  [diag:traj] Agent activity confirmed via step change — window marked active`);
          }
        }

        // ── Is this our trajectory? ────────────────────────────────────────
        // Only consider it our trajectory if we are bound to it.
        const isOurTrajectory = this._boundTrajectoryId === trajectoryId;

        if (isOurTrajectory && this._everSeenBusy) {
          // isBusy (hard): step changed on THIS poll
          diagBusy = stepChangedThisPoll;

          // isRecent (soft): any step change recorded anywhere in the history buffer.
          // History holds the last STEP_HISTORY_SIZE polls, so isRecent naturally
          // expires after N polls of silence — no time window needed.
          for (let i = this._stepHistory.length - 1; i >= 1; i--) {
            if (this._stepHistory[i].step !== this._stepHistory[i - 1].step) {
              diagRecent = true;
              break;
            }
          }

          if (level === 'verbose') {
            const histSummary = this._stepHistory.map(e => e.step).join('→');
            this._log(`  [diag:traj] id=${trajectoryId.substring(0, 8)}... step=${currentStep} changed=${stepChangedThisPoll} isOurs=${isOurTrajectory} diagBusy=${diagBusy} diagRecent=${diagRecent} history=[${histSummary}] bound=${this._boundTrajectoryId?.substring(0, 8) ?? 'none'} summary="${(active.summary || '').substring(0, 60)}"`);
          }

          // ── Stall detection via step history ─────────────────────────────
          // Independent of isRecent — fires based on real elapsed time since
          // the last step change, regardless of how many polls have occurred.
          const idleTimeoutSec = this._getConfig<number>('idleTimeoutSeconds', 0);
          if (idleTimeoutSec > 0 && this._stepHistory.length >= 2) {
            // Find the timestamp of the last step change in history
            let lastChangeTs: number | null = null;
            for (let i = this._stepHistory.length - 1; i >= 1; i--) {
              if (this._stepHistory[i].step !== this._stepHistory[i - 1].step) {
                lastChangeTs = this._stepHistory[i].ts;
                break;
              }
            }
            if (lastChangeTs !== null) {
              const stallDuration = Date.now() - lastChangeTs;
              if (stallDuration >= idleTimeoutSec * 1000) {
                const stallSec = Math.round(stallDuration / 1000);
                this._log(`  [diag] ★ Stall detected: step ${currentStep} unchanged for ${stallSec}s (threshold: ${idleTimeoutSec}s)`);
                return { hasError: true, isBusy: false, isRecent: false, source: `stall (${stallSec}s at step ${currentStep})` };
              }
            }
          }
        } else {
          if (level === 'verbose') {
            this._log(`  [diag:traj] id=${trajectoryId.substring(0, 8)}... step=${currentStep} isOurs=${isOurTrajectory} everBusy=${this._everSeenBusy} — skipped (not ours or never busy)`);
          }
        }
      } else {
        if (level === 'verbose') this._log(`  [diag:traj] No trajectories found`);
      }

      // ─── C. agentStateDebug.conversations — direct activity signal ────
      // If the diagnostics payload includes a conversations map with any
      // entry in an active/running state, use it as an additional busy signal.
      // This is inherently global (same backend), but its presence here tells us
      // the Antigravity engine considers something active right now.
      const agentState = diag.agentStateDebug as Record<string, unknown> | undefined;
      if (agentState && typeof agentState === 'object') {
        const convMap = agentState.conversations as Record<string, unknown> | undefined;
        if (convMap && typeof convMap === 'object') {
          const activeConversations = Object.values(convMap).filter(
            (v: unknown) => v && typeof v === 'object' && (
              (v as any).status === 'running' ||
              (v as any).status === 'active' ||
              (v as any).isActive === true
            )
          );
          if (activeConversations.length > 0 && this._everSeenBusy) {
            if (level === 'verbose') {
              this._log(`  [diag:conversations] ${activeConversations.length} active conversation(s) found — boosting diagBusy/diagRecent`);
            }
            diagBusy = true;
            diagRecent = true;
          } else if (level === 'verbose' && Object.keys(convMap).length > 0) {
            this._log(`  [diag:conversations] ${Object.keys(convMap).length} conversation(s) present, none active`);
          }
        }
      }

      return { hasError: false, isBusy: diagBusy, isRecent: diagRecent };
    } catch (e: any) {
      this._log(`  [diag] getDiagnostics call failed: ${e.message ?? 'unknown'}`);
      return { hasError: false, isBusy: false, isRecent: false };
    }
  }

  // ─── Diagnostic Capture ─────────────────────────────────────────────

  /**
   * Capture the full diagnostics payload to a timestamped file.
   *
   * Called when an error is first detected in a cycle. The captured file
   * contains the raw JSON from `antigravity.getDiagnostics`, which lets
   * us inspect what a 503 actually looks like in the logs — enabling us
   * to build precise error patterns for future detection.
   *
   * Files are written to the workspace root under `.helm-diag/`.
   */
  private async _captureDiagnostics(label: string): Promise<void> {
    try {
      const raw = await vscode.commands.executeCommand<unknown>('antigravity.getDiagnostics');
      if (!raw) {
        this._log('  [capture] getDiagnostics returned empty — nothing to capture');
        return;
      }

      // Find workspace root
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        this._log('  [capture] No workspace folder — cannot save capture');
        return;
      }

      const diagDir = path.join(workspaceRoot, '.helm-diag');
      if (!fs.existsSync(diagDir)) {
        fs.mkdirSync(diagDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `diag_${label}_${timestamp}.json`;
      const filePath = path.join(diagDir, filename);

      // Write as pretty-printed JSON — handle both string and object payloads
      let content: string;
      if (typeof raw === 'string') {
        try {
          content = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          content = raw; // Malformed JSON — write raw string
        }
      } else {
        content = JSON.stringify(raw, null, 2);
      }
      fs.writeFileSync(filePath, content, 'utf-8');

      const sizeKB = Math.round(fs.statSync(filePath).size / 1024);
      this._logAt('normal', `  [capture] ★ Diagnostics captured: ${filename} (${sizeKB}KB)`);
      this._logAt('verbose', `  [capture]   Path: ${filePath}`);
    } catch (e: any) {
      this._log(`  [capture] Failed to capture diagnostics: ${e.message ?? 'unknown'}`);
    }
  }

  // ─── Chat Dispatch ───────────────────────────────────────────────────

  /**
   * Send a message to the AI chat panel.
   *
   * Strategy chain:
   *   1. antigravity.sendPromptToAgentPanel — Antigravity's native API
   *   2. workbench.action.chat.open with query — standard VS Code Chat
   *   3. Clipboard fallback — copies prompt, opens chat, shows warning
   */
  private async _sendToChatPanel(prompt: string): Promise<void> {
    // Strategy 1: Antigravity native API
    try {
      await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
      this._logAt('normal', '  → Sent via antigravity.sendPromptToAgentPanel');
      return;
    } catch {
      // Not available — fall through
    }

    // Strategy 2: VS Code standard chat API
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
        isPartialQuery: false,
      });
      this._logAt('normal', '  → Sent via workbench.action.chat.open');
      return;
    } catch {
      // Not available — fall through
    }

    // Strategy 3: Clipboard fallback
    await vscode.env.clipboard.writeText(prompt);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open');
    } catch {
      try {
        await vscode.commands.executeCommand('antigravity.openChatView');
      } catch { /* ignore */ }
    }
    this._logAt('normal', '  → Clipboard fallback — prompt copied');
    vscode.window.showWarningMessage(
      'Antigravity Recovery Auto Continue: Prompt copied to clipboard — paste (Ctrl+V) in the chat.',
      'Dismiss'
    );
  }

  // ─── Settings Webview ───────────────────────────────────────────────

  private _getSettingsHtml(logoUri: vscode.Uri): string {
    const config = vscode.workspace.getConfiguration('helmAutoContinue');
    const extensionVersion: string = (this._context.extension.packageJSON as { version?: string }).version ?? '?';
    const settings = {
      intervalSeconds: config.get<number>('intervalSeconds', 5),
      idleTimeoutSeconds: config.get<number>('idleTimeoutSeconds', 0),
      startOnActivation: config.get<boolean>('startOnActivation', true),
      focusProbe: config.get<boolean>('focusProbe', false),
      continuePrompt: config.get<string>('continuePrompt', 'Continue'),
      diagnosticsFrequency: config.get<number>('diagnosticsFrequency', 1),
      postSendCooldownMs: config.get<number>('postSendCooldownMs', 10000),
      logLevel: config.get<string>('logLevel', 'minimal'),
      windowScopeRecovery: config.get<boolean>('windowScopeRecovery', true),
      recoveryTimeoutSeconds: config.get<number>('recoveryTimeoutSeconds', 300),
      errorPatterns: config.get<string[]>('errorPatterns', DEFAULT_ERROR_PATTERNS),
      suppressPatterns: config.get<string[]>('suppressPatterns', DEFAULT_SUPPRESS_PATTERNS),
      cdpAutoClick: config.get<boolean>('cdpAutoClick', false),
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Antigravity Recovery Auto Continue Settings</title>
<style>
  :root {
    --bg: #1e1e1e;
    --surface: #252526;
    --surface-hover: #2a2d2e;
    --border: #3c3c3c;
    --text: #cccccc;
    --text-muted: #888888;
    --text-bright: #e0e0e0;
    --accent: #0078d4;
    --accent-hover: #1a8fe8;
    --accent-dim: rgba(0, 120, 212, 0.15);
    --danger: #f14c4c;
    --success: #4ec9b0;
    --input-bg: #3c3c3c;
    --input-border: #555555;
    --radius: 6px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    padding: 24px;
    line-height: 1.5;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  .header h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-bright);
    letter-spacing: -0.3px;
  }

  .header .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .promo {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    margin: 16px 0 24px;
    background: var(--accent-dim);
    border: 1px solid rgba(0, 120, 212, 0.3);
    border-radius: var(--radius);
    font-size: 12px;
    color: var(--accent-hover);
  }

  .promo a {
    color: var(--accent-hover);
    text-decoration: none;
    font-weight: 600;
  }

  .promo a:hover { text-decoration: underline; }

  .section {
    margin-bottom: 28px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
    margin-bottom: 12px;
  }

  .setting {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 14px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
    transition: border-color 0.15s;
  }

  .setting:hover {
    border-color: var(--input-border);
  }

  .setting-info { flex: 1; margin-right: 20px; }

  .setting-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-bright);
    margin-bottom: 3px;
  }

  .setting-desc {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .setting-control {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding-top: 2px;
  }

  /* Toggle switch */
  .toggle {
    position: relative;
    width: 40px;
    height: 22px;
    cursor: pointer;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle .slider {
    position: absolute;
    inset: 0;
    background: var(--input-bg);
    border-radius: 11px;
    transition: background 0.2s;
  }

  .toggle .slider::before {
    content: '';
    position: absolute;
    width: 16px;
    height: 16px;
    left: 3px;
    bottom: 3px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: transform 0.2s, background 0.2s;
  }

  .toggle input:checked + .slider {
    background: var(--accent);
  }

  .toggle input:checked + .slider::before {
    transform: translateX(18px);
    background: #fff;
  }

  /* Number input */
  .num-input {
    width: 80px;
    padding: 5px 8px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    color: var(--text-bright);
    font-size: 13px;
    text-align: center;
    outline: none;
    transition: border-color 0.15s;
  }

  .num-input:focus {
    border-color: var(--accent);
  }

  /* Text input */
  .text-input {
    width: 160px;
    padding: 5px 10px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    color: var(--text-bright);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }

  .text-input:focus {
    border-color: var(--accent);
  }

  /* Select dropdown */
  .select {
    padding: 5px 28px 5px 10px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    color: var(--text-bright);
    font-size: 13px;
    outline: none;
    appearance: none;
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    transition: border-color 0.15s;
  }

  .select:focus {
    border-color: var(--accent);
  }

  .saved-toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: var(--success);
    color: #1e1e1e;
    padding: 8px 16px;
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 600;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
  }

  .saved-toast.show {
    opacity: 1;
    transform: translateY(0);
  }
  .monitor-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    margin-bottom: 24px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color 0.2s;
  }

  .monitor-card.active {
    border-color: var(--success);
    background: rgba(78, 201, 176, 0.06);
  }

  .monitor-info {
    display: flex;
    flex-direction: column;
  }

  .monitor-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-bright);
  }

  .monitor-status {
    font-size: 12px;
    margin-top: 2px;
  }

  .monitor-status.on {
    color: var(--success);
  }

  .monitor-status.off {
    color: var(--text-muted);
  }

  .pattern-input {
    width: 100%;
    min-height: 120px;
    padding: 10px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    color: var(--text-bright);
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.6;
    resize: vertical;
    outline: none;
    transition: border-color 0.15s;
  }

  .pattern-input:focus {
    border-color: var(--accent);
  }
</style>
</head>
<body>
  <div class="header">
    <img src="${logoUri}" alt="Antigravity" width="28" height="28" style="flex-shrink: 0;">
    <h1>Antigravity Recovery Auto Continue</h1>
    <span class="badge">v${extensionVersion}</span>
  </div>

  <div class="monitor-card ${this._running ? 'active' : ''}" id="monitorCard">
    <div class="monitor-info">
      <div class="monitor-label">Monitoring</div>
      <div class="monitor-status ${this._running ? 'on' : 'off'}" id="monitorStatus">
        ${this._running ? '● Active — watching for errors' : '○ Stopped'}
      </div>
    </div>
    <label class="toggle">
      <input type="checkbox" id="monitorToggle" ${this._running ? 'checked' : ''}>
      <span class="slider"></span>
    </label>
  </div>

  <!-- ─── CDP Auto Clicker ──────────────────────────────────────────────── -->

  <div class="monitor-card ${settings.cdpAutoClick ? 'active' : ''}" id="cdpCard">
    <div class="monitor-info">
      <div class="monitor-label">CDP Auto Clicker</div>
      <div class="monitor-status ${settings.cdpAutoClick ? 'on' : 'off'}" id="cdpStatus">
        ${settings.cdpAutoClick ? '● Active — clicking buttons' : '○ Stopped'}
      </div>
    </div>
    <label class="toggle">
      <input type="checkbox" id="cdpToggle" ${settings.cdpAutoClick ? 'checked' : ''}>
      <span class="slider"></span>
    </label>
  </div>

  <div id="cdpDetails" style="display:${settings.cdpAutoClick ? 'block' : 'none'}; margin-bottom:16px;">
    <div class="setting" style="flex-direction:column; align-items:stretch; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-size:12px; color:var(--text-muted);">Debug Port Status</span>
        <span id="cdpPortBadge" style="font-size:11px; font-weight:600; padding:2px 8px; border-radius:10px; background:rgba(244,107,65,.15); color:#f47041;">Antigravity not detected</span>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:12px; color:var(--text-muted);">Session Clicks</span>
        <span id="cdpClickCount" style="font-size:14px; font-weight:700; color:var(--text-bright);">0</span>
      </div>
    </div>

    <div style="padding:12px 16px; background:rgba(0,120,212,0.07); border:1px solid rgba(0,120,212,0.25);
      border-radius:6px; margin-bottom:8px; font-size:12px; line-height:1.6; color:var(--text-muted);">
      <div style="font-weight:600; color:var(--accent); margin-bottom:6px;">⚙ One-time setup required</div>
      <div>
        Antigravity must be launched with the Chrome DevTools debug port open so that Auto Clicker can inject into its webviews.
      </div>
      <div style="margin-top:8px; font-weight:500; color:var(--text-bright);">Add this flag to your Antigravity shortcut / launch command:</div>
      <div style="font-family:'Consolas','Monaco',monospace; font-size:11px; background:#1a1a1a; border:1px solid var(--border);
        border-radius:4px; padding:6px 10px; margin-top:6px; word-break:break-all; color:#4ec9b0; user-select:all;">
        --remote-debugging-port=9333
      </div>
      <div style="margin-top:8px;">
        <strong style="color:var(--text-bright);">Windows shortcut:</strong>
        Right-click your Antigravity shortcut → Properties → Target field →
        append <code style="background:#222; padding:1px 4px; border-radius:3px;">--remote-debugging-port=9333</code>
        after the closing <code style="background:#222; padding:1px 4px; border-radius:3px;">"</code>, then click OK.
        Relaunch Antigravity from the shortcut.
      </div>
      <div style="margin-top:6px;">
        <strong style="color:var(--text-bright);">macOS / Linux terminal:</strong>
        Close Antigravity, then launch from Terminal:
        <code style="background:#222; padding:1px 4px; border-radius:3px;">"path/to/Antigravity IDE" --remote-debugging-port=9333</code>
      </div>
      <div style="margin-top:6px; color:#888; font-size:11px;">
        The status badge above will show "Connected" once Antigravity is running with the debug port open.
        You only need to do this once if you save the modified shortcut.
      </div>
    </div>

    <div style="padding:10px 14px; background:var(--surface); border:1px solid var(--border);
      border-radius:6px; font-size:11px; color:var(--text-muted); line-height:1.6;">
      <div style="font-weight:600; color:var(--text-bright); margin-bottom:4px;">Buttons clicked automatically:</div>
      Run · Accept · Accept All · Allow · Always Allow · Apply · Approve · Retry · Continue · Confirm
    </div>
  </div>

  <!-- ─────────────────────────────────────────────────────────────────── -->

  <div class="section">
    <div class="section-title">Core</div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Poll Interval</div>
        <div class="setting-desc">How often to check for chat API errors (seconds).</div>
      </div>
      <div class="setting-control">
        <input type="number" class="num-input" id="intervalSeconds" min="3" value="${settings.intervalSeconds}">
      </div>
    </div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Continue Prompt</div>
        <div class="setting-desc">The message sent to resume the AI agent after an error.</div>
      </div>
      <div class="setting-control">
        <input type="text" class="text-input" id="continuePrompt" value="${settings.continuePrompt}">
      </div>
    </div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Auto Start</div>
        <div class="setting-desc">Start monitoring automatically when VS Code opens.</div>
      </div>
      <div class="setting-control">
        <label class="toggle">
          <input type="checkbox" id="startOnActivation" ${settings.startOnActivation ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Window Scope Recovery</div>
        <div class="setting-desc">Only fire Continue if this window's agent was recently active. Prevents cross-window false positives when multiple VS Code windows are open.</div>
      </div>
      <div class="setting-control">
        <label class="toggle">
          <input type="checkbox" id="windowScopeRecovery" ${settings.windowScopeRecovery ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Timing</div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Post-Send Cooldown</div>
        <div class="setting-desc">Wait time (ms) after agent goes idle before sending Continue. Prevents premature retries.</div>
      </div>
      <div class="setting-control">
        <input type="number" class="num-input" id="postSendCooldownMs" min="0" step="1000" value="${settings.postSendCooldownMs}">
      </div>
    </div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Stall Detection</div>
        <div class="setting-desc">If the agent's step index hasn't advanced in this many seconds, assume it silently stopped and send Continue. Useful for catching failures that don't log an error. Set to roughly how long your longest tool call takes. 0 = disabled.</div>
      </div>
      <div class="setting-control">
        <input type="number" class="num-input" id="idleTimeoutSeconds" min="0" value="${settings.idleTimeoutSeconds}">
      </div>
    </div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Recovery Timeout</div>
        <div class="setting-desc">Don't fire Continue if the agent has been idle longer than this (seconds). Prevents stale errors from triggering recovery in inactive windows. 0 = disabled.</div>
      </div>
      <div class="setting-control">
        <input type="number" class="num-input" id="recoveryTimeoutSeconds" min="0" value="${settings.recoveryTimeoutSeconds}">
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Detection</div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Diagnostics Frequency</div>
        <div class="setting-desc">Run log parsing every Nth poll. Lower = faster detection, higher = less overhead.</div>
      </div>
      <div class="setting-control">
        <input type="number" class="num-input" id="diagnosticsFrequency" min="1" max="20" value="${settings.diagnosticsFrequency}">
      </div>
    </div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Focus Probe</div>
        <div class="setting-desc">Briefly focus chat panel to read error keys. Causes flickering — off by default.</div>
      </div>
      <div class="setting-control">
        <label class="toggle">
          <input type="checkbox" id="focusProbe" ${settings.focusProbe ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Patterns</div>

    <div class="setting" style="flex-direction: column; align-items: stretch;">
      <div class="setting-info" style="margin-bottom: 8px;">
        <div class="setting-label">Error Patterns (trigger Continue)</div>
        <div class="setting-desc">Regex patterns (case-insensitive). One per line. When matched in new log entries, triggers auto-continue.</div>
      </div>
      <textarea class="pattern-input" id="errorPatterns">${settings.errorPatterns.join('\n')}</textarea>
    </div>

    <div class="setting" style="flex-direction: column; align-items: stretch;">
      <div class="setting-info" style="margin-bottom: 8px;">
        <div class="setting-label">Suppress Patterns (stop monitoring)</div>
        <div class="setting-desc">Regex patterns (case-insensitive). One per line. Non-retryable errors — stops monitoring entirely when matched.</div>
      </div>
      <textarea class="pattern-input" id="suppressPatterns">${settings.suppressPatterns.join('\n')}</textarea>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Logging</div>

    <div class="setting">
      <div class="setting-info">
        <div class="setting-label">Log Level</div>
        <div class="setting-desc">Controls output channel verbosity. Normal is silent during healthy polls.</div>
      </div>
      <div class="setting-control">
        <select class="select" id="logLevel">
          <option value="minimal" ${settings.logLevel === 'minimal' ? 'selected' : ''}>Minimal</option>
          <option value="normal" ${settings.logLevel === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="verbose" ${settings.logLevel === 'verbose' ? 'selected' : ''}>Verbose</option>
        </select>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Developer Tools</div>

    <div class="setting" style="flex-direction: column; align-items: stretch; gap: 12px;">
      <div class="setting-desc" style="line-height: 1.5; color: var(--text-muted); margin-bottom: 4px;">
        To run a test, open the VS Code Command Palette using <kbd style="
          background: #333;
          padding: 2px 5px;
          border-radius: 3px;
          font-family: inherit;
          font-size: 0.9em;
          color: var(--text-bright);
        ">Ctrl+Shift+P</kbd> (or <kbd style="
          background: #333;
          padding: 2px 5px;
          border-radius: 3px;
          font-family: inherit;
          font-size: 0.9em;
          color: var(--text-bright);
        ">Cmd+Shift+P</kbd> on macOS) and run one of the following commands:
      </div>
      <div style="font-size: 12px; line-height: 1.6; display: flex; flex-direction: column; gap: 8px; color: var(--text-bright); margin-bottom: 4px;">
        <div>● <strong>Antigravity Recovery Auto Continue: Run Full Test</strong><br>
        <span style="color: var(--text-muted); font-size: 11px; margin-left: 14px; display: inline-block;">Runs the complete test pipeline (auto-starts monitoring, marks window active, queues synthetic error) and traces it below.</span></div>
        <div>● <strong>Antigravity Recovery Auto Continue: Simulate Error (Test)</strong><br>
        <span style="color: var(--text-muted); font-size: 11px; margin-left: 14px; display: inline-block;">Queues a synthetic "503 error" to fire on the next diagnostics poll.</span></div>
        <div>● <strong>Antigravity Recovery Auto Continue: Mark Window Active (Test)</strong><br>
        <span style="color: var(--text-muted); font-size: 11px; margin-left: 14px; display: inline-block;">Bypasses window scope recovery by marking this window as active.</span></div>
      </div>
      <div id="testConsole" style="
        min-height: 80px;
        max-height: 240px;
        overflow-y: auto;
        padding: 10px 12px;
        background: #1a1a1a;
        border: 1px solid var(--border);
        border-radius: 4px;
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        font-size: 11px;
        line-height: 1.7;
        color: var(--text-muted);
        white-space: pre-wrap;
        word-break: break-all;
      "><span style="color: var(--text-muted);">Use the Command Palette to run a test and view logs here...</span></div>
    </div>
  </div>

  <div class="saved-toast" id="toast">✓ Saved</div>

  <script>
    const vscode = acquireVsCodeApi();

    function save(key, value) {
      vscode.postMessage({ type: 'updateSetting', key, value });
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 1200);
    }

    // Monitoring toggle (special — not a setting, controls start/stop)
    const monitorToggle = document.getElementById('monitorToggle');
    monitorToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'toggleMonitoring' });
    });

    // Note: click listeners and flashBtn helper are removed as Developer Tools commands are run via the Command Palette

    // Test console log rendering
    const testConsole = document.getElementById('testConsole');
    const LOG_COLORS = {
      info: 'var(--accent-hover)',
      ok: 'var(--success)',
      warn: '#e5c07b',
      error: 'var(--danger)',
    };

    function appendTestLog(level, message, ts) {
      if (level === 'clear') {
        testConsole.innerHTML = '';
        return;
      }
      const line = document.createElement('div');
      line.style.color = LOG_COLORS[level] || 'var(--text-muted)';
      line.textContent = '[' + ts + '] ' + message;
      testConsole.appendChild(line);
      testConsole.scrollTop = testConsole.scrollHeight;
    }

    // CDP Auto Clicker toggle
    const cdpToggle    = document.getElementById('cdpToggle');
    const cdpCard      = document.getElementById('cdpCard');
    const cdpStatusEl  = document.getElementById('cdpStatus');
    const cdpDetails   = document.getElementById('cdpDetails');
    const cdpPortBadge = document.getElementById('cdpPortBadge');
    const cdpClickCount = document.getElementById('cdpClickCount');

    cdpToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'toggleCdp' });
    });

    // Listen for state pushes from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'runningState') {
        const card = document.getElementById('monitorCard');
        const status = document.getElementById('monitorStatus');
        monitorToggle.checked = msg.running;
        if (msg.running) {
          card.classList.add('active');
          status.className = 'monitor-status on';
          status.textContent = '● Active — watching for errors';
        } else {
          card.classList.remove('active');
          status.className = 'monitor-status off';
          status.textContent = '○ Stopped';
        }
      } else if (msg.type === 'testLog') {
        appendTestLog(msg.level, msg.message, msg.ts);
      } else if (msg.type === 'cdpStatus') {
        // Update CDP toggle card
        cdpToggle.checked = msg.enabled;
        cdpDetails.style.display = msg.enabled ? 'block' : 'none';
        if (msg.enabled) {
          cdpCard.classList.add('active');
          cdpStatusEl.className = 'monitor-status on';
          cdpStatusEl.textContent = '● Active — clicking buttons';
        } else {
          cdpCard.classList.remove('active');
          cdpStatusEl.className = 'monitor-status off';
          cdpStatusEl.textContent = '○ Stopped';
        }
        // Update port status badge
        if (msg.connected) {
          cdpPortBadge.textContent = '✓ Connected';
          cdpPortBadge.style.background = 'rgba(78,201,176,.12)';
          cdpPortBadge.style.color = '#4ec9b0';
        } else if (msg.agRunning) {
          cdpPortBadge.textContent = '⚠ AG running — no debug port';
          cdpPortBadge.style.background = 'rgba(229,192,123,.12)';
          cdpPortBadge.style.color = '#e5c07b';
        } else {
          cdpPortBadge.textContent = 'Antigravity not detected';
          cdpPortBadge.style.background = 'rgba(244,107,65,.15)';
          cdpPortBadge.style.color = '#f47041';
        }
        // Update session click counter
        cdpClickCount.textContent = String(msg.sessionClicks ?? 0);
      }
    });

    // Number inputs
    document.querySelectorAll('.num-input').forEach(el => {
      el.addEventListener('change', () => {
        save(el.id, Number(el.value));
      });
    });

    // Text inputs
    document.querySelectorAll('.text-input').forEach(el => {
      let timer;
      el.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => save(el.id, el.value), 500);
      });
    });

    // Toggles (settings only — exclude monitor toggle)
    document.querySelectorAll('.toggle input:not(#monitorToggle)').forEach(el => {
      el.addEventListener('change', () => {
        save(el.id, el.checked);
      });
    });

    // Selects
    document.querySelectorAll('.select').forEach(el => {
      el.addEventListener('change', () => {
        save(el.id, el.value);
      });
    });

    // Pattern textareas
    document.querySelectorAll('.pattern-input').forEach(el => {
      let timer;
      el.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const lines = el.value.split('\n').filter(l => l.trim().length > 0);
          save(el.id, lines);
        }, 800);
      });
    });
  </script>
</body>
</html>`;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private _getConfig<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration('helmAutoContinue').get<T>(key, defaultValue);
  }

  private _getLogLevel(): LogLevel {
    return this._getConfig<LogLevel>('logLevel', 'minimal');
  }

  /**
   * Compile an array of pattern strings into RegExp objects.
   * Invalid patterns are silently skipped.
   */
  private _compilePatterns(patterns: string[]): RegExp[] {
    return patterns
      .map(p => { try { return new RegExp(p, 'i'); } catch { return null; } })
      .filter((r): r is RegExp => r !== null);
  }

  /**
   * Log unconditionally (events that should always appear).
   */
  private _log(message: string): void {
    const ts = new Date().toLocaleTimeString();
    this._output.appendLine(`[${ts}] ${message}`);
  }

  /**
   * Log only if the current log level is >= the required level.
   * Use 'normal' for state transitions and non-critical info.
   * Use 'verbose' for per-strategy diagnostics.
   * Use _log() directly for events that must always appear.
   */
  private _logAt(minLevel: LogLevel, message: string): void {
    const current = this._getLogLevel();
    if (LOG_LEVEL_ORDER.indexOf(current) >= LOG_LEVEL_ORDER.indexOf(minLevel)) {
      this._log(message);
    }
  }

  private _logStats(): void {
    const uptime = this._stats.startedAt
      ? Math.round((Date.now() - this._stats.startedAt) / 1000)
      : 0;
    this._log('─── Session Stats ───');
    this._log(`  Uptime:     ${this._formatDuration(uptime)}`);
    this._log(`  Polls:      ${this._stats.totalPolls}`);
    this._log(`  Errors:     ${this._stats.errorsDetected}`);
    this._log(`  Continues:  ${this._stats.continuesSent}`);
    this._log('─────────────────────');
  }

  private _formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  private _updateStatusBar(): void {
    if (this._running) {
      if (this._errorState !== 'monitoring') {
        const phase = this._errorState === 'waiting_idle' ? 'waiting' : 'cooldown';
        this._statusBar.text = `$(sync~spin) Auto Continue (${phase})`;
        this._statusBar.tooltip = `Antigravity Recovery Auto Continue — ${phase}. Click for settings.`;
        this._statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        this._statusBar.text = '$(eye) Auto Continue';
        this._statusBar.tooltip = 'Antigravity Recovery Auto Continue is monitoring — click for settings';
        this._statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
      }
    } else {
      this._statusBar.text = '$(eye-closed) Auto Continue';
      this._statusBar.tooltip = 'Antigravity Recovery Auto Continue is off — click for settings';
      this._statusBar.backgroundColor = undefined;
    }
  }

  private _updateDebugBar(): void {
    const { totalPolls, continuesSent, lastState } = this._stats;

    if (!this._running) {
      this._debugBar.text = '$(terminal) Log';
      this._debugBar.tooltip = `Auto Continue Log\n\nPolls: ${totalPolls} | Sent: ${continuesSent}\n\nClick to open output`;
      this._debugBar.backgroundColor = undefined;
    } else {
      this._debugBar.text = `$(terminal) ${lastState}`;
      this._debugBar.tooltip = [
        'Auto Continue Debug',
        '',
        `State:      ${lastState}`,
        `Phase:      ${this._errorState}`,
        `Polls:      ${totalPolls}`,
        `Errors:     ${this._stats.errorsDetected}`,
        `Sent:       ${continuesSent}`,
        `Idle since: ${this._idleSince ? `${Math.round((Date.now() - this._idleSince) / 1000)}s ago` : 'n/a'}`,
        `Busy since: ${this._busyStart ? `${Math.round((Date.now() - this._busyStart) / 1000)}s ago` : 'n/a'}`,
        '',
        'Click to open log',
      ].join('\n');

      if (lastState.startsWith('ERROR') || lastState === 'WAIT_IDLE' || lastState === 'COOLDOWN') {
        this._debugBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else if (lastState === 'BUSY') {
        this._debugBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        this._debugBar.backgroundColor = undefined;
      }
    }
  }
}

// ─── CDP Auto Clicker ──────────────────────────────────────────────────────
//
// Runs an independent Chrome DevTools Protocol DOM-injection clicking loop.
// Every 2 seconds, probes Antigravity's debug ports, injects a MutationObserver
// script into every reachable webview via Runtime.evaluate, and clicks action
// buttons (Run, Accept, Allow, Apply, Approve, Retry, Continue, Confirm) as they
// appear in the Antigravity UI.
//
// Completely separate from the error-recovery monitor — enabled/disabled via its
// own toggle in the settings page, no auth, no quota, no heartbeat.

class CdpAutoClicker {

  // ─── CDP ports to probe in order ──────────────────────────────────────
  private static readonly PORTS = [9333, 9222, 9000, 5229];

  // ─── How often to run the full injection cycle ─────────────────────────
  private static readonly INJECT_MS = 2000;

  // ─── Cross-target deduplication window ────────────────────────────────
  // Covers the worst-case wsEval round-trip across multiple open webview
  // targets (~1-2s each) with a large safety margin.
  private static readonly DEDUP_MS = 8000;

  // ─── OBSERVER_JS ──────────────────────────────────────────────────────
  // Self-contained JavaScript injected into every Antigravity webview via
  // CDP Runtime.evaluate. Runs inside the Electron renderer process.
  //
  // Design notes:
  //   • Uses self.* instead of window.* — works in window and worker scopes.
  //   • Generation counter (__helmGen) allows a newer injection to instantly
  //     terminate any older instance that is still ticking.
  //   • Position-key cooldown survives React DOM re-renders: the key is based
  //     on the button's screen coordinates (quantised to a 30px grid) + label
  //     prefix rather than the DOM element reference, so a fresh element at
  //     the same position is recognised and blocked until it disappears.
  //   • MutationObserver fires a debounced scan on DOM changes; the fallback
  //     setInterval loop catches buttons that appear without triggering mutations.
  //   • Returns JSON so the extension can diff cumulative click counts across
  //     injection cycles without re-counting clicks made by previous cycles.
  private static readonly OBSERVER_JS = `
(function() {
  // Helm CDP Clicker — injected into Antigravity webviews.
  // Each injection bumps the generation so any older loop self-terminates.
  var GEN = (self.__helmGen = (self.__helmGen || 0) + 1);

  // Tear down the previous observer instance if one is running
  if (self.__helmObs) { try { self.__helmObs.disconnect(); } catch(e) {} self.__helmObs = null; }
  clearTimeout(self.__helmDeb);

  // Persistent state (initialised once; survives re-injection)
  if (!self.__helmTs)      self.__helmTs      = new WeakMap(); // el → timestamp of last click
  if (!self.__helmElPos)   self.__helmElPos   = new WeakMap(); // el → posKey stored at click time
  if (!self.__helmBlocked) self.__helmBlocked = {};            // posKey → true (occupied)
  if (!self.__helmLabels)  self.__helmLabels  = [];            // last 5 clicked button labels
  if (!self.__helmCount)   self.__helmCount   = 0;             // cumulative click counter

  var COOL = 1500; // ms to wait before re-clicking the same DOM element

  // Labels that must always be skipped — VS Code merge-editor buttons that
  // share names with our targets and should never be auto-clicked.
  var NEVER = [
    'accept all changes', 'accept current change',
    'accept incoming',    'accept both changes',
    'running', 'runner', 'runtime', 'runbook'
  ];

  function shouldNeverClick(lo) {
    for (var i = 0; i < NEVER.length; i++) {
      if (lo.indexOf(NEVER[i]) >= 0) return true;
    }
    return false;
  }

  // Strip non-printable chars and leading non-alpha chars from element text
  function cleanLabel(raw) {
    return (raw || '')
      .replace(/[^\\x20-\\x7E]+/g, ' ')
      .replace(/\\s+/g, ' ').trim()
      .replace(/^[^a-zA-Z]+/, '').trim();
  }

  // True when the element is visible and has a meaningful size on screen
  function isVisible(el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width  > 0 && r.height > 0
        && s.display !== 'none'
        && s.visibility !== 'hidden'
        && parseFloat(s.opacity) > 0;
  }

  // Position key — label prefix + quantised screen coords.
  // Survives React re-renders that destroy and recreate the DOM element
  // because the new element appears at the same screen location.
  function posKey(el, label) {
    var r = el.getBoundingClientRect();
    return label.slice(0, 20) + ':' + (Math.round(r.left / 30) * 30) + ':' + (Math.round(r.top / 30) * 30);
  }

  // True if this button label is one we should click
  function isClickTarget(lo) {
    var firstWord = lo.split(/[^a-z]/)[0];
    return firstWord === 'run'    ||
           firstWord === 'accept' ||
           firstWord === 'allow'  ||
           firstWord === 'apply'  ||
           firstWord === 'approve'||
           firstWord === 'retry'  ||
           firstWord === 'submit' ||
           lo === 'continue'      ||
           lo === 'confirm'       ||
           lo === 'always allow'  ||
           lo.indexOf('always allow') >= 0;
  }

  // When elements leave the DOM, unblock the positions they occupied.
  // Primary path: use the posKey stored in __helmElPos at click time.
  // Fallback:     scan __helmBlocked for a key matching the label prefix.
  function releaseRemovedPositions(mutations) {
    if (!Object.keys(self.__helmBlocked).length) return;
    mutations.forEach(function(m) {
      m.removedNodes.forEach(function(node) {
        if (node.nodeType !== 1) return;
        var candidates = [node];
        try { [].push.apply(candidates, node.querySelectorAll('button,[role="button"]')); } catch(e) {}
        candidates.forEach(function(el) {
          // Primary: stored posKey
          var pk = self.__helmElPos.get(el);
          if (pk && self.__helmBlocked[pk]) { delete self.__helmBlocked[pk]; return; }
          // Fallback: label prefix scan
          var lbl = cleanLabel(el.textContent);
          var lo  = lbl.toLowerCase();
          if (!lbl || shouldNeverClick(lo) || !isClickTarget(lo)) return;
          var prefix = lbl.slice(0, 20);
          for (var key in self.__helmBlocked) {
            if (key.indexOf(prefix) === 0) { delete self.__helmBlocked[key]; }
          }
        });
      });
    });
  }

  function scanAndClick() {
    var candidates = document.body.querySelectorAll(
      'button, [role="button"], ' +
      '[data-testid*="run"], [data-testid*="accept"], [data-testid*="allow"]'
    );
    var now = Date.now();

    // Remove stale position blocks whose position is no longer occupied by any
    // visible target — catches cases where elements leave without a mutation event.
    var activeKeys = {};
    candidates.forEach(function(el) {
      if (el.disabled || !isVisible(el)) return;
      var lbl = cleanLabel(el.textContent);
      var lo  = lbl.toLowerCase();
      if (shouldNeverClick(lo) || !isClickTarget(lo)) return;
      var r = el.getBoundingClientRect();
      if (r.width <= 20 || r.height <= 10) return;
      activeKeys[posKey(el, lbl)] = true;
    });
    for (var pk in self.__helmBlocked) {
      if (!activeKeys[pk]) delete self.__helmBlocked[pk];
    }

    // Click every eligible element
    candidates.forEach(function(el) {
      if (now - (self.__helmTs.get(el) || 0) < COOL) return; // element still in cooldown
      if (el.disabled || !isVisible(el)) return;
      var lbl = cleanLabel(el.textContent);
      var lo  = lbl.toLowerCase();
      if (shouldNeverClick(lo) || !isClickTarget(lo)) return;
      var r = el.getBoundingClientRect();
      if (r.width <= 20 || r.height <= 10) return;
      var pk = posKey(el, lbl);
      if (self.__helmBlocked[pk]) return; // same screen position still occupied

      // Record and click
      self.__helmTs.set(el, now);
      self.__helmElPos.set(el, pk);
      self.__helmBlocked[pk] = true;
      el.click();
      self.__helmCount++;
      self.__helmLabels.push(lbl);
      if (self.__helmLabels.length > 5) self.__helmLabels.shift();
    });
  }

  // MutationObserver fires a debounced scan on any DOM change
  self.__helmObs = new MutationObserver(function(mutations) {
    releaseRemovedPositions(mutations);
    clearTimeout(self.__helmDeb);
    self.__helmDeb = setTimeout(scanAndClick, 40);
  });
  self.__helmObs.observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class']
  });

  // Fallback polling loop — catches buttons that appear without DOM mutations.
  // Self-terminates when a newer injection bumps __helmGen.
  (function loop(gen) {
    if (self.__helmGen !== gen) return;
    scanAndClick();
    setTimeout(function() { loop(gen); }, 600);
  })(GEN);

  // Immediate scan on injection
  scanAndClick();
  return JSON.stringify({
    gen:    GEN,
    count:  self.__helmCount,
    labels: self.__helmLabels.slice(),
  });
})()`;

  // ─── KILL_JS ─────────────────────────────────────────────────────────
  // Injected into all live targets when the clicker is stopped.
  // Bumping __helmGen causes any active loop() call to self-terminate on
  // its next tick without needing an explicit clearTimeout.
  private static readonly KILL_JS = `(function() {
  self.__helmGen = (self.__helmGen || 0) + 1;
  if (self.__helmObs) { try { self.__helmObs.disconnect(); } catch(e) {} self.__helmObs = null; }
  clearTimeout(self.__helmDeb);
})();`;

  // ─── Instance state ───────────────────────────────────────────────────

  private _timer:          ReturnType<typeof setInterval> | null = null;
  private _enabled         = false;
  private _sessionClicks   = 0;         // Resets on each start()
  private _cdpConnected    = false;     // True when >= 1 port responded
  private _agRunning       = false;     // Last known AG process state
  private _firstProbe      = true;      // Has the first CDP probe completed?
  private _probeCycleCount = 0;         // For throttling _detectAgProcess

  // Per-target click count baseline: webSocketDebuggerUrl → last observed counter
  private readonly _targetCounts: Record<string, number> = {};

  // Cross-target deduplication: label → timestamp last counted
  private readonly _dedup: Map<string, number> = new Map();

  // Reference to the open settings panel (undefined when closed)
  private _settingsPanelRef?: vscode.WebviewPanel;

  // Status bar item: shows $(mouse) AutoClick OFF | $(mouse) AutoClick N
  private _statusBar: vscode.StatusBarItem;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _log: (msg: string) => void,
  ) {
    this._statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left, 95
    );
    this._statusBar.command = 'helmAutoContinue.openSettings';
    this._refreshStatusBar();
    this._statusBar.show();
    _context.subscriptions.push(this._statusBar);
  }

  // ─── Public API ───────────────────────────────────────────────────────

  start(): void {
    if (this._enabled) return;
    this._enabled        = true;
    this._sessionClicks  = 0;
    this._firstProbe     = true;
    this._cdpConnected   = false;
    this._agRunning      = false;
    this._probeCycleCount = 0;
    Object.keys(this._targetCounts).forEach(k => delete this._targetCounts[k]);
    this._dedup.clear();
    this._log('[CDP] Auto Clicker started — probing ports ' + CdpAutoClicker.PORTS.join(', '));
    this._refreshStatusBar();
    void this._runCycle(); // run immediately
    this._timer = setInterval(() => void this._runCycle(), CdpAutoClicker.INJECT_MS);
  }

  stop(): void {
    if (!this._enabled) return;
    this._enabled = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._log('[CDP] Auto Clicker stopped');
    void this._killObservers();
    this._refreshStatusBar();
    this.pushCdpStatus();
  }

  toggle(): void { this._enabled ? this.stop() : this.start(); }

  get isEnabled(): boolean { return this._enabled; }

  setSettingsPanelRef(panel: vscode.WebviewPanel | undefined): void {
    this._settingsPanelRef = panel;
  }

  /** Push current state to the settings panel. Called publicly so AutoContinue
   *  can trigger it immediately when the panel first opens. */
  pushCdpStatus(): void {
    this._settingsPanelRef?.webview.postMessage({
      type:          'cdpStatus',
      enabled:       this._enabled,
      connected:     this._cdpConnected,
      agRunning:     this._agRunning,
      sessionClicks: this._sessionClicks,
    });
  }

  dispose(): void {
    this.stop();
    this._statusBar.dispose();
  }

  // ─── Status bar ───────────────────────────────────────────────────────

  private _refreshStatusBar(): void {
    if (!this._enabled) {
      this._statusBar.text            = '$(mouse) AutoClick: OFF';
      this._statusBar.tooltip         = 'CDP Auto Clicker disabled — click to open settings';
      this._statusBar.backgroundColor = undefined;
      return;
    }
    const portLabel = this._cdpConnected
      ? 'Connected'
      : (this._agRunning ? 'AG running — no debug port' : 'Antigravity not detected');
    this._statusBar.text = `$(mouse) AutoClick ${this._sessionClicks}`;
    this._statusBar.tooltip = [
      'CDP Auto Clicker — ACTIVE',
      `Session clicks: ${this._sessionClicks}`,
      `Port status:    ${portLabel}`,
      '',
      'Antigravity must be launched with --remote-debugging-port=9333',
      'Click to open settings',
    ].join('\n');
    this._statusBar.backgroundColor = this._cdpConnected
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  // ─── Antigravity process detection ────────────────────────────────────
  //
  // Uses platform-native process listing to check whether Antigravity is
  // running at all. Called every 5 cycles (~10s) to avoid slowing down
  // the 2s injection loop with slow subprocess calls.

  private async _detectAgProcess(): Promise<boolean> {
    const run = (cmd: string) => new Promise<string>(resolve =>
      exec(cmd, { timeout: 4000 }, (_err, stdout) => resolve(stdout || ''))
    );
    try {
      if (process.platform === 'win32') {
        const a = await run('tasklist /NH /FI "IMAGENAME eq Antigravity IDE.exe" 2>nul');
        if (/antigravity/i.test(a)) return true;
        const b = await run('tasklist /NH /FI "IMAGENAME eq Antigravity.exe" 2>nul');
        return /antigravity/i.test(b);
      } else {
        // macOS / Linux
        const out = await run(
          'pgrep -f "Antigravity IDE.app/Contents/MacOS/Electron" 2>/dev/null ' +
          '|| pgrep -f "Antigravity.app" 2>/dev/null ' +
          '|| pgrep -f "antigravity" 2>/dev/null | head -1'
        );
        return out.trim().length > 0;
      }
    } catch { return false; }
  }

  // ─── CDP HTTP helpers ─────────────────────────────────────────────────

  /** Fetch a CDP JSON endpoint. Tries 127.0.0.1 before localhost to avoid
   *  Windows IPv6 resolution issues where localhost → ::1 but Antigravity
   *  binds to 127.0.0.1. */
  private _fetchCdp(port: number, path: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const tryHost = (hosts: string[]) => {
        if (!hosts.length) { reject(new Error('unreachable')); return; }
        const [host, ...rest] = hosts;
        const req = http.get(
          `http://${host}:${port}${path}`,
          { timeout: 3000, family: 4 } as http.RequestOptions,
          (res) => {
            let buf = '';
            res.on('data', (c: string) => { buf += c; });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(buf.trim());
                resolve(Array.isArray(parsed) ? parsed : []);
              } catch { tryHost(rest); }
            });
          }
        );
        req.on('error', () => tryHost(rest));
        req.on('timeout', () => { req.destroy(); tryHost(rest); });
      };
      tryHost(['127.0.0.1', 'localhost']);
    });
  }

  private async _getTargets(port: number): Promise<unknown[]> {
    try { return await this._fetchCdp(port, '/json/list'); } catch { /* try /json */ }
    try { return await this._fetchCdp(port, '/json'); } catch { /* nothing */ }
    return [];
  }

  // ─── CDP WebSocket eval ───────────────────────────────────────────────

  /** Evaluate a JavaScript expression in a CDP target via WebSocket.
   *  Resolves with the JSON-stringified return value, or null on any error.
   *  Hard timeout of 5 seconds — suspended pages can hang indefinitely. */
  private _wsEval(wsUrl: string, expression: string): Promise<string | null> {
    return new Promise(resolve => {
      // Try to use the bundled 'ws' package; fall back to the global WebSocket
      // available in the Electron renderer context if 'ws' is not bundled.
      let WS: any;
      try { WS = require('ws'); } catch { WS = null; }
      if (!WS) { try { WS = (globalThis as any).WebSocket; } catch { } }
      if (!WS) { resolve(null); return; }

      let ws: any;
      try { ws = new WS(wsUrl); } catch { resolve(null); return; }

      const done = (val: string | null) => {
        clearTimeout(timeout);
        try { ws.close(); } catch { }
        resolve(val);
      };

      const timeout = setTimeout(() => done(null), 5000);

      const send = () => {
        try {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true },
          }));
        } catch { done(null); }
      };

      const onMessage = (data: any) => {
        try {
          const d = JSON.parse(typeof data === 'string' ? data : data.toString());
          done(d?.result?.result?.value ?? null);
        } catch { done(null); }
      };

      if (typeof ws.on === 'function') {
        // Node ws package API
        ws.on('open',    send);
        ws.on('message', onMessage);
        ws.on('error',   () => done(null));
      } else {
        // Browser-style WebSocket API (Electron renderer)
        ws.onopen    = send;
        ws.onmessage = (e: any) => onMessage(e.data);
        ws.onerror   = () => done(null);
      }
    });
  }

  // ─── Cross-target deduplication ───────────────────────────────────────
  //
  // Problem: OBSERVER_JS is injected into ALL open Antigravity webview
  // targets. When the same button click registers in N targets, the click
  // count delta arrives N times. We deduplicate by label within an 8s window.

  private _dedupeClick(label: string): boolean {
    const now  = Date.now();
    const last = this._dedup.get(label) ?? 0;
    if (now - last < CdpAutoClicker.DEDUP_MS) return false;
    this._dedup.set(label, now);
    // Prune old entries to prevent unbounded growth
    if (this._dedup.size > 50) {
      for (const [k, ts] of this._dedup) {
        if (now - ts > CdpAutoClicker.DEDUP_MS * 3) this._dedup.delete(k);
      }
    }
    return true;
  }

  // ─── Main injection cycle ─────────────────────────────────────────────

  private async _runCycle(): Promise<void> {
    if (!this._enabled) return;

    // Detect whether Antigravity is running (throttled — every 5 cycles / ~10s)
    this._probeCycleCount++;
    if (this._probeCycleCount % 5 === 1) {
      this._agRunning = await this._detectAgProcess();
    }

    let anyPortFound = false;

    for (const port of CdpAutoClicker.PORTS) {
      const targets = await this._getTargets(port);
      const viable  = (targets as any[]).filter(t => t?.webSocketDebuggerUrl);
      if (!viable.length) continue;

      anyPortFound = true;
      if (!this._cdpConnected) {
        this._cdpConnected = true;
        this._log(`[CDP] ✓ Connected on port ${port} — ${viable.length} target(s)`);
        this._refreshStatusBar();
        this.pushCdpStatus();
      }

      for (const target of viable) {
        try {
          const raw = await this._wsEval(target.webSocketDebuggerUrl, CdpAutoClicker.OBSERVER_JS);
          if (!raw) continue;

          let parsed: { gen: number; count: number; labels: string[] };
          try { parsed = JSON.parse(raw); } catch { continue; }

          const key   = target.webSocketDebuggerUrl;
          const prev  = this._targetCounts[key] ?? 0;
          const total = parsed.count ?? 0;

          if (total > prev) {
            const delta  = total - prev;
            this._targetCounts[key] = total;

            // Deduplicate across targets by label within the 8s window
            const recentLabels = (parsed.labels ?? []).slice(-Math.min(delta, 10));
            let effective = 0;
            if (recentLabels.length > 0) {
              for (const label of recentLabels) {
                if (this._dedupeClick(label)) effective++;
              }
            } else if (this._dedupeClick('__unlabeled__')) {
              effective = delta;
            }

            if (effective > 0) {
              this._sessionClicks += effective;
              this._log(`[CDP] 🎯 ${effective}× click in "${target.title ?? 'webview'}" (port ${port})`);
              this._refreshStatusBar();
              this.pushCdpStatus();
            }
          }
        } catch { /* individual target failures are normal */ }
      }
    }

    // Track first-probe completion and connection-state changes
    if (this._firstProbe || anyPortFound !== this._cdpConnected) {
      this._firstProbe   = false;
      this._cdpConnected = anyPortFound;
      this._refreshStatusBar();
      this.pushCdpStatus();
    }
  }

  // ─── Observer teardown ────────────────────────────────────────────────

  /** Inject KILL_JS into all reachable targets — stops all running observers. */
  private async _killObservers(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 500));
      for (const port of CdpAutoClicker.PORTS) {
        const targets = await this._getTargets(port);
        for (const t of targets as any[]) {
          if (!t?.webSocketDebuggerUrl) continue;
          try { await this._wsEval(t.webSocketDebuggerUrl, CdpAutoClicker.KILL_JS); } catch { }
        }
      }
    }
    this._log('[CDP] Kill script sent to all targets');
  }
}

// ─── Extension Lifecycle ───────────────────────────────────────────────────

let autoContinue: AutoContinue | undefined;

export function activate(context: vscode.ExtensionContext) {
  autoContinue = new AutoContinue(context);

  context.subscriptions.push(
    { dispose: () => autoContinue?.dispose() },
    vscode.commands.registerCommand('helmAutoContinue.toggle', () => autoContinue?.toggle()),
    vscode.commands.registerCommand('helmAutoContinue.start', () => autoContinue?.start()),
    vscode.commands.registerCommand('helmAutoContinue.stop', () => autoContinue?.stop()),
    vscode.commands.registerCommand('helmAutoContinue.showLog', () => autoContinue?.showLog()),
    vscode.commands.registerCommand('helmAutoContinue.reportError', () => autoContinue?.reportError()),
    vscode.commands.registerCommand('helmAutoContinue.simulateError', () => autoContinue?.simulateError()),
    vscode.commands.registerCommand('helmAutoContinue.markWindowActive', () => autoContinue?.markWindowActive()),
    vscode.commands.registerCommand('helmAutoContinue.runFullTest', () => autoContinue?.runFullTest()),
    vscode.commands.registerCommand('helmAutoContinue.openSettings', () => autoContinue?.openSettings()),
  );
}

export function deactivate() {
  autoContinue?.dispose();
  autoContinue = undefined;
}

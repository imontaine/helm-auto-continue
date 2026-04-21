import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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
  isBusy: boolean;
  source?: string;
}

// Error patterns to match in diagnostics logs
const DIAG_ERROR_PATTERNS = [
  /\b503\b/i,
  /rate.?limit/i,
  /capacity.?exhaust/i,
  /model.?capacity/i,
  /overloaded/i,
  /too.?many.?requests/i,
  /service.?unavailable/i,
  /quota.?exceeded/i,
  /temporarily.?unavailable/i,
  /RESOURCE_EXHAUSTED/i,
  /server.?error/i,
  /internal.?server.?error/i,
  /high.?traffic/i,
  /try.?again.?in/i,
  /please.?try.?again/i,
  /experiencing.?high/i,
  /No capacity available/i,
  /MODEL_CAPACITY_EXHAUSTED/,
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

  /** Whether context keys are available (null = unknown) */
  private _contextKeysAvailable: boolean | null = null;

  // ─── Diagnostics-based Detection (Strategy 0) ─────────────────────────

  /** Whether antigravity.getDiagnostics is available */
  private _diagnosticsAvailable: boolean | null = null;

  /** Tracked state per log source for detecting new entries.
   *  Stores both length and tail fingerprint to handle fixed-size
   *  circular buffers where old entries drop and length stays constant. */
  private _lastLogState: Record<string, { length: number; lastEntry: string }> = {};

  /** Last known step index for the active conversation */
  private _lastKnownStepIndex: number | null = null;

  /** Timestamp when step index last changed */
  private _stepIndexLastChanged: number | null = null;

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

  // ────────────────────────────────────────────────────────────────────────

  /** Session statistics */
  private _stats: SessionStats = {
    totalPolls: 0,
    errorsDetected: 0,
    continuesSent: 0,
    lastState: 'idle',
    startedAt: null,
  };

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._output = vscode.window.createOutputChannel('Helm Auto Continue');
    _context.subscriptions.push(this._output);

    // Main status bar button (toggle on/off)
    this._statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this._statusBar.command = 'helmAutoContinue.toggle';
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

    // Auto-start if configured
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
    this._monitoringStartedAt = Date.now();
    this._lastLogState = {};
    this._lastKnownStepIndex = null;
    this._stepIndexLastChanged = null;
    this._diagPollCounter = 0;
    this._capturedThisCycle = false;
    this._stats.startedAt = Date.now();
    this._updateStatusBar();
    this._updateDebugBar();

    // Set cross-extension context key
    void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isActive', true);

    this._startTimer();

    const intervalSec = this._getConfig<number>('intervalSeconds', 5);
    this._log(`Started (polling every ${intervalSec}s)`);
    vscode.window.showInformationMessage(
      `Helm Auto Continue started (checking every ${intervalSec}s)`
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
    this._capturedThisCycle = false;
    this._updateStatusBar();
    this._updateDebugBar();

    // Clear cross-extension context keys
    void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isActive', false);
    void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isRetrying', false);

    this._log('Stopped');
    this._logStats();
    vscode.window.showInformationMessage('Helm Auto Continue stopped');
  }

  toggle(): void {
    this._running ? this.stop() : this.start();
  }

  showLog(): void {
    this._output.appendLine('');
    this._output.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this._output.appendLine('  🔗  helm-agent.com — Full AI task management for VS Code');
    this._output.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this._output.appendLine('');
    this._output.show(true);
  }

  openSettings(): void {
    if (this._settingsPanel) {
      this._settingsPanel.reveal();
      return;
    }

    this._settingsPanel = vscode.window.createWebviewPanel(
      'helmAutoContinueSettings',
      'Helm Auto Continue — Settings',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this._settingsPanel.webview.html = this._getSettingsHtml();

    // Handle messages from the webview
    this._settingsPanel.webview.onDidReceiveMessage(
      (msg: { type: string; key: string; value: unknown }) => {
        if (msg.type === 'updateSetting') {
          const config = vscode.workspace.getConfiguration('helmAutoContinue');
          void config.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        }
      },
      undefined,
      this._context.subscriptions
    );

    this._settingsPanel.onDidDispose(() => {
      this._settingsPanel = undefined;
    });
  }

  /**
   * Manually report a chat error.
   */
  reportError(): void {
    this._manualErrorFlag = true;
    this._log('⚠ Manual error reported — will send Continue on next tick');
    vscode.window.showInformationMessage(
      'Helm Auto Continue: Error reported — will retry automatically.'
    );

    if (!this._running) {
      this.start();
    }
  }

  dispose(): void {
    this.stop();
    this._settingsPanel?.dispose();
    this._statusBar.dispose();
    this._debugBar.dispose();
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

        // Capture diagnostics once per error cycle
        if (!this._capturedThisCycle) {
          this._capturedThisCycle = true;
          void this._captureDiagnostics('error');
        }

        if (isBusy) {
          this._errorState = 'waiting_idle';
          this._log('  Agent is busy — waiting for idle before cooldown');
        } else {
          this._errorState = 'cooldown';
          this._cooldownStartedAt = Date.now();
          const cooldownMs = this._getConfig<number>('postSendCooldownMs', 15000);
          this._log(`  Agent is idle — starting ${Math.round(cooldownMs / 1000)}s cooldown`);
        }

        void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isRetrying', true);
        this._updateStatusBar();
        this._updateDebugBar();
        break;
      }

      // ─── WAITING_IDLE: error detected, agent busy, waiting for !busy ─
      case 'waiting_idle': {
        if (!isBusy) {
          this._errorState = 'cooldown';
          this._cooldownStartedAt = Date.now();
          const cooldownMs = this._getConfig<number>('postSendCooldownMs', 15000);
          this._log(`  Agent went idle — starting ${Math.round(cooldownMs / 1000)}s cooldown`);
          this._updateDebugBar();
        } else {
          this._logAt('normal', '  Still busy — waiting for idle...');
        }
        break;
      }

      // ─── COOLDOWN: agent idle, waiting timer before sending Continue ──
      case 'cooldown': {
        const cooldownMs = this._getConfig<number>('postSendCooldownMs', 15000);
        const elapsed = Date.now() - this._cooldownStartedAt;

        if (elapsed >= cooldownMs) {
          // Cooldown complete — send Continue
          const prompt = this._getConfig<string>('continuePrompt', 'Continue');
          this._stats.continuesSent++;
          this._manualErrorFlag = false;

          this._log(`↻ Sending "${prompt}" (total sends: ${this._stats.continuesSent})`);

          // Reset state for next cycle
          this._errorState = 'monitoring';
          this._capturedThisCycle = false;

          // Reset idle tracking so timeout re-arms for next cycle
          this._idleSince = null;
          this._busyStart = null;
          this._lastSeenBusy = false;
          this._stepIndexLastChanged = Date.now();

          this._updateStatusBar();
          this._updateDebugBar();

          await this._sendToChatPanel(prompt);

          void vscode.commands.executeCommand('setContext', 'helmAutoContinue.isRetrying', false);
        } else {
          const remaining = Math.round((cooldownMs - elapsed) / 1000);
          this._logAt('normal', `  ⏳ Cooldown: ${remaining}s remaining`);
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
    const diagFrequency = this._getConfig<number>('diagnosticsFrequency', 1);
    this._diagPollCounter++;
    const diagDue = this._diagnosticsAvailable && this._diagPollCounter >= diagFrequency;
    if (level === 'verbose') {
      this._log(`  [S0:diag] available=${this._diagnosticsAvailable} due=${diagDue} (counter=${this._diagPollCounter}/${diagFrequency})`);
    }
    if (diagDue) {
      this._diagPollCounter = 0;
      const diagResult = await this._checkDiagnostics();
      if (level === 'verbose') {
        this._log(`  [S0:diag] result: error=${diagResult.hasError} busy=${diagResult.isBusy} source=${diagResult.source ?? 'none'}`);
      }
      this._trackIdleState(diagResult.isBusy);
      if (diagResult.hasError) {
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
      return { hasError: true, isBusy: busy };
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
        return probeResult;
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
      return { hasError: true, isBusy: false };
    }

    // Strategy 4: Manual trigger
    if (this._manualErrorFlag) {
      this._log('  [detect] ★ Manual: error flag set by user');
      return { hasError: true, isBusy: false };
    }

    if (level === 'verbose') {
      this._log(`  [detect] No error detected by any strategy`);
    }
    return { hasError: false, isBusy: this._lastSeenBusy };
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

    let result: ProbeResult = { hasError: false, isBusy: false };
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
          result = { hasError: true, isBusy };
          break;
        }

        if (errorVal === false) {
          if (level === 'verbose') {
            this._log(`  [S2:probe] Strategy "${strategy.name}" can read error key (value=false, no error)`);
          }
          result = { hasError: false, isBusy };
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
      const raw = await vscode.commands.executeCommand<unknown>('antigravity.getDiagnostics');
      const diag = this._parseDiagnosticsResult(raw);
      if (!diag) {
        if (level === 'verbose') this._log(`  [diag] getDiagnostics returned empty/unparseable (type=${typeof raw})`);
        return { hasError: false, isBusy: false };
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
          for (const pattern of DIAG_ERROR_PATTERNS) {
            const match = combinedNew.match(pattern);
            if (match) {
              this._log(`  [diag] ★ ${sourceName} error: "${match[0]}" in ${newEntries.length} new entries`);
              return { hasError: true, isBusy: false, source: `${sourceName}: ${match[0]}` };
            }
          }
          if (level === 'verbose') this._log(`  [diag:${sourceName}] No error patterns matched`);
        } else {
          // No changes — update state anyway (in case length shrank)
          this._lastLogState[sourceName] = { length: currentLen, lastEntry: currentTail };
        }
      }

      // ─── B. Monitor conversation step index and activity for stalls ──
      const trajectories = diag.recentTrajectories;
      let diagBusy = false;
      if (Array.isArray(trajectories) && trajectories.length > 0) {
        const active = trajectories[0];
        const currentStep = active.lastStepIndex ?? 0;
        const stepsChanged = this._lastKnownStepIndex !== null && currentStep !== this._lastKnownStepIndex;
        const stepStallSec = this._stepIndexLastChanged
          ? Math.round((Date.now() - this._stepIndexLastChanged) / 1000)
          : null;

        const lastModified = active.lastModifiedTime ? new Date(active.lastModifiedTime).getTime() : 0;
        const timeSinceModified = lastModified > 0 ? Date.now() - lastModified : Infinity;
        diagBusy = timeSinceModified < 30_000;

        if (level === 'verbose') {
          this._log(`  [diag:traj] id=${active.googleAgentId?.substring(0, 8) ?? '?'}... step=${currentStep} prevStep=${this._lastKnownStepIndex} changed=${stepsChanged} stallAge=${stepStallSec ?? 'n/a'}s lastModified=${Math.round(timeSinceModified / 1000)}s ago diagBusy=${diagBusy} summary="${(active.summary || '').substring(0, 60)}"`);
        }

        if (this._lastKnownStepIndex !== null) {
          if (stepsChanged) {
            this._stepIndexLastChanged = Date.now();
            this._lastKnownStepIndex = currentStep;
          }
        } else {
          this._lastKnownStepIndex = currentStep;
          this._stepIndexLastChanged = Date.now();
        }

        const idleTimeoutSec = this._getConfig<number>('idleTimeoutSeconds', 0);
        const trajectoryIsFromThisSession = lastModified > this._monitoringStartedAt;
        if (idleTimeoutSec > 0
          && this._stepIndexLastChanged
          && this._lastKnownStepIndex !== null
          && !diagBusy
          && trajectoryIsFromThisSession
        ) {
          const stallDuration = Date.now() - this._stepIndexLastChanged;
          if (stallDuration >= idleTimeoutSec * 1000) {
            const stallSec = Math.round(stallDuration / 1000);
            this._log(`  [diag] ★ Trajectory stall: step ${this._lastKnownStepIndex} unchanged for ${stallSec}s (threshold: ${idleTimeoutSec}s)`);
            return { hasError: true, isBusy: false, source: `trajectory stall (${stallSec}s at step ${this._lastKnownStepIndex})` };
          }
        }
      } else {
        if (level === 'verbose') this._log(`  [diag:traj] No trajectories found`);
      }

      return { hasError: false, isBusy: diagBusy };
    } catch (e: any) {
      this._log(`  [diag] getDiagnostics call failed: ${e.message ?? 'unknown'}`);
      return { hasError: false, isBusy: false };
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
      'Helm Auto Continue: Prompt copied to clipboard — paste (Ctrl+V) in the chat.',
      'Dismiss'
    );
  }

  // ─── Settings Webview ───────────────────────────────────────────────

  private _getSettingsHtml(): string {
    const config = vscode.workspace.getConfiguration('helmAutoContinue');
    const settings = {
      intervalSeconds: config.get<number>('intervalSeconds', 5),
      idleTimeoutSeconds: config.get<number>('idleTimeoutSeconds', 0),
      startOnActivation: config.get<boolean>('startOnActivation', true),
      focusProbe: config.get<boolean>('focusProbe', false),
      continuePrompt: config.get<string>('continuePrompt', 'Continue'),
      diagnosticsFrequency: config.get<number>('diagnosticsFrequency', 1),
      postSendCooldownMs: config.get<number>('postSendCooldownMs', 15000),
      logLevel: config.get<string>('logLevel', 'normal'),
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Helm Auto Continue Settings</title>
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
</style>
</head>
<body>
  <div class="header">
    <h1>⚙ Helm Auto Continue</h1>
    <span class="badge">v1.18.0</span>
  </div>

  <div class="promo">
    🔗 <a href="https://helm-agent.com">helm-agent.com</a> — Full AI task management for VS Code
  </div>

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
        <div class="setting-label">Idle Timeout</div>
        <div class="setting-desc">Seconds of inactivity to trigger recovery. 0 = disabled (recommended).</div>
      </div>
      <div class="setting-control">
        <input type="number" class="num-input" id="idleTimeoutSeconds" min="0" value="${settings.idleTimeoutSeconds}">
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

  <div class="saved-toast" id="toast">✓ Saved</div>

  <script>
    const vscode = acquireVsCodeApi();

    function save(key, value) {
      vscode.postMessage({ type: 'updateSetting', key, value });
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 1200);
    }

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

    // Toggles
    document.querySelectorAll('.toggle input').forEach(el => {
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
  </script>
</body>
</html>`;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private _getConfig<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration('helmAutoContinue').get<T>(key, defaultValue);
  }

  private _getLogLevel(): LogLevel {
    return this._getConfig<LogLevel>('logLevel', 'normal');
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
        this._statusBar.tooltip = `Helm Auto Continue — ${phase}. Click to stop.`;
        this._statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        this._statusBar.text = '$(eye) Auto Continue';
        this._statusBar.tooltip = 'Helm Auto Continue is monitoring — click to stop';
        this._statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
      }
    } else {
      this._statusBar.text = '$(eye-closed) Auto Continue';
      this._statusBar.tooltip = 'Helm Auto Continue is off — click to start';
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
    vscode.commands.registerCommand('helmAutoContinue.openSettings', () => autoContinue?.openSettings()),
  );
}

export function deactivate() {
  autoContinue?.dispose();
  autoContinue = undefined;
}

# Helm — Antigravity Recovery Auto Continue: Full Technical Reference

> **Source**: `src/extension.ts` (2 368 lines) · `package.json` · `CHANGELOG.md` · `README.md`
> **Current version**: v1.33.0
> **License**: MIT — Publisher: `imontaine`

---

## Table of Contents

1. [Purpose & Problem Statement](#1-purpose--problem-statement)
2. [Architecture Overview](#2-architecture-overview)
3. [Core Data Types](#3-core-data-types)
4. [Class: `AutoContinue`](#4-class-autocontinue)
   - 4.1 [Private State](#41-private-state)
   - 4.2 [Lifecycle Methods](#42-lifecycle-methods)
   - 4.3 [The Poll Timer](#43-the-poll-timer)
   - 4.4 [The Core Tick](#44-the-core-tick)
5. [Error Detection — 5 Strategies](#5-error-detection--5-strategies)
   - S0: [getDiagnostics Log Parsing](#s0-getdiagnostics-log-parsing-highest-priority)
   - S1: [Context Key Fast Path](#s1-context-key-inspection-fast-path)
   - S2: [Focus Probe](#s2-focus-probe-opt-in)
   - S3: [Idle / Stall Timeout](#s3-idle--stall-timeout)
   - S4: [Manual Flag](#s4-manual-error-flag)
6. [Error-Response State Machine](#6-error-response-state-machine)
7. [Busy / Idle Tracking](#7-busy--idle-tracking)
8. [Trajectory Binding & Window Isolation](#8-trajectory-binding--window-isolation)
9. [Safety Guards](#9-safety-guards)
10. [Chat Dispatch (3-Tier Fallback)](#10-chat-dispatch-3-tier-fallback)
11. [Diagnostic Capture](#11-diagnostic-capture)
12. [Settings Webview Panel](#12-settings-webview-panel)
13. [Status Bar](#13-status-bar)
14. [Commands Reference](#14-commands-reference)
15. [Configuration Reference](#15-configuration-reference)
16. [Default Pattern Lists](#16-default-pattern-lists)
17. [Cross-Extension Context Keys](#17-cross-extension-context-keys)
18. [Developer / Test Pipeline](#18-developer--test-pipeline)
19. [Build System](#19-build-system)
20. [Extension Lifecycle (activate / deactivate)](#20-extension-lifecycle-activate--deactivate)
21. [Changelog Highlights](#21-changelog-highlights)
22. [Full Data-Flow Diagram](#22-full-data-flow-diagram)

---

## 1. Purpose & Problem Statement

When the Antigravity AI agent makes calls to model APIs it occasionally hits transient failures:

| Error type | Example text |
|---|---|
| HTTP 503 | `503 Service Unavailable` |
| Capacity exhausted | `MODEL_CAPACITY_EXHAUSTED` |
| Rate limit | `rate limit exceeded` / `too many requests` |
| High traffic | `experiencing high traffic, try again` |
| Resource exhaustion | `RESOURCE_EXHAUSTED` |

When any of these occurs the agent **silently halts** and the user must manually type "Continue" — or notice the failure and do so. If left unattended (overnight jobs, long autonomous tasks), the agent can sit dead for hours.

**Helm Auto Continue** watches for these failures automatically and sends the configured resume prompt, requiring zero user intervention.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │               class AutoContinue                    │    │
│  │                                                     │    │
│  │  constructor()                                      │    │
│  │    ├─ create OutputChannel                          │    │
│  │    ├─ create StatusBar x2                           │    │
│  │    ├─ listen config changes                         │    │
│  │    ├─ _checkContextKeyAvailability()                │    │
│  │    ├─ _checkDiagnosticsAvailability()               │    │
│  │    └─ autoStart? → start()                          │    │
│  │                                                     │    │
│  │  start() ──► _startTimer()                          │    │
│  │                 └─► loop: _tick() every N seconds   │    │
│  │                           ├─► _detectState()        │    │
│  │                           │     ├─ S0: diag         │    │
│  │                           │     ├─ S1: ctxKey       │    │
│  │                           │     ├─ S2: probe        │    │
│  │                           │     ├─ S3: idle         │    │
│  │                           │     └─ S4: manual       │    │
│  │                           └─► state machine         │    │
│  │                                 └─► _sendToChatPanel│    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Registered Commands (9 total) → autoContinue.method()      │
└──────────────────────────────────────────────────────────────┘
```

- **Single source file**: `src/extension.ts` (~2 400 lines, zero runtime dependencies)
- **Bundled** by esbuild into `dist/extension.js` (CommonJS, Node 18 target)
- **Activation event**: `onStartupFinished` — activates after VS Code is fully loaded

---

## 3. Core Data Types

### `LogLevel`
```typescript
type LogLevel = 'minimal' | 'normal' | 'verbose';
```
Ordered `['minimal', 'normal', 'verbose']`. Controls output channel verbosity.

### `ErrorState`
```typescript
type ErrorState = 'monitoring' | 'waiting_idle' | 'cooldown';
```
The three states of the error-response state machine.

### `SessionStats`
```typescript
interface SessionStats {
  totalPolls: number;
  errorsDetected: number;
  continuesSent: number;
  lastState: string;          // e.g. 'OK', 'BUSY', 'ERROR', 'COOLDOWN'
  startedAt: number | null;   // Date.now() at last start()
}
```
Displayed in the debug status bar tooltip and logged on stop.

### `ProbeResult`
```typescript
interface ProbeResult {
  hasError: boolean;
  isBusy: boolean;    // True if agent is processing RIGHT NOW this poll
  isRecent: boolean;  // True if agent was active within the step-history window
  source?: string;    // Human-readable detection source for logging
}
```

### `StepEntry`
```typescript
interface StepEntry {
  ts: number;   // Date.now() when observed
  step: number; // lastStepIndex value from trajectory
}
```
Stored in a circular buffer of size 8 (`STEP_HISTORY_SIZE`).

---

## 4. Class: `AutoContinue`

### 4.1 Private State

| Field | Type | Purpose |
|---|---|---|
| `_timer` | `ReturnType<typeof setTimeout> \| null` | Handle for the current scheduled tick |
| `_statusBar` | `StatusBarItem` | Main toggle button (left, priority 97) |
| `_debugBar` | `StatusBarItem` | Debug state button (left, priority 96) |
| `_running` | `boolean` | Whether monitoring is active |
| `_monitoringStartedAt` | `number` | `Date.now()` when `start()` was called — used to filter stale trajectories |
| `_everSeenBusy` | `boolean` | Latches `true` the first time agent is observed busy in this session. Gate for Window Scope Recovery |
| `_manualErrorFlag` | `boolean` | Set by `reportError()`, consumed on next tick |
| `_output` | `OutputChannel` | `'Antigravity Recovery Auto Continue'` |
| `_settingsPanel` | `WebviewPanel \| undefined` | Live settings panel instance |
| `_testRunActive` | `boolean` | Enables live log pushes to webview test console |
| `_contextKeysAvailable` | `boolean \| null` | Whether `getContext` command is available |
| `_diagnosticsAvailable` | `boolean \| null` | Whether `antigravity.getDiagnostics` is available |
| `_lastLogState` | `Record<string, {length,lastEntry}>` | Per-source tracking of log tails for incremental scanning |
| `_stepHistory` | `StepEntry[]` | Circular buffer (max 8) of observed `(ts, stepIndex)` pairs |
| `_boundTrajectoryId` | `string \| null` | `googleAgentId` of the trajectory this window is bound to |
| `_diagPollCounter` | `number` | Counts polls since last diagnostics call |
| `_lastSeenBusy` | `boolean` | Previous poll's busy state — for transition detection |
| `_idleSince` | `number \| null` | `Date.now()` when agent last transitioned busy→idle |
| `_busyStart` | `number \| null` | `Date.now()` when agent first became busy |
| `_errorState` | `ErrorState` | Current state machine phase |
| `_cooldownStartedAt` | `number` | `Date.now()` when cooldown phase began |
| `_capturedThisCycle` | `boolean` | Prevents duplicate diagnostic captures per error cycle |
| `_simulatedErrorPending` | `boolean` | Dev flag: inject synthetic 503 on next diag poll |
| `_stats` | `SessionStats` | Running session counters |

### 4.2 Lifecycle Methods

#### `constructor(context)`
1. Creates `OutputChannel` named `'Antigravity Recovery Auto Continue'`
2. Creates two `StatusBarItem`s (priority 97 and 96, left-aligned)
3. Registers a `onDidChangeConfiguration` listener — if `intervalSeconds` changes while running, restarts the timer immediately
4. Calls `_checkContextKeyAvailability()` async (one-time probe)
5. Calls `_checkDiagnosticsAvailability()` async (one-time probe, seeds `_lastLogState`)
6. If `startOnActivation` is `true` (default): calls `start()`

#### `start()`
- Guards against double-start (`if (this._running) return`)
- Resets all state fields to initial values
- Sets context key `helmAutoContinue.isActive = true`
- Calls `_startTimer()` and `_pushRunningState()`
- Shows info notification with interval

#### `stop()`
- Guards against double-stop
- Calls `_stopTimer()`
- Resets all state fields
- Clears context keys `helmAutoContinue.isActive` and `helmAutoContinue.isRetrying`
- Logs session stats

#### `toggle()` / `reportError()` / `dispose()`
Standard convenience wrappers.

### 4.3 The Poll Timer

```typescript
private _startTimer(): void {
  const loop = async () => {
    if (!this._running) return;
    await this._tick();                       // ← await: sequential, never overlapping
    if (this._running) {
      const intervalSec = this._getConfig('intervalSeconds', 5);
      this._timer = setTimeout(loop, intervalSec * 1000);  // ← re-read config each cycle
    }
  };
  void loop(); // run immediately, then schedule
}
```

**Key design**: `setTimeout` (not `setInterval`) guarantees that the next tick is only scheduled after the current one fully completes. This prevents overlapping ticks when async operations (especially the `getDiagnostics` call) take longer than the interval.

The interval is **re-read from config on every cycle**, so changing `intervalSeconds` takes effect at the next tick after `_startTimer()` is called.

### 4.4 The Core Tick (`_tick()`)

Called once per interval. Steps:

1. `_stats.totalPolls++`
2. `await _detectState()` → get `ProbeResult`
3. Compute `stateLabel` (`'OK'`, `'BUSY'`, `'ERROR'`, `'ERROR+BUSY'`, `'WAIT_IDLE'`, `'COOLDOWN'`)
4. Log at verbose level
5. `_updateDebugBar()`
6. Run the state machine switch

---

## 5. Error Detection — 5 Strategies

All strategies are executed in `_detectState()` in priority order. The first one that returns `hasError: true` is used.

### S0: `getDiagnostics` Log Parsing (Highest Priority)

**Function**: `_checkDiagnostics()`

**How it works**:
1. Calls `antigravity.getDiagnostics` — returns a large JSON blob (~6 MB) containing:
   - `mainThreadLogs` — extension host logs
   - `rendererLogs` — UI/renderer logs
   - `languageServerLogs` — language server logs
   - `recentTrajectories[]` — agent conversation histories with `lastStepIndex`, `lastModifiedTime`, `googleAgentId`
   - `agentStateDebug.conversations` — live engine conversation state map
2. Calls `_extractAllLogSources()` to flatten logs into `[sourceName, entries[]]` tuples
3. For each source, compares against cached `_lastLogState[sourceName]` to find **new entries only** (handles both growing and circular-buffer log sources via `lengthGrew || tailChanged` detection)
4. Scans new entries against **suppress patterns** first (non-retryable → stop monitoring)
5. Then scans against **error patterns** (retryable → trigger recovery)
6. Also monitors `recentTrajectories[0].lastStepIndex` for stall detection and busy signals

**Frequency**: Runs every `diagnosticsFrequency` polls (default 1 = every poll).

**Log source extraction**: The payload format evolves:
- Flat string → split on newlines
- `string[]` → use directly
- `{ $typeName, logs: string[] }` → use `.logs`
- Container object `{ cloudcode: [...], auth: [...], 'ls-main': [...] }` → recurse each sub-key as a separate tracked source (e.g., `mainThreadLogs.cloudcode`)

**Simulated error path**: If `_simulatedErrorPending` is `true`, skips the real call and returns `{ hasError: true, source: 'simulated 503 (test)' }`.

### S1: Context Key Inspection (Fast Path)

**Function**: `_hasChatError()`

```typescript
await vscode.commands.executeCommand<boolean>('getContext', 'chatSessionResponseError')
```

Reads the VS Code context key `chatSessionResponseError`. This key is **scoped to the chat response widget element** — it only returns a useful value when a response item is in the focus chain (not just when the chat input box is focused). Returns `true` only when explicitly `=== true`.

If `true`: also reads `chatSessionRequestInProgress` via `_readBusyKey()` for the `isBusy` field.

### S2: Focus Probe (Opt-In)

**Function**: `_probeChatState()` — controlled by `focusProbe` setting (default **false**)

Briefly steals focus to bring scoped context keys into scope. Tries 4 strategies in order:

| Strategy | Commands | Purpose |
|---|---|---|
| **A** | `workbench.action.chat.open` → `list.focusLast` | Standard chat panel + navigate to last response |
| **B** | `antigravity.agentPanel.focus` → `list.focusLast` | Antigravity-specific panel focus |
| **C** | `antigravity.toggleChatFocus` → `list.focusLast` | Toggle focus approach |
| **D** | `workbench.action.chat.open` → `list.focusFirst` → `list.focusLast` | Full navigation sequence |

After each strategy, reads both `chatSessionResponseError` and `chatSessionRequestInProgress`. Stops at the first strategy that returns a definitive (`true` or `false`, not `undefined`) value for the error key.

**Focus restoration**: After probing, restores the previously active text editor — UNLESS:
- An error was detected (keep chat focused for recovery)
- We're in a non-monitoring state (already retrying)
- The active doc is an output channel (prevents log stealing focus)

> ⚠ Disabled by default — causes visible UI flickering every poll cycle.

### S3: Idle / Stall Timeout

**Function**: `_checkIdleTimeout()` / stall detection in `_checkDiagnostics()`

Two paths:

**A. Idle timeout** (context-key based):
- Tracks transitions via `_trackIdleState(isBusy)` on every poll
- When `_idleSince` is set AND elapsed ≥ `idleTimeoutSeconds` AND `_everSeenBusy` is true → returns error
- Requires `idleTimeoutSeconds > 0` (default 0 = disabled)

**B. Step-index stall** (diagnostics based, inside `_checkDiagnostics()`):
- Uses the circular `_stepHistory` buffer
- Finds the timestamp of the last step-index change
- If `Date.now() - lastChangeTs >= idleTimeoutSeconds * 1000` → returns error with source `stall (Ns at step M)`
- Only fires if bound to our trajectory and `_everSeenBusy`

### S4: Manual Error Flag

```typescript
if (this._manualErrorFlag) {
  return { hasError: true, isBusy: false, isRecent: false };
}
```

Set by `reportError()` → consumed on the very next tick. Always fires (no guards).

---

## 6. Error-Response State Machine

```
          ┌────────────────────────────────────────────────────────┐
          │                    MONITORING                          │
          │   Poll every N seconds using all 5 strategies         │
          │                                                        │
          │   hasError? NO  ──────────────────────────────────►  (stay)
          │   hasError? YES ─────────────────────────────────┐    │
          └───────────────────────────────────────────────────┼───┘
                                                              │
                                              isRecent? YES ──┼──► WAITING_IDLE
                                              isRecent? NO  ──┼──► COOLDOWN
                                                              │
          ┌───────────────────────────────────────────────────┘
          │                   WAITING_IDLE                         │
          │   Agent recently active — wait for silence            │
          │                                                        │
          │   isRecent? YES ─────────────────────────────────►  (stay)
          │   isRecent? NO  ─────────────────────────────────► COOLDOWN
          └────────────────────────────────────────────────────────┘

          ┌────────────────────────────────────────────────────────┐
          │                     COOLDOWN                           │
          │   Wait postSendCooldownMs after agent goes idle        │
          │                                                        │
          │   elapsed < cooldown ────────────────────────────► (stay)
          │   elapsed >= cooldown ───────────────────────────►  Send Continue
          │                                                    ↓
          │                                            Back to MONITORING
          └────────────────────────────────────────────────────────┘
```

**State transitions in code** (`_tick()` switch statement):

- `monitoring` → receives `hasError: true, isRecent: true` → `waiting_idle`, sets `helmAutoContinue.isRetrying = true`
- `monitoring` → receives `hasError: true, isRecent: false` → `cooldown`, starts cooldown timer
- `waiting_idle` → receives `isRecent: false` → `cooldown`
- `cooldown` → elapsed ≥ `postSendCooldownMs` → call `_sendToChatPanel(prompt)`, reset to `monitoring`, clear `helmAutoContinue.isRetrying`

**On entering COOLDOWN**: seeds `_stepHistory` with a synthetic `{ ts: now, step: -1 }` entry so the busy window doesn't immediately fire again before the agent responds.

**No retry limit, no exponential backoff** — the cycle repeats indefinitely until the error stops appearing in new log entries.

---

## 7. Busy / Idle Tracking

### `_trackIdleState(isBusy: boolean)`

Called on every detection cycle. Maintains:

| Transition | Action |
|---|---|
| `!busy → busy` | Set `_everSeenBusy = true`, record `_busyStart = Date.now()`, clear `_idleSince`, log "● Agent busy" |
| `busy → !busy` | Set `_idleSince = Date.now()`, clear `_lastSeenBusy`, log "○ Agent idle (was busy Ns)" |
| `busy → busy` | No change (already recording) |
| `!busy → !busy` | No change |

### `_busyStart` vs `_idleSince`

- `_busyStart`: when the current busy period began (used for logging duration)
- `_idleSince`: when the agent last went idle (used for idle timeout and recovery timeout gates)
- Both are `null` at startup — only the idle timeout fires after actual agent activity (`_everSeenBusy` guard)

---

## 8. Trajectory Binding & Window Isolation

The `antigravity.getDiagnostics` payload is **global** — all VS Code windows running Antigravity share the same backend log pool and trajectory list. Without isolation, a 503 in Window A would trigger recovery in Window B.

### Three-Layer Isolation

**Layer 1: `trajectoryIsFromThisSession`**
```typescript
const lastModified = new Date(active.lastModifiedTime).getTime();
const trajectoryIsFromThisSession = lastModified > this._monitoringStartedAt;
```
Rejects trajectories whose `lastModifiedTime` predates this window's `start()` call.

**Layer 2: Trajectory Binding**
```typescript
if (stepChangedThisPoll && trajectoryIsFromThisSession && isLocalWindowBusy) {
  this._boundTrajectoryId = trajectoryId;
}
```
Binds to a trajectory's `googleAgentId` only when:
- Step index changed this poll (direct proof of activity)
- Trajectory is from this session
- The local window's `chatSessionRequestInProgress` context key is `true`

Once bound, **only** this trajectory ID is used for busy/stall detection.

**Layer 3: Window Scope Recovery**
```typescript
if (windowScope && !this._everSeenBusy) {
  // Suppress error — agent never active in this window
}
```
The `_everSeenBusy` flag must be `true` before any error from diagnostics can trigger recovery. It latches `true` on:
- `_trackIdleState(true)` — context key or probe detected busy
- Trajectory step-index change while locally busy

### Recovery Timeout Gate
```typescript
const idleDuration = (Date.now() - this._idleSince) / 1000;
if (idleDuration >= recoveryTimeoutSec) {
  return { hasError: false, isBusy: false, isRecent: false };
}
```
Default 300 seconds. If the agent has been idle longer than this, error detection is suppressed entirely — prevents stale log errors from firing recovery in windows that have been idle for hours.

---

## 9. Safety Guards

| Guard | Mechanism | Default |
|---|---|---|
| **Window Scope Recovery** | `_everSeenBusy` must be `true` | ON |
| **Recovery Timeout** | Suppress if idle > N seconds | 300s |
| **Non-retryable suppression** | Suppress patterns stop monitoring | Billing/credit errors |
| **Wait-for-idle** | `WAITING_IDLE` state waits for `!isRecent` | Always active |
| **Cooldown timer** | `COOLDOWN` waits `postSendCooldownMs` | 10,000ms |
| **Cold-start guard** | `_busyStart = null` at startup; idle timeout only fires after observed activity | Always active |
| **Session trajectory guard** | `trajectoryIsFromThisSession` filter | Always active |
| **Local window trajectory bind** | `isLocalWindowBusy` required for binding | Always active |
| **Sequential timer** | `setTimeout` loop (no `setInterval`) | Always active |
| **Diagnostic capture** | `_capturedThisCycle` prevents duplicate captures | Always active |

---

## 10. Chat Dispatch (3-Tier Fallback)

**Function**: `_sendToChatPanel(prompt: string)`

```
Priority 1: antigravity.sendPromptToAgentPanel
   ↓ (throws / unavailable)
Priority 2: workbench.action.chat.open { query: prompt, isPartialQuery: false }
   ↓ (throws / unavailable)
Priority 3: env.clipboard.writeText(prompt)
            + workbench.action.chat.open  (or antigravity.openChatView)
            + showWarningMessage("paste it manually")
```

The extension never assumes any specific command is available — it always falls through gracefully.

---

## 11. Diagnostic Capture

**Function**: `_captureDiagnostics(label: string)`

Called **once per error cycle** (guarded by `_capturedThisCycle`). Calls `getDiagnostics` again and writes the full payload as pretty-printed JSON to:

```
<workspaceRoot>/.helm-diag/diag_<label>_<ISO-timestamp>.json
```

Purpose: lets you inspect the exact log state at the moment of error detection, enabling precise tuning of error patterns.

---

## 12. Settings Webview Panel

**Opened by**: `helmAutoContinue.openSettings` command / clicking the status bar eye icon.

Built with inline HTML/CSS/JS in `_getSettingsHtml()` (lines 1573–2226 of extension.ts).

### UI Sections

| Section | Controls |
|---|---|
| **Monitoring card** | Toggle switch → sends `toggleMonitoring` message |
| **Core** | Poll Interval (number), Continue Prompt (text), Auto Start (toggle), Window Scope Recovery (toggle) |
| **Timing** | Post-Send Cooldown (number/ms), Stall Detection (number/s), Recovery Timeout (number/s) |
| **Detection** | Diagnostics Frequency (number), Focus Probe (toggle) |
| **Patterns** | Error Patterns (textarea, one regex per line), Suppress Patterns (textarea) |
| **Logging** | Log Level (select: minimal/normal/verbose) |
| **Developer Tools** | Instructions for Command Palette commands + live `testConsole` div |

### Message Protocol (Webview ↔ Extension)

**Webview → Extension**:

| `msg.type` | Action |
|---|---|
| `updateSetting` | `config.update(key, value, Global)` |
| `toggleMonitoring` | `this.toggle()` |
| `simulateError` | `this.simulateError()` |
| `markWindowActive` | `this.markWindowActive()` |
| `runFullTest` | `this.runFullTest()` |

**Extension → Webview**:

| `msg.type` | Payload | Effect |
|---|---|---|
| `runningState` | `{ running: boolean }` | Updates monitor card and toggle |
| `testLog` | `{ level, message, ts }` | Appends colored line to test console |

### Webview Input Debouncing

- **Number inputs**: save on `change` (immediate)
- **Text inputs**: debounce 500ms on `input`
- **Toggles**: save on `change` (immediate, excludes monitor toggle)
- **Selects**: save on `change` (immediate)
- **Pattern textareas**: debounce 800ms on `input`, splits on newlines, filters empty lines

---

## 13. Status Bar

Two items in the VS Code status bar (bottom-left):

### Main Button (priority 97) — opens Settings

| `_running` | `_errorState` | Icon + Text | Background |
|---|---|---|---|
| `false` | — | `$(eye-closed) Auto Continue` | Default |
| `true` | `monitoring` | `$(eye) Auto Continue` | `statusBarItem.prominentBackground` |
| `true` | `waiting_idle` | `$(sync~spin) Auto Continue (waiting)` | `statusBarItem.warningBackground` |
| `true` | `cooldown` | `$(sync~spin) Auto Continue (cooldown)` | `statusBarItem.warningBackground` |

### Debug Button (priority 96) — opens Output Channel

| State | Icon + Text | Background |
|---|---|---|
| Not running | `$(terminal) Log` | Default |
| OK | `$(terminal) OK` | Default |
| BUSY | `$(terminal) BUSY` | `statusBarItem.warningBackground` |
| ERROR | `$(terminal) ERROR` | `statusBarItem.errorBackground` |
| WAIT_IDLE | `$(terminal) WAIT_IDLE` | `statusBarItem.errorBackground` |
| COOLDOWN | `$(terminal) COOLDOWN` | `statusBarItem.errorBackground` |

Tooltip shows: State, Phase, Polls, Errors, Sent, Idle since, Busy since.

---

## 14. Commands Reference

| Command ID | Title | Description |
|---|---|---|
| `helmAutoContinue.toggle` | Toggle | Start or stop monitoring |
| `helmAutoContinue.start` | Start | Start monitoring |
| `helmAutoContinue.stop` | Stop | Stop monitoring |
| `helmAutoContinue.showLog` | Show Log | Open the output channel |
| `helmAutoContinue.reportError` | Report Chat Error | Manually trigger error recovery |
| `helmAutoContinue.openSettings` | Settings | Open the settings webview panel |
| `helmAutoContinue.simulateError` | Simulate Error (Test) | Queue synthetic 503 on next poll |
| `helmAutoContinue.markWindowActive` | Mark Window Active (Test) | Set `_everSeenBusy = true` (bypass WSR) |
| `helmAutoContinue.runFullTest` | Run Full Test | Combined: start + mark active + simulate error |

All 9 commands are registered in `activate()` and listed in the Command Palette.

---

## 15. Configuration Reference

All settings under `helmAutoContinue.*`:

### Core

| Key | Type | Default | Min | Description |
|---|---|---|---|---|
| `intervalSeconds` | number | `5` | `3` | How often (seconds) to poll for errors |
| `continuePrompt` | string | `"Continue"` | — | Message sent to resume agent |
| `startOnActivation` | boolean | `true` | — | Auto-start on VS Code launch |
| `windowScopeRecovery` | boolean | `true` | — | Require local agent activity before recovery |

### Timing

| Key | Type | Default | Description |
|---|---|---|---|
| `postSendCooldownMs` | number | `10000` | Ms to wait after agent goes idle before sending Continue |
| `idleTimeoutSeconds` | number | `0` (disabled) | Stall detection threshold in seconds |
| `recoveryTimeoutSeconds` | number | `300` | Suppress if agent idle longer than this |

### Detection

| Key | Type | Default | Max | Description |
|---|---|---|---|---|
| `diagnosticsFrequency` | number | `1` | `20` | Run getDiagnostics every Nth poll |
| `focusProbe` | boolean | `false` | — | Briefly focus chat panel to read context keys |

### Patterns

| Key | Type | Default | Description |
|---|---|---|---|
| `errorPatterns` | string[] | *(17 patterns)* | Regex patterns that trigger Continue |
| `suppressPatterns` | string[] | *(6 patterns)* | Regex patterns that stop monitoring |

### Logging

| Key | Type | Default | Values | Description |
|---|---|---|---|---|
| `logLevel` | string | `"minimal"` | `minimal`, `normal`, `verbose` | Output channel verbosity |

---

## 16. Default Pattern Lists

### Error Patterns (trigger Continue)

```
\b503\b
rate.?limit
capacity.?exhaust
model.?capacity
overloaded
too.?many.?requests
service.?unavailable
quota.?exceeded
temporarily.?unavailable
RESOURCE_EXHAUSTED
server.?error
internal.?server.?error
high.?traffic
try.?again.?in
please.?try.?again
experiencing.?high
No capacity available
MODEL_CAPACITY_EXHAUSTED
```

All matched **case-insensitively** (`RegExp(p, 'i')`). Invalid patterns are silently skipped.

### Suppress Patterns (stop monitoring on match)

```
insufficient.?ai.?credits
insufficient.?credits
no.?credits.?remaining
billing.?required
payment.?required
subscription.?expired
```

When a suppress pattern matches a new log entry, `this.stop()` is called and a warning notification is shown — these are non-retryable conditions.

---

## 17. Cross-Extension Context Keys

Set via `vscode.commands.executeCommand('setContext', key, value)`:

| Key | Set to `true` when | Set to `false` when |
|---|---|---|
| `helmAutoContinue.isActive` | `start()` called | `stop()` called |
| `helmAutoContinue.isRetrying` | Error detected (entering WAITING_IDLE or COOLDOWN) | Continue sent (returning to MONITORING) / `stop()` |

These can be used by other extensions (e.g., keybinding conditions) to detect whether auto-continue is active or mid-recovery.

---

## 18. Developer / Test Pipeline

### `runFullTest()` (recommended)

Sequence:
1. If not running: `start()` (which resets `_everSeenBusy = false`)
2. If running: reset `_idleSince`, `_errorState → 'monitoring'`, `_capturedThisCycle = false`
3. Set `_everSeenBusy = true` (bypass Window Scope Recovery)
4. Set `_simulatedErrorPending = true`
5. Set `_testRunActive = true` (enables webview test console updates)
6. Show info notification

Expected pipeline trace:
```
🧪 Synthetic "503 error" queued → [next poll]
⚠ Error detected [simulated 503 (test)]
⏳ Agent idle → COOLDOWN (Ns)
⏳ Cooldown: Ns remaining...
↻ Sending "Continue" to chat panel...
✅ Continue sent! Full pipeline test passed.
```

### `simulateError()`
- Calls `start()` if not running
- Sets `_simulatedErrorPending = true`
- Sets `_everSeenBusy = true` (v1.28.0 fix — auto-bypasses Window Scope Recovery)
- Sets `_testRunActive = true`

### `markWindowActive()`
- Sets `_everSeenBusy = true`
- Shows info notification

### Test Tips

- Set `logLevel = verbose` to see every strategy's output
- Set `postSendCooldownMs = 1000` for fast cycle iteration
- Watch the Output channel (`Antigravity Recovery Auto Continue: Show Log`) for real-time trace
- Open Settings panel for the live `testConsole` div

---

## 19. Build System

`esbuild.js`:

```javascript
config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],        // vscode API is injected by the runtime
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isProduction,    // included in dev builds
  minify: isProduction,
};
```

| Script | Command | Use |
|---|---|---|
| `npm run build` | `node esbuild.js` | Dev build with sourcemaps |
| `npm run build:watch` | `node esbuild.js --watch` | Incremental watch mode |
| `npm run vscode:prepublish` | `node esbuild.js --production` | Minified production build |
| `npm run package` | `npx @vscode/vsce package --no-dependencies --allow-missing-repository` | Package as `.vsix` |

---

## 20. Extension Lifecycle (activate / deactivate)

```typescript
export function activate(context: vscode.ExtensionContext) {
  autoContinue = new AutoContinue(context);
  context.subscriptions.push(
    { dispose: () => autoContinue?.dispose() },
    ...9 command registrations
  );
}

export function deactivate() {
  autoContinue?.dispose();
  autoContinue = undefined;
}
```

`dispose()` → `stop()` (stops timer, clears context keys) + disposes settings panel + disposes status bar items.

All disposables (output channel, status bar items, config listener) are registered in `_context.subscriptions` — VS Code automatically disposes them on deactivation.

---

## 21. Changelog Highlights

| Version | Key Changes |
|---|---|
| **v1.0.0** | Initial release |
| **v1.20.0** | Added getDiagnostics log parsing (S0), context key inspection (S1), focus probe (S2), idle timeout (S3), settings webview, diagnostic capture, 3-tier chat dispatch |
| **v1.21.0** | Window Scope Recovery, Recovery Timeout, non-retryable suppression, editable patterns, cooldown default 5s→10s |
| **v1.21.2** | Fix: idle window showed BUSY when another window's agent was active (`trajectoryIsFromThisSession` guard) |
| **v1.21.4** | Fix: cross-window busy false positive — added `_everSeenBusy` guard and trajectory ID binding |
| **v1.22.0–v1.23.0** | Busy detection overhaul: step-history circular buffer, `isBusy`/`isRecent` separation, trajectory binding on first step-change, `agentStateDebug.conversations` probing |
| **v1.24.0** | `busyWindowSeconds` setting (later integrated into history buffer design) |
| **v1.27.0** | Fixed `_everSeenBusy` circular dependency — step-index change now directly sets it |
| **v1.28.0** | `simulateError()` now auto-sets `_everSeenBusy`, works without getDiagnostics |
| **v1.30.0–v1.30.1** | Fixed `runFullTest()` ordering bug (`_everSeenBusy` set before `start()` which reset it); fixed test suppression by idle recovery timeout; added info notification |
| **v1.31.0** | Test commands registered in Command Palette (previously webview-only) |
| **v1.32.0** | Local window trajectory binding — uses `chatSessionRequestInProgress` to prevent idle windows from binding to other windows' trajectories |
| **v1.33.0** | UI cleanup — removed synthetic test buttons from settings webview; replaced with Command Palette instructions |

---

## 22. Full Data-Flow Diagram

```
VS Code Extension Host
│
├─ onStartupFinished ──────────────────────────────────► activate()
│                                                              │
│                                                     new AutoContinue(context)
│                                                              │
│                                               ┌─────────────┴──────────────┐
│                                               │   Startup Probes (async)   │
│                                               │  _checkContextKeyAvail()   │
│                                               │  _checkDiagnosticsAvail()  │
│                                               │    seeds _lastLogState      │
│                                               └─────────────┬──────────────┘
│                                                             │
│                                                    start() ← autoStart
│                                                             │
│                                               ┌────────────▼───────────────┐
│                                               │       Poll Timer Loop       │
│                                               │   setTimeout → _tick()      │
│                                               │   (re-schedules after done) │
│                                               └────────────┬───────────────┘
│                                                            │
│                                               ┌────────────▼───────────────┐
│                                               │        _tick()              │
│                                               │                             │
│                                               │  _detectState()             │
│                                               │  ├─ S0: getDiagnostics     │
│                                               │  │   ├─ scan new log entries│
│                                               │  │   ├─ check suppressPat  │
│                                               │  │   ├─ check errorPat     │
│                                               │  │   ├─ stall detection     │
│                                               │  │   └─ agentStateDebug    │
│                                               │  ├─ recovery timeout gate  │
│                                               │  ├─ window scope gate      │
│                                               │  ├─ S1: ctxKey            │
│                                               │  ├─ S2: focus probe        │
│                                               │  ├─ S3: idle timeout       │
│                                               │  └─ S4: manual flag        │
│                                               │                             │
│                                               │  State Machine              │
│                                               │  ┌─ monitoring             │
│                                               │  │   NO error → return     │
│                                               │  │   error+busy → wait_idle│
│                                               │  │   error+idle → cooldown │
│                                               │  ├─ waiting_idle           │
│                                               │  │   still recent → wait   │
│                                               │  │   !recent → cooldown    │
│                                               │  └─ cooldown               │
│                                               │      not ready → wait      │
│                                               │      ready → SEND          │
│                                               │               ↓            │
│                                               │   _sendToChatPanel()       │
│                                               │   ├─ sendPromptToAgentPanel│
│                                               │   ├─ chat.open w/ query    │
│                                               │   └─ clipboard fallback    │
│                                               └────────────────────────────┘
│
├─ User commands ──────────────────────────────────────────────────────────────
│   toggle/start/stop/showLog/reportError/openSettings
│   simulateError/markWindowActive/runFullTest
│
└─ Config changes ─────────────────────────────────────► restart timer
```

---

*Documentation generated from source: `src/extension.ts` v1.33.0*

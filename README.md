# Helm — Auto Continue

A lightweight VS Code extension that automatically detects chat API errors (503, rate limits, capacity exhaustion) and sends a configurable prompt to resume the AI agent — so you never have to babysit a stalled conversation.

---

## The Problem

When using AI coding assistants in VS Code (Antigravity, Copilot Chat, etc.), the underlying model APIs occasionally fail mid-response with transient errors:

- **HTTP 503** — service temporarily unavailable
- **MODEL_CAPACITY_EXHAUSTED** — the model is overloaded
- **Rate limiting** — too many requests in a short window

When this happens, the agent stops and the conversation hangs. You have to manually notice the failure, type "Continue", and wait. If it happens at 2 AM while you're AFK, your agent is dead in the water until you come back.

## The Solution

**Helm Auto Continue** monitors for chat errors using multiple detection strategies and automatically sends a configurable prompt to resume the agent. It uses exponential backoff to space retries intelligently and includes safety rails to prevent infinite retry loops.

---

## How It Works

### Error Detection

The extension uses **five strategies** to detect errors, in priority order:

| # | Strategy | How It Works | Reliability | Requires Focus? |
|---|---|---|---|---|
| **S0** | **Diagnostics log parsing** | Calls `antigravity.getDiagnostics`, parses `agentWindowConsoleLogs` and `languageServerLogs` for error patterns (503, rate limit, capacity). Also monitors trajectory step index for stalls. | ⭐⭐⭐⭐ | No |
| **S1** | **Context key** | Reads `chatSessionResponseError` via `getContext` command | ⭐⭐⭐ | Yes — response element must be in focus chain |
| **S2** | **Focus probe** | Focuses the chat panel, navigates to last response element, reads context keys, restores focus | ⭐⭐ | Self-focusing (causes flicker) |
| **S3** | **Idle timeout** | Tracks `chatSessionRequestInProgress` and triggers when agent has been idle too long after being active | ⭐⭐⭐ | Depends on S0/S1 busy signal |
| **S4** | **Manual trigger** | User runs `Report Chat Error` from Command Palette | ⭐⭐⭐⭐⭐ | No |

> **Primary strategy:** S0 (diagnostics log parsing) is the most reliable because it requires no focus management and detects errors from log content. S1–S3 provide supplementary detection. S4 is the guaranteed fallback.

> **Why so many strategies?** The `chatSessionResponseError` context key is **scoped** to the chat response widget element in the VS Code DOM, not the global context. It's only readable when the response element is in the focus chain. S0 bypasses this limitation entirely by parsing raw log data.

### Error Response State Machine

Once an error is detected, the extension follows a simple 3-state machine:

```
┌─ MONITORING ──────────────────────────────────────────────────
│   Poll for errors using all detection strategies
│   Error detected? ─── NO → stay in MONITORING
│                   └── YES ↓
├─ Is the agent busy?
│   YES → WAITING_IDLE (wait for agent to stop processing)
│   NO  → COOLDOWN (start cooldown timer)
│
├─ WAITING_IDLE ────────────────────────────────────────────────
│   Agent still busy? → wait
│   Agent went idle?  → COOLDOWN (start cooldown timer)
│
├─ COOLDOWN ────────────────────────────────────────────────────
│   Timer not expired? → wait
│   Timer expired?     → Send "Continue" → back to MONITORING
│
└─ Repeat forever — no retry limit, no backoff
```

### Chat Dispatch Strategy

The extension delivers the continue prompt using a three-tier fallback:

| Priority | Command | Notes |
|---|---|---|
| 1 | `antigravity.sendPromptToAgentPanel` | Antigravity's native API — preferred |
| 2 | `workbench.action.chat.open` with `query` | Standard VS Code Chat API |
| 3 | Clipboard fallback | Copies prompt, opens chat, shows paste warning |

### Timer Design

Uses a **self-scheduling `setTimeout` loop** instead of `setInterval`. The next tick is only scheduled after the current one completes. Prevents overlapping ticks when async operations take longer than the interval.

### Cooldown

After detecting an error, the extension waits for the agent to go idle, then waits a configurable cooldown period (default 15s) before sending "Continue". This ensures the system has fully stabilized before issuing a new prompt.

### Diagnostic Capture

On the first error detection in each error cycle, the extension captures the full diagnostics payload to `.helm-diag/` in the workspace root. These JSON files show exactly what the logs looked like when the error occurred — invaluable for tuning error pattern matching.

### Status Bar

Two status bar items (left-aligned):

#### Main Button (toggle)

| State | Icon | Background |
|---|---|---|
| **Off** | `$(eye-closed) Auto Continue` | Default |
| **Monitoring** | `$(eye) Auto Continue` | Prominent |
| **Waiting/Cooldown** | `$(sync~spin) Auto Continue (waiting\|cooldown)` | Warning (yellow) |

#### Debug Button (log)

| State | Icon | Background |
|---|---|---|
| **Not running** | `$(terminal) Log` | Default |
| **OK** | `$(terminal) OK` | Default |
| **BUSY** | `$(terminal) BUSY` | Warning (yellow) |
| **ERROR** | `$(terminal) ERROR` | Error (red) |
| **WAIT_IDLE** | `$(terminal) WAIT_IDLE` | Error (red) |
| **COOLDOWN** | `$(terminal) COOLDOWN` | Error (red) |

### Cross-Extension Context Keys

| Context Key | Meaning |
|---|---|
| `helmAutoContinue.isActive` | `true` while monitoring is running |
| `helmAutoContinue.isRetrying` | `true` during WAITING_IDLE or COOLDOWN phases |

---

## Installation

```bash
cd helm_auto_continue
npm install
npm run build
npm run package
# Install the generated .vsix file via VS Code Extensions sidebar → "..." → "Install from VSIX..."
```

---

## Usage

### Commands

| Command | Description |
|---|---|
| `Helm Auto Continue: Toggle` | Start or stop monitoring |
| `Helm Auto Continue: Start` | Start monitoring |
| `Helm Auto Continue: Stop` | Stop monitoring |
| `Helm Auto Continue: Show Log` | Open the output channel |
| `Helm Auto Continue: Report Chat Error` | Manually trigger error recovery |

### Quick Start

1. Install the extension — it starts monitoring automatically
2. Start your AI agent
3. If it hits a transient error, auto-continue detects it via log parsing and triggers automatically
4. If detection fails for any reason, run `Helm Auto Continue: Report Chat Error` (Ctrl+Shift+P) to trigger recovery manually

---

## Configuration

All settings under `helmAutoContinue.*`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `intervalSeconds` | number | `5` | Polling interval (seconds). Min: 3. |
| `startOnActivation` | boolean | `true` | Auto-start when VS Code launches. |
| `continuePrompt` | string | `"Continue"` | The message sent to the chat panel. |
| `postSendCooldownMs` | number | `15000` | Cooldown (ms) after agent goes idle before sending Continue. |
| `diagnosticsFrequency` | number | `1` | Run getDiagnostics log parsing every Nth poll tick. Higher = less overhead but slower detection. |
| `idleTimeoutSeconds` | number | `0` | Seconds of inactivity after being busy before triggering. 0 = disabled (recommended). |
| `focusProbe` | boolean | `false` | Briefly focus chat panel to read context keys. Disabled by default (causes flickering). |
| `logLevel` | string | `"normal"` | `minimal` (events only), `normal` (+ one-line poll summaries), `verbose` (full per-strategy diagnostics). |

---

## Safety Rails

- **Wait-for-idle** — Never sends Continue while the agent is actively processing
- **Cooldown timer** — Waits `postSendCooldownMs` after agent goes idle before sending
- **Unlimited retries** — Keeps retrying as long as errors occur (no retry limit)
- **Cold-start guard** — Idle timeout only fires after agent activity has been observed
- **Session-aware trajectory** — Stale conversations from previous sessions don't trigger false stalls
- **Sequential timer** — `setTimeout` loop prevents overlapping ticks
- **Diagnostic capture** — Full log payload saved on first error per cycle for debugging

---

## Error Patterns

The diagnostics log scanner matches these patterns (case-insensitive):

```
503, rate limit, capacity exhaust, model capacity,
overloaded, too many requests, service unavailable,
quota exceeded, temporarily unavailable, RESOURCE_EXHAUSTED,
server error, internal server error, high traffic,
try again in, please try again, experiencing high,
No capacity available, MODEL_CAPACITY_EXHAUSTED
```

---

## Changelog

### 1.20.0 — Settings-First UX

- **Status bar opens settings panel** — clicking `Auto Continue` in the status bar now opens the settings webview instead of toggling on/off.
- **Monitoring toggle** — on/off control is now the first item in the settings panel with live state sync (green active card, grey stopped).
- Toggle/start/stop commands remain available via Command Palette.

### 1.19.0 — Settings Panel

- **Settings webview panel** — open via Command Palette → `Helm Auto Continue: Settings`. Provides a clean dark UI with toggle switches, number inputs, dropdown, and text input for all 8 settings. Changes save instantly.
- **Log level descriptions updated** — `normal` enum description now accurately reflects the silent-during-healthy-polls behavior.

### 1.18.0 — Log Cleanup

- **Default log level changed to `normal`** — was `verbose` (both in code and manifest). Normal shows one-line poll summaries (~2 lines/tick). Verbose remains available for debugging.
- **Promotional banner moved to click-to-view** — the periodic `Visit helm-agent.com` message no longer injects into the log stream every 20 lines. Instead, a clean branded banner appears once when the user clicks the debug status bar button to open the output channel.
- **Removed `_logLineCount` tracking** — no longer needed since the ad is no longer periodic.

### 1.17.0 — Simplified Error Recovery

**Architecture: 3-state machine replaces retry/backoff system.** The entire error response pipeline was replaced with a clean state machine:

```
MONITORING → error detected → WAITING_IDLE (if busy) or COOLDOWN (if idle)
WAITING_IDLE → agent goes idle → COOLDOWN
COOLDOWN → postSendCooldownMs expires → send "Continue" → MONITORING
(repeat forever — no limits)
```

The previous system used exponential backoff (`retryDelayMs × 2^retries`, capped at `maxBackoffMs`), a max retry limit (`maxRetries`, default 30), a recovery detection mechanism (agent busy >10s = recovered → reset counter), and a post-send cooldown to prevent false recovery declarations. All of this has been removed in favor of a simpler invariant: **wait for !busy, wait cooldown, send, repeat**.

**Removed class fields:**
- `_consecutiveRetries` — retry counter (no longer needed, retries are unlimited)
- `_lastRetrySentAt` — timestamp for backoff calculation
- `_recoveryCooldownUntil` — post-send recovery window
- `_capturedThisSession` → renamed to `_capturedThisCycle` (resets per error cycle, not per session)
- `_stats.recoveries` — recovery counter removed from `SessionStats`

**New class fields:**
- `_errorState: 'monitoring' | 'waiting_idle' | 'cooldown'` — current phase of the state machine
- `_cooldownStartedAt: number` — when the cooldown timer started

**Removed settings** (from `package.json` configuration):
- `helmAutoContinue.maxRetries` — no longer applicable (retries are unlimited)
- `helmAutoContinue.retryDelayMs` — no longer applicable (no backoff)
- `helmAutoContinue.maxBackoffMs` — no longer applicable (no backoff)

**Repurposed `postSendCooldownMs`** — Previously acted as a post-send window to prevent false recovery. Now acts as the pre-send cooldown: the wait time after the agent goes idle before sending Continue. Same default (15s), different role.

**Status bar changes:**
- Main button: `$(sync~spin) Auto Continue (N)` → `$(sync~spin) Auto Continue (waiting|cooldown)` — shows current phase instead of retry count
- Debug bar: removed `Recovered` and `Retries` lines from tooltip, added `Phase` line showing error state
- Debug bar background: `WAIT_IDLE` and `COOLDOWN` states now show error (red) background

**`_tick()` reduced from ~180 to ~90 lines** — the entire method is now a switch statement over three states with no nested conditionals for backoff, recovery detection, or cooldown reset guards.

**Bug fix: stale `_consecutiveRetries` reference** — The focus probe's `shouldRestore` logic (`_probeForError`) still referenced `this._consecutiveRetries === 0` to decide whether to restore editor focus. Fixed to use `this._errorState === 'monitoring'`.

### 1.16.0

- **Fixed broken error detection** — The `getDiagnostics` payload evolved: `mainThreadLogs` changed from a flat string/array to a nested object (`{ cloudcode: string[], auth: string[], 'ls-main': string[] }`). The old `_extractLogEntries` merged all sub-fields into one flat array under a single tracking key, making incremental index tracking unreliable when sub-field ordering changed between calls. Rewrote log extraction to produce separate tracked sources per leaf (e.g., `mainThreadLogs.ls-main`) so each source has its own stable index. Also handles `rendererLogs` which uses the same nested format. `agentWindowConsoleLogs` is now NULL in the payload — all errors appear in `mainThreadLogs.ls-main`.

### 1.15.1

- **Fixed cooldown killing busy recovery** — The v1.15.0 cooldown reset ran unconditionally on every error tick, including when the agent was busy recovering. Because the cooldown was freshly set in the same tick, the busy recovery check (`Date.now() < _recoveryCooldownUntil`) was always true — making the entire ERROR+BUSY recovery path dead code. The extension would never declare recovery and keep retrying until maxRetries. Fix: only reset cooldown when agent is idle (`!isBusy`).
- **Fixed `idleTimeoutSeconds` code fallback** — Code default was `45` but manifest default is `0` (disabled). Aligned code fallback to `0` to match.

### 1.15.0

- **Fixed false recovery race condition** — cooldown timer now resets every time an error is detected during a retry cycle. Recovery can only be declared after `postSendCooldownMs` of *consecutive clean* ticks, preventing the case where S0 consumes a re-error (advancing log indices) and then falsely declares recovery once the original cooldown expires.
- **IDLE status bar cleanup** — shows just `IDLE` with default background instead of `IDLE(Ns)` in gold. Seconds remain visible in hover tooltip and verbose logs.
- **Output channel ad** — periodic `Visit helm-agent.com` message every 20 log lines.

### 1.14.0

- **Fixed `focusProbe` code default** — now correctly defaults to `false` (matching manifest)
- **Fixed `_trackIdleState` not called on every tick** — S1 now tracks busy state even when no error is detected
- **Fixed `errorsDetected` undercounting** — errors during ERROR+BUSY recovery are now counted
- **Fixed IDLE state debug bar color** — IDLE no longer shows warning (yellow) background

### 1.13.0

- **Three-tier log levels** — `minimal`, `normal`, `verbose` replaces verbose boolean. Normal mode shows one-line poll summaries.

### 1.12.0

- **Post-send recovery cooldown** — prevents false recovery when agent 503s immediately after processing Continue.

### 1.11.0

- **Session-aware trajectory** — stale conversations from previous sessions don't trigger stall detection.
- **Diagnostic capture** — full getDiagnostics payload saved to `.helm-diag/` on first error per cycle.

### 1.10.0

- **Cold-start guard** — idle timeout only fires after agent activity has been observed (`_everSeenBusy` flag).
- **First-scan snapshot** — log indices initialized to current lengths on startup, preventing false positives from historical logs.

### 1.9.0

- **Trajectory stall detection** — monitors `recentTrajectories[0].lastStepIndex` for frozen step counters.
- **`diagnosticsFrequency` setting** — configurable polling frequency for getDiagnostics.

### 1.8.0

- **Idle timeout refinements** — `_busyStart` tracking for sustained busy duration.

### 1.7.0

- **Idle timeout strategy** — monitors `chatSessionRequestInProgress` transitions.

### 1.6.0

- **Focus restoration improvements** — skip restoration when output channel has focus.

### 1.5.0

- **Focus probe with 4 sub-strategies** — tries multiple focus commands to bring context keys into scope.

### 1.4.0

- **getDiagnostics error detection** — Strategy 0 added. Parses `agentWindowConsoleLogs` and `languageServerLogs` for error patterns.

### 1.3.0

- **Debug status bar** — second status bar item showing current detection state.
- **Session statistics** — tracks polls, errors, continues, recoveries.

### 1.2.0

- **Exponential backoff** — `retryDelayMs × 2^retries` with configurable ceiling.
- **Sustained recovery detection** — agent must be busy >10s before declaring recovery.

### 1.1.0

- **Manual error trigger** — New `Report Chat Error` command for guaranteed fallback
- **Configurable continue prompt** — `continuePrompt` setting
- **Fixed timer overlap** — `setTimeout` loop replaces `setInterval`
- **Config change listener** — `intervalSeconds` changes take effect immediately
- **Debounced notifications** — Only after 2+ retries
- **Cross-extension context keys** — `helmAutoContinue.isActive` and `.isRetrying`
- **Removed keyboard shortcut** — Status bar is the primary toggle
- **Documented context key scoping** — Explained why detection requires chat focus

### 1.0.0

- Initial release

---

## License

MIT License — Copyright (c) 2026 Antigravity

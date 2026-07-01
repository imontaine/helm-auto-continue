# Changelog

## v1.34.3

### Bug Fix — CDP Auto Clicker never actually clicked anything

- **`ws` WebSocket package is now bundled** — The `_wsEval` method previously
  used `try { require('ws') } catch { ... }` to load the WebSocket library at
  runtime. This always fails in a bundled VS Code extension because esbuild's
  module resolution replaces `require()` at build time. Since `ws` was not in
  `node_modules`, the require threw and the fallback `globalThis.WebSocket`
  also didn't exist in the Node.js extension host, so `_wsEval` always
  resolved `null` — meaning OBSERVER_JS was never injected and no buttons
  were ever clicked.

  Fixed by: `npm install ws`, adding `import WebSocket from 'ws'` at the top
  of `extension.ts`, and rewriting `_wsEval` to use the typed static import
  directly. esbuild now bundles `ws` into `dist/extension.js` (bundle size
  67 KB → 143 KB production). The `require('ws')` fallback path is removed.

## v1.34.2

### Bug Fix — CDP Auto Clicker toggle appears to do nothing

- **Toggle now responds instantly** — `start()` now calls `pushCdpStatus()`
  immediately after setting `_enabled = true`, so the settings panel receives
  `{ enabled: true }` right away and the toggle snaps to ON without waiting for
  the first port-probe cycle to complete.

- **First cycle no longer blocks on process detection** — `_probeCycleCount`
  now initialises to `1` instead of `0`, so `1 % 5 === 1` is not true on the
  very first cycle. The slow `_detectAgProcess()` subprocess (`tasklist`, up to
  4 s on Windows) is skipped on the first cycle and fires naturally on cycle 5
  (~10 s after start). Previously, the toggle appeared dead because the very
  first `pushCdpStatus({ enabled: true })` was blocked behind this subprocess
  call.

## v1.34.1

### Bug Fix — CDP Auto Clicker toggle

- **CDP toggle now works correctly** — The settings page catch-all toggle
  handler (`.toggle input:not(#monitorToggle)`) also matched `#cdpToggle`,
  causing it to send a redundant `updateSetting` message with the wrong key
  (`cdpToggle` instead of `cdpAutoClick`) alongside the correct `toggleCdp`
  message. This made the toggle appear to do nothing because VS Code could not
  find `helmAutoContinue.cdpToggle` in the schema. Fixed by excluding
  `#cdpToggle` from the catch-all selector
  (`.toggle input:not(#monitorToggle):not(#cdpToggle)`).

## v1.34.0

### New Feature — CDP Auto Clicker

Adds an independent CDP (Chrome DevTools Protocol) DOM-injection auto-clicker
that runs alongside the existing error-recovery monitor.

- **Automatic button clicking** — Injects a `MutationObserver` script into
  every Antigravity webview and clicks `Run`, `Accept`, `Accept All`, `Allow`,
  `Always Allow`, `Apply`, `Approve`, `Retry`, `Continue`, and `Confirm` buttons
  as they appear, keeping the AI agent running unattended.

- **CDP DOM injection engine** — Uses Chrome DevTools Protocol
  (`--remote-debugging-port=9333`) to reach Antigravity's Electron renderer
  process directly. Probes ports `9333`, `9222`, `9000`, `5229` in order;
  tries `127.0.0.1` before `localhost` to avoid Windows IPv6 resolution issues.

- **Original observer script** — `OBSERVER_JS` is written fresh with a
  position-key cooldown system that survives React DOM re-renders: buttons are
  identified by screen-coordinate fingerprint (quantised to a 30px grid) + label
  prefix, so a reconstructed element at the same location is recognised and
  blocked until it disappears from the DOM.

- **Cross-target deduplication** — An 8-second label-based dedup window prevents
  the same physical click from being counted multiple times when OBSERVER_JS
  is injected into several open webview panels simultaneously.

- **Antigravity process detection** — Every ~10 seconds checks whether
  Antigravity is actually running (`tasklist` on Windows, `pgrep` on macOS/Linux)
  and surfaces the result in the settings panel status badge.

- **Status bar counter** — A new `$(mouse) AutoClick N` status bar item shows
  the session click count (resets to 0 on each start). Clicking it opens the
  settings page.

- **Settings page integration** — A new "CDP Auto Clicker" toggle card appears
  in the settings panel (same style as the existing monitoring card) with:
  - Live port-connection status badge (Connected / AG running — no debug port /
    Antigravity not detected)
  - Session click counter
  - One-time setup instructions for adding `--remote-debugging-port=9333` to
    the Antigravity shortcut on Windows and via terminal on macOS/Linux
  - List of all buttons that are clicked automatically

- **KILL_JS teardown** — When stopped, a teardown script is injected into all
  reachable targets to disconnect the `MutationObserver` and self-terminate the
  polling loop.

- **Fully independent** — No auth, no quota, no heartbeat, no binary detection,
  no auto-relaunch. Enable/disable from the settings page; state is persisted to
  the `helmAutoContinue.cdpAutoClick` config key.

## v1.33.0

### Improvements

- **Developer Tools Interface Cleanup** — Removed the synthetic test buttons
  from the Settings webview panel and replaced them with user documentation
  instructing how to execute test commands via the VS Code Command Palette
  (`Ctrl+Shift+P` / `Cmd+Shift+P`). This simplifies the UI while retaining
  the live diagnostic log console.

## v1.32.0

### Improvements

- **Local Window Scoped Trajectory Binding** — Scoped trajectory binding to
  the local window's active state using the window-scoped
  `chatSessionRequestInProgress` context key. This prevents idle windows from
  binding to active trajectories in other VS Code windows and falsely entering
  the "Busy" state.

## v1.31.0

### Improvements

- **Test commands in Command Palette** — `Run Full Test`,
  `Simulate Error (Test)`, and `Mark Window Active (Test)`
  are now registered in the `commandPalette` menu and
  accessible via `Ctrl+Shift+P`. Previously they were only
  callable from the settings webview.
- **Developer Tools documentation** — Added a dedicated
  section to the README with step-by-step instructions for
  running the test pipeline from the Command Palette,
  replacing the non-functional artifact buttons.
- **Command names updated in README** — Commands table
  now uses the actual registered titles
  (`Antigravity Recovery Auto Continue: ...`).

## v1.30.1

### Bug Fixes

- **"Run Full Test" ordering bug** — `_everSeenBusy` was set
  *before* calling `start()`, which resets it to `false`.
  The Window Scope Recovery gate then suppressed the
  simulated error. Reordered to set `_everSeenBusy = true`
  after `start()`.
- **Test suppressed when already monitoring** — If
  monitoring was already running and the agent had been
  idle > 300s, the recovery timeout gate would silently
  swallow the simulated error. Now resets `_idleSince`,
  `_errorState`, and `_capturedThisCycle` when already
  running.
- **No feedback from command palette** — Added
  `showInformationMessage` so "Run Full Test" gives visible
  feedback even when the settings panel isn't open.

## v1.28.0

### Bug Fixes

- **Simulate Error now works without getDiagnostics** — The simulated error flag was only consumed inside `_checkDiagnostics()`, which was gated by `_diagnosticsAvailable`. If `antigravity.getDiagnostics` wasn't available, the flag was never consumed and the button appeared broken. Now `_simulatedErrorPending` bypasses the availability gate.
- **Simulate Error no longer requires Mark Active first** — `simulateError()` now sets `_everSeenBusy = true` automatically, so Window Scope Recovery doesn't suppress the simulated error in a fresh window.

## v1.27.0

### Bug Fixes

- **Fixed `_everSeenBusy` circular dependency** — Busy detection via diagnostics (`diagBusy`) was gated by `_everSeenBusy`, which itself could only become `true` from `_trackIdleState(isBusy)` — creating a dead loop where neither could ever activate from diagnostics alone. Now, a trajectory step-index change sets `_everSeenBusy = true` directly, since it's direct proof the agent ran. This fixes:
  - Status bar never showing **BUSY** state
  - **Simulate Error** button appearing to do nothing (error was detected but suppressed by Window Scope Recovery since `_everSeenBusy` was always `false`)
  - **Mark Active** button only working if pressed *before* Simulate Error

## v1.24.0

### New Setting

- **Busy Window** (`busyWindowSeconds`, default 60s) — How long after the last observed step-index change the agent is still considered "recently active". Previously this was a hidden derived value (based on idle timeout, minimum 60s). Now it's a first-class setting in the Timing section of the settings panel. Raise it if your tasks include slow tool calls (large file writes, long builds) that stall the step index for longer than a minute.

## v1.23.0


### Improvements — Busy Detection Overhaul

- **Step history buffer** — Replaced the single `_stepIndexLastChanged` timestamp with a circular buffer of the last 8 `(timestamp, stepIndex)` observations. This gives two clean signals: `isBusy` (did the step index advance on *this* poll?) and `isRecent` (did it advance at any point within the busy window?). Stall detection now works directly on the history buffer.

- **`isBusy` vs `isRecent` separation** — `ProbeResult` now carries both fields. `WAITING_IDLE` transitions to COOLDOWN only when `isRecent` goes false, not just when a single poll returns idle. Prevents premature COOLDOWN transitions during long tool calls where the step index may not tick every poll.

- **Trajectory binding on first step-change** — Binding no longer requires `_everSeenBusy` as a gate. Fires on the first step-index change from a session-timestamp-matching trajectory — a direct proof of activity, stronger than any timestamp guard.

- **`agentStateDebug.conversations` probed** — The diagnostics payload's `agentStateDebug.conversations` map is now checked for entries in an active/running state. When found, both `diagBusy` and `diagRecent` are boosted, providing a direct in-engine activity signal independent of `lastModifiedTime` heuristics.

## v1.22.0


### Improvements — Busy Detection Overhaul

- **Step history buffer** — Replaced the single `_stepIndexLastChanged` timestamp with a circular buffer of the last 8 `(timestamp, stepIndex)` observations. This gives two clean signals: `isBusy` (did the step index advance on *this* poll?) and `isRecent` (did it advance at any point within the busy window?). Stall detection now works directly on the history buffer — no separate tracking variable needed.

- **`isBusy` vs `isRecent` separation** — `ProbeResult` now carries both fields. `WAITING_IDLE` transitions to COOLDOWN only when `isRecent` goes false (agent no longer progressing within the busy window), not just when a single poll returns idle. This prevents premature COOLDOWN transitions during long tool calls where the step index may not tick every poll.

- **Trajectory binding on first step-change** — Previously the extension required `_everSeenBusy` before it would bind to a trajectory ID, creating a window where any trajectory could be mistaken for ours. Now binding fires on the *first* step-index change from a session-timestamp-matching trajectory — a step change is direct proof of activity, stronger than any timestamp guard.

- **`agentStateDebug.conversations` probed** — The diagnostics payload's `agentStateDebug.conversations` map is now checked for entries with `status === 'running'`, `status === 'active'`, or `isActive === true`. When found (and this window has been busy before), both `diagBusy` and `diagRecent` are boosted. This provides a direct activity signal independent of `lastModifiedTime` or step-index inference.

## v1.21.4


### Bug Fixes

- **Cross-window busy false positive (trajectory ID binding)** — Idle windows no longer show BUSY when another VS Code window's agent is active. Two guards added: (1) `diagBusy` now requires `_everSeenBusy` — a window that has never had its own agent active will never report busy from shared trajectory data; (2) once this window's agent goes active, it binds to that specific `googleAgentId` and ignores all other trajectories. The verbose log now shows `everBusy`, `bound`, and `isOurs` fields for easier cross-window debugging.

## v1.21.3

### Changes

- **Renamed** extension to "Antigravity Recovery Auto Continue" — updated display name, command titles, settings section, output channel, notifications, and settings webview.
- **Removed** helm-agent.com promo banner from the output channel log view and the settings webview.

## v1.21.2

### Bug Fixes

- **Window-scoped busy detection** — `diagBusy` is now gated by `trajectoryIsFromThisSession`. Previously, an active agent in another VS Code window could cause this idle window to show BUSY in the status bar because `trajectories[0]` from the global diagnostics payload was used without checking whether its `lastModifiedTime` was after this window's monitoring session started.

## v1.21.0

### New Features

- **Window Scope Recovery** — New toggle (default ON) that prevents cross-window error leaking when multiple VS Code windows share the same Antigravity backend. Only fires Continue if this window's agent was recently active.
- **Recovery Timeout** — New setting (default 300s) that suppresses error detection when the agent has been idle too long. Prevents stale windows from reacting to old errors.
- **Non-retryable error suppression** — Detects "Insufficient AI Credits" and similar billing errors, stops monitoring entirely instead of retrying forever.
- **Editable patterns** — Error patterns (trigger Continue) and suppress patterns (stop monitoring) are now configurable string arrays, editable via the settings panel textareas or `settings.json`.

### Changes

- **Post-send cooldown** default increased from 5s → 10s for more reliable recovery.

## v1.20.0

- Diagnostics-based error detection via `antigravity.getDiagnostics` log parsing
- Context key inspection for `chatSessionResponseError`
- Focus probe with response navigation
- Idle timeout tracking with cold-start guard
- Session-aware trajectory stall detection
- Manual error reporting command
- Settings webview panel with live controls
- Diagnostic capture on first error per cycle
- Three-tier chat dispatch (native API → VS Code Chat → clipboard fallback)

## v1.0.0

- Initial release

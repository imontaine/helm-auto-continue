# Helm — Antigravity Auto Continue

A lightweight Antigravity extension that automatically detects chat API errors (503, rate limits, capacity exhaustion) and sends a configurable prompt to resume the AI agent — so you never have to babysit a stalled conversation.

---

## The Problem

When using Antigravity, the underlying model APIs occasionally fail mid-response with transient errors:

- **HTTP 503** — service temporarily unavailable
- **MODEL_CAPACITY_EXHAUSTED** — the model is overloaded
- **Rate limiting** — too many requests in a short window
- **High traffic** — servers are experiencing high traffic, try again in a minute
- **Agent terminated** — agent terminated due to error
- **Retry prompt** — you can prompt the model to try again or start a new conversation
- **HTTP 503 Service Unavailable** — raw status code response

When this happens, the agent stops and the conversation hangs. You have to manually notice the failure, type "Continue", and wait. If it happens at 2 AM while you're AFK, your agent is dead in the water until you come back.

## The Solution

**Helm Auto Continue** monitors for chat errors using multiple detection strategies and automatically sends a configurable prompt to resume the agent. It includes safety rails for multi-window environments and non-retryable error detection to prevent wasted retries.

## Limitations

**This extension is not intended to replace auto-all extensions.** There are many auto-all extensions; this is intended to work alongside those extensions by recovering from errors that they may not be able to recover from.

---

## Getting Started

### How to use the extension

After you install the extension, you will see two buttons on the bottom of Antigravity — one is the toggle button and the other is the log button. The toggle button will start and stop the extension; the log button will open the output channel.

## How It Works

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

### Multi-Window Isolation (v1.21.0)

When multiple VS Code windows are open, each running its own workspace, the underlying Antigravity backend shares a single diagnostics log pool across all windows. A 503 error in Window A would previously trigger auto-continue in **both** windows.

**Window Scope Recovery** (enabled by default) solves this by requiring that the agent in a given window was actually observed as busy before allowing error recovery to fire. If Window B's agent was never active, it won't react to errors that belong to Window A.

**Recovery Timeout** adds a second safeguard: if the agent has been idle for longer than a configurable threshold (default 300 seconds), error detection is suppressed entirely. This prevents stale windows from firing on old errors.

### Non-Retryable Error Suppression (v1.21.0)

Some errors — like "Insufficient AI Credits" — are not transient. Retrying won't help. When the extension detects a non-retryable error in the logs, it **stops monitoring entirely** and shows a warning notification. This prevents wasted continue attempts when the real fix requires user action (e.g., adding credits).

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

After detecting an error, the extension waits for the agent to go idle, then waits a configurable cooldown period (default 10s) before sending "Continue". This ensures the system has fully stabilized before issuing a new prompt.

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
| `Antigravity Recovery Auto Continue: Toggle` | Start or stop monitoring |
| `Antigravity Recovery Auto Continue: Start` | Start monitoring |
| `Antigravity Recovery Auto Continue: Stop` | Stop monitoring |
| `Antigravity Recovery Auto Continue: Show Log` | Open the output channel |
| `Antigravity Recovery Auto Continue: Report Chat Error` | Manually trigger error recovery |
| `Antigravity Recovery Auto Continue: Settings` | Open the settings panel |
| `Antigravity Recovery Auto Continue: Run Full Test` | Run the complete test pipeline (mark active + simulate error) |
| `Antigravity Recovery Auto Continue: Simulate Error (Test)` | Queue a synthetic 503 error for the next poll |
| `Antigravity Recovery Auto Continue: Mark Window Active (Test)` | Bypass window scope recovery for testing |

### Quick Start

1. Install the extension — it starts monitoring automatically
2. Start your AI agent
3. If it hits a transient error, auto-continue detects it via log parsing and triggers automatically
4. If detection fails for any reason, run `Antigravity Recovery Auto Continue: Report Chat Error` (Ctrl+Shift+P) to trigger recovery manually

---

## Developer Tools

Three test commands are available from the Command Palette (`Ctrl+Shift+P`) to exercise the error recovery pipeline without waiting for a real API failure.

### Run Full Test (recommended)

1. Open the Command Palette (`Ctrl+Shift+P`)
2. Search for **"Antigravity Recovery Auto Continue: Run Full Test"**
3. The command will:
   - Auto-start monitoring if it's stopped
   - Mark the window as active (bypasses Window Scope Recovery)
   - Queue a synthetic 503 error
4. Watch the pipeline trace in the Output channel (`Antigravity Recovery Auto Continue: Show Log`)
5. Expected flow: `detect error → COOLDOWN → send Continue`

### Individual Test Commands

| Command | What it does |
|---|---|
| **Mark Window Active (Test)** | Sets `_everSeenBusy = true` so Window Scope Recovery doesn't suppress errors. Run this first if testing individual commands in a fresh window. |
| **Simulate Error (Test)** | Queues a synthetic "503 error" that fires on the next diagnostics poll. Triggers the full detect → cooldown → send pipeline. |

### Testing Tips

- Set `logLevel` to `verbose` before testing to see full per-strategy diagnostics
- Set `postSendCooldownMs` to `1000` (1s) for faster test cycles
- Open the output channel **before** running the test to watch the pipeline in real-time
- The settings webview panel also shows a live test console if open during the test

---

## Configuration

All settings under `helmAutoContinue.*`:

### Core

| Setting | Type | Default | Description |
|---|---|---|---|
| `intervalSeconds` | number | `5` | Polling interval (seconds). Min: 3. |
| `continuePrompt` | string | `"Continue"` | The message sent to the chat panel. |
| `startOnActivation` | boolean | `true` | Auto-start when VS Code launches. |
| `windowScopeRecovery` | boolean | `true` | Only fire Continue if this window's agent was recently active. Prevents cross-window false positives. |

### Timing

| Setting | Type | Default | Description |
|---|---|---|---|
| `postSendCooldownMs` | number | `10000` | Cooldown (ms) after agent goes idle before sending Continue. |
| `idleTimeoutSeconds` | number | `0` | Seconds of inactivity after being busy before triggering. 0 = disabled (recommended). |
| `recoveryTimeoutSeconds` | number | `300` | Don't fire Continue if the agent has been idle longer than this (seconds). 0 = disabled. |

### Detection

| Setting | Type | Default | Description |
|---|---|---|---|
| `diagnosticsFrequency` | number | `1` | Run getDiagnostics log parsing every Nth poll tick. Higher = less overhead but slower detection. |
| `focusProbe` | boolean | `false` | Briefly focus chat panel to read context keys. Disabled by default (causes flickering). |

### Patterns

| Setting | Type | Default | Description |
|---|---|---|---|
| `errorPatterns` | string[] | *(see below)* | Regex patterns (case-insensitive) that trigger auto-continue. |
| `suppressPatterns` | string[] | *(see below)* | Regex patterns (case-insensitive) for non-retryable errors that stop monitoring. |

### Logging

| Setting | Type | Default | Description |
|---|---|---|---|
| `logLevel` | string | `"minimal"` | `minimal` (events only), `normal` (+ state changes), `verbose` (full per-strategy diagnostics). |

---

## Error Patterns (trigger Continue)

These patterns are matched (case-insensitive) against new log entries. When matched, auto-continue fires. Editable via settings.

```
\b503\b, rate limit, capacity exhaust, model capacity,
overloaded, too many requests, service unavailable,
quota exceeded, temporarily unavailable, RESOURCE_EXHAUSTED,
server error, internal server error, high traffic,
try again in, please try again, experiencing high,
No capacity available, MODEL_CAPACITY_EXHAUSTED
```

## Suppress Patterns (stop monitoring)

These patterns match non-retryable errors. When detected, monitoring **stops entirely** and a warning notification is shown. Editable via settings.

```
insufficient ai credits, insufficient credits,
no credits remaining, billing required,
payment required, subscription expired
```

---

## Safety Rails

- **Window Scope Recovery** — Only fires if this window's agent was recently active (prevents cross-window leaking)
- **Recovery Timeout** — Suppresses recovery after extended idle periods (default 300s)
- **Non-retryable suppression** — Stops monitoring on billing/credit errors instead of retrying forever
- **Wait-for-idle** — Never sends Continue while the agent is actively processing
- **Cooldown timer** — Waits `postSendCooldownMs` after agent goes idle before sending
- **Unlimited retries** — Keeps retrying as long as transient errors occur (no retry limit)
- **Cold-start guard** — Idle timeout only fires after agent activity has been observed
- **Session-aware trajectory** — Stale conversations from previous sessions don't trigger false stalls
- **Sequential timer** — `setTimeout` loop prevents overlapping ticks
- **Diagnostic capture** — Full log payload saved on first error per cycle for debugging

---

## Changelog

### v1.21.0

- **Window Scope Recovery** — New toggle (default ON) that prevents cross-window error leaking when multiple VS Code windows share the same Antigravity backend
- **Recovery Timeout** — New setting (default 300s) that suppresses error detection when the agent has been idle too long
- **Non-retryable error suppression** — Detects "Insufficient AI Credits" and similar billing errors, stops monitoring instead of retrying
- **Editable patterns** — Error patterns and suppress patterns are now configurable string arrays editable via the settings panel or `settings.json`
- **Post-send cooldown** — Default increased from 5s to 10s for more reliable recovery

## License

MIT License — Copyright (c) 2026 Antigravity

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

**Helm Auto Continue** monitors for chat errors using multiple detection strategies and automatically sends a configurable prompt to resume the agent. It uses exponential backoff to space retries intelligently and includes safety rails to prevent infinite retry loops.

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

After detecting an error, the extension waits for the agent to go idle, then waits a configurable cooldown period (default 5s) before sending "Continue". This ensures the system has fully stabilized before issuing a new prompt.

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
| `postSendCooldownMs` | number | `5000` | Cooldown (ms) after agent goes idle before sending Continue. |
| `diagnosticsFrequency` | number | `1` | Run getDiagnostics log parsing every Nth poll tick. Higher = less overhead but slower detection. |
| `idleTimeoutSeconds` | number | `0` | Seconds of inactivity after being busy before triggering. 0 = disabled (recommended). |
| `focusProbe` | boolean | `false` | Briefly focus chat panel to read context keys. Disabled by default (causes flickering). |
| `logLevel` | string | `"minimal"` | `minimal` (events only), `normal` (+ one-line poll summaries), `verbose` (full per-strategy diagnostics). |

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

## Antigravity Error Patterns

The diagnostics log scanner matches these patterns (case-insensitive):

```
503, rate limit, capacity exhaust, model capacity,
overloaded, too many requests, service unavailable,
quota exceeded, temporarily unavailable, RESOURCE_EXHAUSTED,
server error, internal server error, high traffic,
try again in, please try again, experiencing high,
No capacity available, MODEL_CAPACITY_EXHAUSTED
```

## License

MIT License — Copyright (c) 2026 Antigravity

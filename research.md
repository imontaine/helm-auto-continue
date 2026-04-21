# Deep Research: Antigravity Chat Error Detection

## Executive Summary

Three previously undiscovered strategies for detecting chat errors programmatically inside the Antigravity IDE have been found by reverse-engineering three community extensions:

| Strategy | Source Extension | Reliability | Complexity | Invasiveness |
|---|---|---|---|---|
| **1. `getDiagnostics` log parsing** | Better Antigravity (antigravity-sdk) | ⭐⭐⭐⭐ | Low | None |
| **2. Language Server quota API** | AG Quota (henrikdev) | ⭐⭐⭐⭐⭐ | Medium | Low |
| **3. CDP DOM injection** | auto-all-Antigravity | ⭐⭐⭐⭐⭐ | High | High |

> [!IMPORTANT]
> **Strategy 1 is the recommended starting point** — it requires no process discovery, no CDP ports, and works through the standard `vscode.commands.executeCommand()` API.

---

## Strategy 1: `antigravity.getDiagnostics` Command

### Discovery

The `antigravity-sdk` (used by Better Antigravity v0.8.0) documents that `antigravity.getDiagnostics` returns a **176KB JSON payload** containing system info, all log streams, and recent conversation trajectories.

### What It Returns

```typescript
interface DiagnosticsPayload {
  isRemote: boolean;
  systemInfo: {
    operatingSystem: string;
    timestamp: string;
    userEmail: string;
    userName: string;
  };
  extensionLogs: any[];           // Array[375+] - extension log entries
  rendererLogs: string;           // Renderer process logs
  mainThreadLogs: string;         // Main thread logs  
  agentWindowConsoleLogs: string; // ← CHAT ERRORS APPEAR HERE
  languageServerLogs: string;     // ← LS errors (503s, rate limits)
  recentTrajectories: Array<{     // Last 10 conversations
    googleAgentId: string;        // Conversation UUID
    trajectoryId: string;         // Internal trajectory ID
    summary: string;              // Human-readable title
    lastStepIndex: number;        // Step count (0-based)
    lastModifiedTime: string;     // ISO timestamp
  }>;
}
```

### How to Use It

```typescript
// Call from ANY extension — no special permissions needed
const raw = await vscode.commands.executeCommand('antigravity.getDiagnostics');
if (raw && typeof raw === 'string') {
  const diag = JSON.parse(raw);
  
  // Strategy A: Parse agent window logs for error strings
  const agentLogs = diag.agentWindowConsoleLogs || '';
  const hasError = /503|rate.?limit|capacity|exhausted|error/i.test(agentLogs);
  
  // Strategy B: Parse LS logs for API failures
  const lsLogs = diag.languageServerLogs || '';
  const hasLsError = /503|rate.?limit|capacity/i.test(lsLogs);
  
  // Strategy C: Monitor trajectory step count
  // If lastStepIndex stops incrementing while agent was working → error
  const activeConvo = diag.recentTrajectories?.[0];
  const currentSteps = activeConvo?.lastStepIndex ?? 0;
}
```

### Pros & Cons

| ✅ Pros | ❌ Cons |
|---|---|
| Standard VS Code command API | Returns ALL logs (176KB) — must parse efficiently |
| No external process discovery | Log data is string blobs, not structured |
| No CDP port required | May have stale data if not polled frequently |
| Works immediately with no setup | Payload is large — don't poll too fast |

### Source Evidence

From [Better Antigravity dist/extension.js](file:///C:/Users/Work/.antigravity/extensions/kanezal.better-antigravity-0.8.0-universal/dist/extension.js) line 1878:
```javascript
async getDiagnostics() {
  const raw = await this._commands.execute(AntigravityCommands.GET_DIAGNOSTICS);
  // ... returns 176KB JSON with system info, logs, trajectories
}
```

---

## Strategy 2: Language Server Internal HTTP API

### Discovery

Both **AG Quota** (henrikdev) and **Better Antigravity** discover the Antigravity language server process, extract its CSRF token, and make authenticated HTTP requests to its internal ConnectRPC API.

### Process Discovery

The language server runs as `language_server_windows_x64.exe` and exposes:
- `--csrf_token=<token>` on the command line
- `--extension_server_port=<port>` on the command line
- Multiple LISTENING ports: HTTPS (ConnectRPC), HTTP, LSP

Discovery steps (from [AG Quota process_finder.ts](file:///C:/Users/Work/.antigravity/extensions/henrikdev.ag-quota-1.1.0-universal/src/core/process_finder.ts)):

```typescript
// 1. Find the LS process and extract args
const cmd = `wmic process where "name='language_server_windows_x64.exe'" get ProcessId,CommandLine /format:csv`;
// Parse: --csrf_token=<token>, --extension_server_port=<port>, PID

// 2. Find listening ports for that PID
const cmd = `netstat -aon | findstr "LISTENING" | findstr "${pid}"`;
// Filter out extension_server_port, keep the HTTPS port

// 3. Test port with ConnectRPC health check
const url = `https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUnleashData`;
// POST with X-Codeium-Csrf-Token header
```

### Available API Endpoints

| Endpoint | Returns | Use Case |
|---|---|---|
| `GetUserStatus` | Model quotas, remaining fractions, reset times, prompt credits | **Check if model is exhausted** |
| `GetUnleashData` | Feature flags | Health check / validation |

### Quota Response Structure

From [AG Quota quota_manager.ts](file:///C:/Users/Work/.antigravity/extensions/henrikdev.ag-quota-1.1.0-universal/src/core/quota_manager.ts):

```typescript
interface UserStatusResponse {
  userStatus: {
    planStatus: {
      planInfo: { monthlyPromptCredits: string };
      availablePromptCredits: string;
    };
    cascadeModelConfigData: {
      clientModelConfigs: Array<{
        label: string;                    // e.g., "Claude 3.5 Sonnet"
        modelOrAlias: { model: string };  // model ID
        quotaInfo: {
          remainingFraction: number;      // 0.0 = EXHAUSTED ← KEY SIGNAL
          resetTime: string;              // ISO timestamp for reset
        };
      }>;
    };
  };
}
```

### Error Detection via Quota

```typescript
// If remainingFraction === 0, the model is exhausted → will cause 503/capacity errors
const exhaustedModels = models.filter(m => m.quotaInfo.remainingFraction === 0);
if (exhaustedModels.length > 0) {
  // Pre-emptively wait until reset time instead of retrying blindly
  const nextReset = Math.min(...exhaustedModels.map(m => 
    new Date(m.quotaInfo.resetTime).getTime() - Date.now()
  ));
  log(`Model exhausted. Waiting ${nextReset}ms until reset.`);
}
```

### Pros & Cons

| ✅ Pros | ❌ Cons |
|---|---|
| Detects quota exhaustion BEFORE errors occur | Requires process discovery (platform-specific) |
| Structured JSON response | Needs CSRF token from command line args |
| Lightweight polling (small payloads) | HTTPS with self-signed cert (rejectUnauthorized: false) |
| Can calculate exact reset time | Token may change on LS restart |

---

## Strategy 3: CDP (Chrome DevTools Protocol) Injection

### Discovery

**auto-all-Antigravity** (v1.0.28) uses CDP to connect directly to Antigravity's Electron renderer process, inject JavaScript into the DOM, and observe/interact with chat UI elements.

### How It Works

From [cdp-handler.js](file:///C:/Users/Work/.antigravity/extensions/ai-dev-2024.auto-all-antigravity-1.0.28-universal/main_scripts/cdp-handler.js):

1. **Scan ports 9000-9030** for CDP debug endpoints: `GET http://127.0.0.1:{port}/json/list`
2. **Connect via WebSocket** to `page.webSocketDebuggerUrl`
3. **Inject script** via `Runtime.evaluate`
4. **Execute arbitrary JS** in the renderer context

```typescript
// Scan for available CDP pages
const pages = await http.get(`http://127.0.0.1:${port}/json/list`);
// Each page has: { id, webSocketDebuggerUrl, title, ... }

// Connect and inject
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    expression: `
      // Full DOM access — can watch for error messages
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.textContent?.match(/503|error|rate limit/i)) {
              window.__helmChatError = true;
            }
          }
        }
      });
      observer.observe(document.querySelector('#antigravity\\.agentPanel'), 
        { childList: true, subtree: true });
    `,
    userGesture: true
  }
}));
```

### Key DOM Selectors (from auto-all)

| Selector | Purpose |
|---|---|
| `#antigravity\\.agentPanel` | Main agent/chat panel |
| `button.grow` | Chat tab buttons |
| `.bg-ide-button-background` | Accept/action buttons |
| `.antigravity-agent-side-panel` | Side panel container |
| `#antigravity\\.agentSidePanelInputBox` | Chat input box |
| `#conversation .gap-y-3` | Message turns container |

### Prerequisite: CDP Port

Antigravity must be launched with `--remote-debugging-port=9000`. The auto-all extension handles this via its [relauncher.js](file:///C:/Users/Work/.antigravity/extensions/ai-dev-2024.auto-all-antigravity-1.0.28-universal/main_scripts/relauncher.js) which:
1. Finds the Antigravity executable
2. Appends `--remote-debugging-port=9000` to the launch args
3. Restarts the process

### Pros & Cons

| ✅ Pros | ❌ Cons |
|---|---|
| Full DOM access — can detect ANY visual state | Requires `--remote-debugging-port` flag |
| Real-time MutationObserver for instant detection | Requires process restart to enable CDP |
| Can click buttons, read text, inspect elements | Fragile to DOM changes between versions |
| Most reliable detection possible | Security concerns (open debug port) |

---

## Complete Antigravity Command Catalog

All commands discovered by scanning the `antigravity-sdk` and community extensions:

### Chat/Conversation Commands
| Command | Description |
|---|---|
| `antigravity.sendPromptToAgentPanel` | **Send text to active chat** (preferred for "Continue") |
| `antigravity.sendTextToChat` | Send text to chat (less reliable) |
| `antigravity.sendChatActionMessage` | Send action message (e.g., typing) |
| `antigravity.startNewConversation` | Create new conversation |
| `antigravity.setVisibleConversation` | Switch to conversation by UUID |
| `antigravity.toggleChatFocus` | Toggle chat panel focus |
| `antigravity.prioritized.chat.openNewConversation` | Open new conversation (prioritized) |
| `antigravity.openConversationPicker` | Open conversation picker UI |
| `antigravity.broadcastConversationDeletion` | Broadcast conversation deletion |
| `antigravity.trackBackgroundConversationCreated` | Track background conversation |
| `antigravity.executeCascadeAction` | Execute cascade action |

### Agent/Step Control
| Command | Description |
|---|---|
| `antigravity.agent.acceptAgentStep` | Accept current step |
| `antigravity.agent.rejectAgentStep` | Reject current step |
| `antigravity.command.accept` | Accept pending command |
| `antigravity.command.reject` | Reject pending command |
| `antigravity.terminalCommand.accept` | Accept terminal command |
| `antigravity.terminalCommand.reject` | Reject terminal command |
| `antigravity.terminalCommand.run` | Run terminal command |

### Panel Control
| Command | Description |
|---|---|
| `antigravity.agentPanel.open` | Open agent panel |
| `antigravity.agentPanel.focus` | Focus agent panel |
| `antigravity.agentSidePanel.open` | Open side panel |
| `antigravity.agentSidePanel.focus` | Focus side panel |
| `antigravity.agentSidePanel.toggleVisibility` | Toggle side panel |

### Diagnostics & System
| Command | Description |
|---|---|
| `antigravity.getDiagnostics` | **Get full diagnostics JSON** (176KB) |
| `antigravity.downloadDiagnostics` | Download diagnostics file |
| `antigravity.getChromeDevtoolsMcpUrl` | Get CDP MCP URL |
| `antigravity.getBrowserOnboardingPort` | Get browser port |
| `antigravity.getManagerTrace` | Get manager trace |
| `antigravity.getWorkbenchTrace` | Get workbench trace |
| `antigravity.isFileGitIgnored` | Check if file is gitignored |
| `antigravity.killLanguageServerAndReloadWindow` | Kill LS and reload |
| `antigravity.restartLanguageServer` | Restart language server |
| `antigravity.reloadWindow` | Reload window |

---

## Recommended Implementation Path

### Phase 1: Quick Win — `getDiagnostics` Log Parsing
1. Poll `antigravity.getDiagnostics` every 30-60s during idle periods
2. Parse `agentWindowConsoleLogs` and `languageServerLogs` for error patterns
3. Compare `recentTrajectories[0].lastStepIndex` between polls to detect stalls
4. **Zero setup, works immediately**

### Phase 2: Quota Pre-emption — LS API Integration
1. Discover LS process via `wmic` (Windows) or `ps` (Unix)
2. Extract CSRF token and port
3. Poll `GetUserStatus` every 2 minutes
4. If `remainingFraction === 0`, wait for `resetTime` instead of blind retry
5. **Prevents errors before they happen**

### Phase 3: Real-time Detection — CDP Observer (Optional)
1. Check if CDP is available (`http://127.0.0.1:9000/json/list`)
2. If available, connect and inject lightweight MutationObserver
3. Watch for error text in `#antigravity\\.agentPanel`
4. **Only if user has already enabled CDP (via auto-all or manually)**

---

## Idle Agent Detection — How to Know When the Chat is Free

Three independent signals can determine whether the AI agent is currently working or idle. These are useful for auto-continue (detecting stalls) but also for **auto-starting new tasks** when the agent finishes its current work.

### Signal 1: `chatSessionRequestInProgress` Context Key

**What it is:** A VS Code context key set by the chat system. `true` while the agent is streaming a response, `false` otherwise.

**Scope:** View-level — readable whenever ANY part of the chat panel is in the focus chain (input box, message list, etc.). Does NOT require a specific response element to be focused (unlike `chatSessionResponseError`).

**How to read it:**

```typescript
// Requires the chat panel to be focused (or recently focused via probe)
const isBusy = await vscode.commands.executeCommand<boolean>(
  'getContext',
  'chatSessionRequestInProgress'
);

if (isBusy === true) {
  console.log('Agent is actively streaming a response');
} else {
  console.log('Agent is idle — chat is free');
}
```

**Limitations:**
- Only readable when the chat panel is in the focus chain. If the code editor has focus, this returns `undefined` (not `false`).
- To read it reliably from background code, you must briefly focus the chat panel first:

```typescript
// Focus probe pattern
await vscode.commands.executeCommand('workbench.action.chat.open');
await new Promise(r => setTimeout(r, 100)); // Wait for focus to settle

const isBusy = await vscode.commands.executeCommand<boolean>(
  'getContext',
  'chatSessionRequestInProgress'
);

// Restore editor focus if desired
if (previousEditor) {
  await vscode.window.showTextDocument(previousEditor.document, {
    viewColumn: previousEditor.viewColumn,
    preserveFocus: false,
  });
}
```

| ✅ Pros | ❌ Cons |
|---|---|
| Real-time — reflects current streaming state | Requires chat panel focus to read |
| Standard VS Code API | Focus probe briefly steals focus from editor |
| No external process discovery | Returns `undefined` (not `false`) when out of scope |

---

### Signal 2: `recentTrajectories[0].lastStepIndex` (Step Counter)

**What it is:** The diagnostics payload includes the last 10 conversation trajectories. Each has a `lastStepIndex` (0-based step counter) that increments each time the agent performs an action (tool use, code edit, file read, etc.).

**How to detect idle:** Poll the step index on an interval. If it stops incrementing, the agent has stopped working.

```typescript
let lastKnownStepIndex: number | null = null;
let stepFrozenSince: number | null = null;

async function checkAgentActivity(): Promise<'busy' | 'idle' | 'unknown'> {
  const raw = await vscode.commands.executeCommand<string>('antigravity.getDiagnostics');
  if (!raw) return 'unknown';
  
  const diag = JSON.parse(raw);
  const trajectories = diag.recentTrajectories;
  if (!Array.isArray(trajectories) || trajectories.length === 0) return 'unknown';
  
  const active = trajectories[0];
  const currentStep = active.lastStepIndex ?? 0;
  
  if (lastKnownStepIndex !== null && currentStep !== lastKnownStepIndex) {
    // Step changed — agent is working
    lastKnownStepIndex = currentStep;
    stepFrozenSince = null;
    return 'busy';
  }
  
  if (lastKnownStepIndex !== null && currentStep === lastKnownStepIndex) {
    // Step unchanged — agent MAY be idle
    if (!stepFrozenSince) stepFrozenSince = Date.now();
    const frozenSec = (Date.now() - stepFrozenSince) / 1000;
    
    if (frozenSec > 30) {
      return 'idle'; // Frozen for 30+ seconds — agent is done
    }
  }
  
  lastKnownStepIndex = currentStep;
  return 'unknown'; // Not enough data yet
}
```

**Key insight:** The step index jumps in bursts. During active work, it increments every few seconds. When the agent finishes (or hits an error), it freezes completely. A 30-second freeze reliably indicates the agent is done.

| ✅ Pros | ❌ Cons |
|---|---|
| **No focus management needed** — works from background | ~30s detection latency (must wait for freeze) |
| Works regardless of which panel has focus | getDiagnostics is a heavy call (~176KB payload) |
| Can distinguish between conversations via `googleAgentId` | Step index doesn't distinguish "done" from "errored" |

---

### Signal 3: `recentTrajectories[0].lastModifiedTime` (Timestamp)

**What it is:** Each trajectory has a `lastModifiedTime` ISO timestamp that updates whenever the conversation receives new activity (agent steps, user messages, etc.).

**How to detect idle:** Compare the timestamp age against a threshold. If the trajectory hasn't been modified recently, the agent is idle.

```typescript
async function isAgentActive(recentThresholdMs = 30_000): Promise<boolean> {
  const raw = await vscode.commands.executeCommand<string>('antigravity.getDiagnostics');
  if (!raw) return false;
  
  const diag = JSON.parse(raw);
  const trajectories = diag.recentTrajectories;
  if (!Array.isArray(trajectories) || trajectories.length === 0) return false;
  
  const active = trajectories[0];
  const lastModified = active.lastModifiedTime 
    ? new Date(active.lastModifiedTime).getTime() 
    : 0;
  
  const age = Date.now() - lastModified;
  
  // If modified within the last 30 seconds, agent is active
  return age < recentThresholdMs;
}
```

**Key insight:** This is the simplest idle detection method. A single call, a single comparison. The 30-second window accounts for the gap between agent steps (some tools take a few seconds to execute).

| ✅ Pros | ❌ Cons |
|---|---|
| Simplest implementation — one timestamp comparison | Same heavy payload as Signal 2 |
| **No focus management needed** | 30s window may report "active" briefly after agent finishes |
| Can be combined with Signal 2 for confirmation | Timestamp may be affected by user messages too |

---

### Comparison: Which Signal to Use

| Use Case | Best Signal | Why |
|---|---|---|
| **Real-time busy indicator** (status bar) | Signal 1: Context key | Instant, no parsing overhead |
| **Auto-start next task** when agent finishes | Signal 3: Timestamp | Simplest, low false-positive rate |
| **Stall/error detection** (distinguish done vs broken) | Signal 2: Step counter | Can detect when steps freeze mid-work |
| **Maximum reliability** (unattended operation) | All three combined | Cross-validate signals to eliminate false positives |

### Combined Pattern: Robust Idle Detection for Auto-Start

```typescript
interface AgentState {
  isActive: boolean;
  confidence: 'high' | 'medium' | 'low';
  source: string;
}

async function detectAgentState(): Promise<AgentState> {
  // Signal 3: Quick timestamp check (cheapest way to confirm activity)
  const raw = await vscode.commands.executeCommand<string>('antigravity.getDiagnostics');
  if (!raw) return { isActive: false, confidence: 'low', source: 'no diagnostics' };
  
  const diag = JSON.parse(raw);
  const traj = diag.recentTrajectories?.[0];
  if (!traj) return { isActive: false, confidence: 'low', source: 'no trajectories' };
  
  const lastModified = traj.lastModifiedTime 
    ? new Date(traj.lastModifiedTime).getTime() : 0;
  const age = Date.now() - lastModified;
  const recentlyModified = age < 30_000;
  
  // Signal 2: Step counter (confirms activity is agent work, not just user typing)
  const currentStep = traj.lastStepIndex ?? 0;
  // (compare against previous poll's step index)
  
  if (recentlyModified) {
    return { isActive: true, confidence: 'high', source: 'trajectory timestamp' };
  }
  
  // Agent appears idle — safe to start a new task
  return { 
    isActive: false, 
    confidence: 'high', 
    source: `trajectory idle for ${Math.round(age / 1000)}s` 
  };
}
```

### Important Caveat: Detecting "Done" vs "Errored"

All three signals tell you the agent is **not currently working**, but they don't tell you **why**. The agent may be:
- ✅ **Done** — completed the task successfully
- ❌ **Errored** — hit a 503/capacity error and stopped
- ⏸️ **Waiting** — waiting for user input (tool approval, question answer)

To distinguish these cases, combine idle detection with:
- **Error patterns** in `agentWindowConsoleLogs` (503, rate limit, capacity) → errored
- **`chatSessionResponseError` context key** → errored
- **No error signals + idle** → likely done or waiting for input

---

## Source Files Referenced

| Extension | File | What It Reveals |
|---|---|---|
| [auto-all extension.js](file:///C:/Users/Work/.antigravity/extensions/ai-dev-2024.auto-all-antigravity-1.0.28-universal/extension.js) | CDP handler initialization, relauncher |
| [auto-all cdp-handler.js](file:///C:/Users/Work/.antigravity/extensions/ai-dev-2024.auto-all-antigravity-1.0.28-universal/main_scripts/cdp-handler.js) | WebSocket CDP connection, Runtime.evaluate |
| [auto-all full_cdp_script.js](file:///C:/Users/Work/.antigravity/extensions/ai-dev-2024.auto-all-antigravity-1.0.28-universal/main_scripts/full_cdp_script.js) | DOM selectors, button detection, agent panel IDs |
| [AG Quota process_finder.ts](file:///C:/Users/Work/.antigravity/extensions/henrikdev.ag-quota-1.1.0-universal/src/core/process_finder.ts) | LS process discovery, CSRF extraction |
| [AG Quota quota_manager.ts](file:///C:/Users/Work/.antigravity/extensions/henrikdev.ag-quota-1.1.0-universal/src/core/quota_manager.ts) | ConnectRPC API calls, quota response parsing |
| [Better AG dist/extension.js](file:///C:/Users/Work/.antigravity/extensions/kanezal.better-antigravity-0.8.0-universal/dist/extension.js) | Full Antigravity command catalog, CascadeManager |

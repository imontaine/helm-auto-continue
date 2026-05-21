# Changelog

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

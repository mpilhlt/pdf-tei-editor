# Log Viewer Plugin

Real-time application log viewer for administrators. Streams server logs to the browser via SSE.

## How It Works

1. **SSE Log Handler** (`fastapi_app/lib/sse_log_handler.py`): A Python `logging.Handler` attached to the root logger at startup. It maintains a set of subscribed session IDs and broadcasts log records only to those sessions via `SSEService.send_message()`.

2. **Efficiency**: The handler's `emit()` method checks if the subscriber set is empty before doing any work (fast path). It also intersects subscribers with `SSEService.get_active_clients()` on each emit to prune stale sessions. A thread-local re-entrancy guard prevents infinite recursion from SSEService's own logging.

3. **Subscribe/Unsubscribe Routes** (`routes.py`): `POST /api/plugins/log-viewer/subscribe` and `/unsubscribe` register/remove the session from the log handler's subscriber set. Both require admin role.

4. **SSE Forwarding**: The log viewer page runs in an iframe and cannot access the parent window's SSE connection directly. Instead, `PluginSandbox.subscribeSSE(eventType)` registers a listener on the parent's SSE connection and forwards matching events to the iframe via `postMessage`. The auto-generated sandbox client script in the iframe receives these `SSE_EVENT` messages and dispatches them to registered callbacks.

5. **Log Viewer UI** (`html/view.html`): A static HTML page served at `/api/plugins/log-viewer/static/view.html`. On load, it calls the subscribe endpoint and then `sandbox.subscribeSSE('logEntry', callback)`. Log entries are displayed in a dark terminal-style view with color-coding by level (DEBUG=gray, INFO=default, WARNING=orange, ERROR/CRITICAL=red). Controls: level filter, auto-scroll, pause, clear. Max 5000 entries.

## Files

- `plugin.py` — Plugin metadata and `show_logs` endpoint (returns `outputUrl`)
- `routes.py` — Subscribe/unsubscribe API routes (admin-only)
- `html/view.html` — Static log viewer page
- `fastapi_app/lib/sse_log_handler.py` — `SSELogHandler` class (shared infrastructure)
- `fastapi_app/lib/logging_utils.py` — `install_sse_log_handler()` / `get_sse_log_handler()`

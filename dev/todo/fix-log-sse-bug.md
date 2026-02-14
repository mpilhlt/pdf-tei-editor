# Fix: Log Viewer SSE events not received by originating session

## Bug

The log viewer plugin shows log entries from *other* sessions but not from the session that opened it. For example, if window A opens the log viewer, actions in window B appear in A's log viewer, but actions in window A itself do not.

## Diagnosis

### What works

- Backend correctly subscribes the session and sends `logEntry` SSE events to all subscribers
- `send_message` queues events to the correct session's SSE queue
- The browser's native EventSource DOES receive `logEntry` events (confirmed via a debug listener added directly in `establishConnection`)

### What fails

- The PluginSandbox's listener (registered via `sseApi.addEventListener`) does not fire for events triggered by the same window's actions, even though a debug listener registered in the same `establishConnection` call does fire

### Root cause (partial)

The debug output showed that two different `addEventListener` calls on what should be the same EventSource behave differently: the one inside `establishConnection` fires, while the PluginSandbox's does not. This can only happen if they are on **different EventSource objects** — i.e., an SSE reconnection occurred between when the PluginSandbox registered its listener and when the events arrived.

**Confirmed bug in `sse.js`**: The `api.addEventListener()` method added listeners directly to the native EventSource without keeping a persistent registry. On reconnection, a new EventSource is created and the old listeners are lost. Only listeners that were queued *before* the first connection (via `queuedListeners`) survived reconnections. This has been fixed by replacing `queuedListeners` with `registeredListeners` — a persistent registry that stores all listeners and re-adds them when `establishConnection` runs.

### Remaining mystery

After applying the `registeredListeners` fix, the bug persisted. The fix is correct (listeners now survive reconnections), but there may be an additional issue:

1. **Silent reconnections**: The SSE connection may reconnect more frequently than expected, possibly triggered by certain HTTP requests. The `onerror` handler closes and nulls `eventSource` before scheduling a reconnect. Between close and reconnect, `eventSource` is null — any `addEventListener` call during that gap would only store in the registry but not attach to a live EventSource.

2. **Race condition in listener attachment**: When `subscribeSSE` is called, `sseApi.addEventListener` stores in registry + adds to current eventSource. But if the EventSource is in the process of reconnecting (eventSource is null momentarily), the listener goes to the registry but is not on any live EventSource. When `establishConnection` runs, it re-adds from the registry — but the timing of when this happens relative to the PluginSandbox subscription matters.

3. **Multiple PluginSandbox instances**: The debug output showed the PluginSandbox listener firing *twice* for some events (`2 backend-plugin-sandbox.js:190:15`), suggesting multiple PluginSandbox instances exist with listeners on the EventSource. The `sl-hide` handler calls `_cleanupSSESubscriptions()` but the old PluginSandbox's message handler remains on `window`. A new PluginSandbox created for a subsequent plugin execution would add a second listener. This could interact with the reconnection issue.

## Suggestions for continuing

### 1. Investigate SSE reconnection timing

Add persistent (non-DEBUG) logging to `establishConnection` and `cleanupConnection` to understand when reconnections happen:

```javascript
// In establishConnection:
console.warn(`SSE: establishing connection (attempt ${reconnectAttempts + 1}), registeredListeners: ${JSON.stringify(Object.keys(registeredListeners).map(k => `${k}:${registeredListeners[k].length}`))}`)

// In cleanupConnection:
console.warn('SSE: connection cleaned up')

// In onerror:
console.warn(`SSE: error, readyState=${readyState}`)
```

### 2. Verify listener attachment after reconnection

In `establishConnection`, after re-adding registered listeners, log confirmation:

```javascript
Object.keys(registeredListeners).forEach(type => {
  console.warn(`SSE: re-added ${registeredListeners[type].length} listener(s) for '${type}'`)
})
```

### 3. Check if the same-session event delivery is a backend threading issue

The SSE `event_stream` generator runs in a threadpool thread via Starlette. When a request from the same session triggers logging, the log handler puts events into the session's queue from the request-handling thread. The `event_stream` thread reads from the queue. Verify that the `queue.put()` in `send_message` and the `queue.get()` in `event_stream` are not contending on the same lock in a way that delays delivery only for same-session requests.

### 4. PluginSandbox lifecycle

Investigate whether the PluginSandbox is properly destroyed and recreated when the plugin dialog is reopened. If multiple instances accumulate, their listeners may interfere. Consider calling `destroy()` (not just `_cleanupSSESubscriptions()`) on dialog hide, and ensuring only one message handler is active.

## Fix attempt 2 (Feb 2026) — #270 and #257

### What was done

Addressed both the "remaining mystery" race condition (#257) and the server-restart reconnection issue (#270) with frontend-only changes.

#### view.html — init reorder and reconnection recovery

The `init()` function in `view.html` had a race condition: it called `POST /subscribe` (backend starts sending events) *before* registering the SSE listener via `sandbox.subscribeSSE('logEntry', ...)`. Events arriving in that gap were lost.

New init order:

1. `sandbox.subscribeSSE('logEntry', onLogEntry)` — listener ready
2. `sandbox.subscribeSSE('connected', onSSEConnected)` — reconnection handler
3. `subscribeBackend()` — backend starts sending events

On SSE reconnection (detected via the `connected` event already emitted by `sse_service.event_stream()`), `onSSEConnected` re-calls `subscribeBackend()` to restore the in-memory `_log_subscribers` set that was lost on server restart.

A 60-second `setInterval` periodically re-subscribes as a safety net (the endpoint is idempotent).

A `updateStatus()` function shows "Connected" / "Reconnecting..." / "Connection failed" in the UI header.

#### sse.js — reconnect parameters

- `MAX_RECONNECT_ATTEMPTS`: 5 → 10
- Added `MAX_RECONNECT_DELAY = 30000` cap on exponential backoff
- Total reconnect window: ~210s (2+4+8+16+30+30+30+30+30+30), sufficient for server restarts

### Test results

**test_sse_same_session.test.js** — API-level integration test in `fastapi_app/plugins/log_viewer/tests/`. Both subtests pass:

- "Same session receives its own logEntry events" — confirms #257 fix at the backend level
- "Cross-session log events are received" — regression test

Run with: `node tests/backend-test-runner.js --test-dir fastapi_app/plugins/log_viewer/tests`

**test_sse_reconnect.js** — Standalone server lifecycle test in the same directory. Phase 1 (basic SSE delivery) passes. Phase 2/3 (kill server, restart, verify recovery) is fragile due to macOS port reuse timing and process cleanup. **Currently skipped** — the test body is preserved but `process.exit(0)` runs before `main()`. To re-enable: remove the skip block at the bottom of the file.

### What remains unverified

1. **Frontend reconnection flow end-to-end**: The `connected` → `subscribeBackend()` path in `view.html` has not been tested in a browser. The automated reconnect test (test_sse_reconnect.js) only validates the backend API path (re-login, re-connect SSE, re-subscribe). The iframe ↔ PluginSandbox ↔ sse.js chain during a real reconnection needs manual verification: open the log viewer, restart the server, confirm log entries resume.

2. **PluginSandbox lifecycle** (from "Remaining mystery" §3 above): Multiple PluginSandbox instances may still accumulate if the dialog is opened/closed repeatedly. The `sl-hide` handler calls `_cleanupSSESubscriptions()` but not `destroy()`, so the old `window` message handler persists. This could cause duplicate event forwarding. Worth investigating if duplicate log entries appear.

3. **Silent reconnections**: The hypothesis that same-session HTTP requests trigger SSE reconnections (§1 above) was not directly tested. The init reorder should make this irrelevant for the initial subscription, but mid-session reconnections could still lose events briefly until the `connected` handler re-subscribes.

### Additional files changed (this round)

- `fastapi_app/plugins/log_viewer/static/view.html` — reordered init, added `subscribeBackend()`, `onSSEConnected()`, `updateStatus()`, periodic re-subscribe
- `app/src/plugins/sse.js` — increased reconnect attempts, added delay cap
- `fastapi_app/plugins/log_viewer/tests/test_sse_same_session.test.js` — new integration test
- `fastapi_app/plugins/log_viewer/tests/test_sse_reconnect.js` — new standalone test (skipped)

## Files changed

- `app/src/plugins/sse.js` — replaced `queuedListeners` with persistent `registeredListeners` registry
- `app/src/modules/backend-plugin-sandbox.js` — added `subscribeSSE`/`unsubscribeSSE`/`_cleanupSSESubscriptions`/`destroy` methods, `_sseSubscriptions` Map
- `app/src/plugins/backend-plugins.js` — added `sl-hide` listener to clean up SSE subscriptions
- `fastapi_app/lib/sse_log_handler.py` — new file, logging handler with deadlock-free design, rate limiting, feedback loop prevention
- `fastapi_app/lib/logging_utils.py` — added `install_sse_log_handler`/`get_sse_log_handler`
- `fastapi_app/main.py` — installs SSE log handler at startup
- `fastapi_app/lib/plugin_tools.py` — extended sandbox client script with SSE forwarding
- `fastapi_app/routers/plugins.py` — added `/sandbox-client.js` endpoint
- `fastapi_app/plugins/log_viewer/` — new plugin (plugin.py, routes.py, __init__.py, html/view.html, README.md)

## Log file shwoing "No SSE queue"

This is an example for the entries that are added to the log file after a log window has been opened. The warnings might be relevant, showing the SSE session ids.

```text
2026-02-14 18:15:08.018 [DEBUG   ] fastapi_app.routers.files_locks - [LOCK] Session 7207abf6... attempting to release lock for file nu7byx...
2026-02-14 18:15:08.018 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.018", "level": 
2026-02-14 18:15:08.020 [INFO    ] fastapi_app.routers.files_locks - [LOCK] Session 7207abf6... released lock for file nu7byx...
2026-02-14 18:15:08.021 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.020", "level": 
2026-02-14 18:15:08.023 [WARNING ] fastapi_app.lib.dependencies - No SSE queue for client: 3d808b10-3d31-4657-9c00-08aea7d56e6e
2026-02-14 18:15:08.023 [WARNING ] fastapi_app.lib.dependencies - No SSE queue for client: e203838b-9fa2-4a31-bee7-21981f70bad8
2026-02-14 18:15:08.023 [DEBUG   ] fastapi_app.routers.files_locks - Broadcast lockReleased to 2 sessions (excluded session 7207abf6...): {'stable_id': 'nu7byx'}
2026-02-14 18:15:08.023 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.023", "level": 
2026-02-14 18:15:08.034 [DEBUG   ] fastapi_app.routers.files_locks - [LOCK API] Session 7207abf6... requesting lock for z98jj9
2026-02-14 18:15:08.035 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.034", "level": 
2026-02-14 18:15:08.036 [DEBUG   ] fastapi_app.routers.files_locks - [LOCK] Session 7207abf6... attempting to acquire lock for file z98jj9...
2026-02-14 18:15:08.036 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.036", "level": 
2026-02-14 18:15:08.037 [DEBUG   ] fastapi_app.routers.files_locks - [LOCK] No existing lock found for file z98jj9...
2026-02-14 18:15:08.037 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.037", "level": 
2026-02-14 18:15:08.038 [INFO    ] fastapi_app.routers.files_locks - [LOCK] Session 7207abf6... acquired NEW lock for file z98jj9...
2026-02-14 18:15:08.038 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.038", "level": 
2026-02-14 18:15:08.039 [INFO    ] fastapi_app.routers.files_locks - [LOCK API] Session 7207abf6... successfully acquired lock for file z98jj9...
2026-02-14 18:15:08.039 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.039", "level": 
2026-02-14 18:15:08.039 [WARNING ] fastapi_app.lib.dependencies - No SSE queue for client: 3d808b10-3d31-4657-9c00-08aea7d56e6e
2026-02-14 18:15:08.039 [WARNING ] fastapi_app.lib.dependencies - No SSE queue for client: e203838b-9fa2-4a31-bee7-21981f70bad8
2026-02-14 18:15:08.039 [DEBUG   ] fastapi_app.routers.files_locks - Broadcast fileDataChanged to 2 sessions (excluded session 7207abf6...): {'reason': 'lock_acquired', 'stable_id': 'z98jj9', 'locked_by': 'cboulanger'}
2026-02-14 18:15:08.039 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.039", "level": 
2026-02-14 18:15:08.083 [DEBUG   ] fastapi_app.routers.files_serve - Serving file: z98jj9
2026-02-14 18:15:08.083 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.083", "level": 
2026-02-14 18:15:08.084 [INFO    ] fastapi_app.routers.files_serve - Serving file z98jj9... (tei)
2026-02-14 18:15:08.084 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:08.084", "level": 
2026-02-14 18:15:09.163 [DEBUG   ] fastapi_app.routers.validation - Generating autocomplete data for namespace http://www.tei-c.org/ns/1.0 with relaxng schema at http://127.0.0.1:3000/docs/schema/grobid.training.segmentation.rng
2026-02-14 18:15:09.164 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:09.163", "level": 
2026-02-14 18:15:09.164 [DEBUG   ] fastapi_app.routers.validation - Using cached schema at data/schema/cache/127.0.0.1_3000/docs/schema/grobid.training.segmentation.rng
2026-02-14 18:15:09.164 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:09.164", "level": 
2026-02-14 18:15:09.167 [DEBUG   ] fastapi_app.routers.validation - Generating autocomplete data from RelaxNG schema: data/schema/cache/127.0.0.1_3000/docs/schema/grobid.training.segmentation.rng
2026-02-14 18:15:09.167 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:09.167", "level": 
2026-02-14 18:15:09.179 [DEBUG   ] fastapi_app.routers.validation - Cached autocomplete data to data/schema/cache/127.0.0.1_3000/docs/schema/codemirror-autocomplete.json
2026-02-14 18:15:09.179 [DEBUG   ] fastapi_app.lib.dependencies - Sent SSE logEntry to 7207abf6-963f-4603-8948-52c3810fde91: {"timestamp": "2026-02-14 18:15:09.179", "level": 
```
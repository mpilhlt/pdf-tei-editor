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

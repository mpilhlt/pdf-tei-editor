# Server-Sent Events (SSE) Developer Guide

This guide explains how to use the SSE mechanism for real-time communication between server and client, and between multiple clients.

## Architecture Overview

The SSE system consists of three main components:

1. **Backend Service** (`fastapi_app/lib/sse/sse_service.py`) - Manages SSE connections and message queues per session
2. **Backend Router** (`fastapi_app/routers/sse.py`) - Provides HTTP endpoints for subscribing and sending messages
3. **Frontend Plugin** (`app/src/plugins/sse.js`) - Manages client-side EventSource connection with automatic reconnection

## Connection Flow

1. User authenticates and receives a `sessionId`
2. Frontend establishes SSE connection via `/api/v1/sse/subscribe?sessionId={sessionId}`
3. Backend creates a message queue for the session
4. Server sends events to the queue, client receives them via EventSource
5. On logout or session expiry, connection is cleaned up

## Backend: Sending Events

### Accessing the SSE Service

Use dependency injection to get the SSE service instance:

```python
from fastapi import Depends
from fastapi_app.lib.core.dependencies import get_sse_service
from fastapi_app.lib.sse.sse_service import SSEService

@router.post("/my-endpoint")
async def my_endpoint(
    session_id: str,
    sse_service: SSEService = Depends(get_sse_service)
):
    # Send event to specific session
    await sse_service.send_event(
        session_id=session_id,
        event_type="myEvent",
        data="Event payload"
    )
```

### Event Types and Data

Events have two components:

- **event_type**: String identifying the event channel (e.g., `"syncProgress"`, `"syncMessage"`)
- **data**: String payload (can be JSON-encoded for structured data)

```python
# Simple text message
await sse_service.send_event(
    session_id=session_id,
    event_type="notification",
    data="File upload complete"
)

# Structured data (JSON)
import json
await sse_service.send_event(
    session_id=session_id,
    event_type="fileUpdate",
    data=json.dumps({
        "file_id": "abc123",
        "status": "modified",
        "timestamp": "2026-01-07T10:30:00Z"
    })
)

# Progress updates
await sse_service.send_event(
    session_id=session_id,
    event_type="progress",
    data=str(75)  # 75% complete
)
```

### Real-World Example: File Sync Progress

From [app/src/plugins/sync.js:78-91](app/src/plugins/sync.js#L78-L91):

```python
async def sync_files(session_id: str, sse_service: SSEService = Depends(get_sse_service)):
    """Sync files with WebDAV backend, sending progress updates."""
    total_files = 100

    for i, file in enumerate(files):
        # Process file...

        # Send progress update
        progress = int((i + 1) / total_files * 100)
        await sse_service.send_event(
            session_id=session_id,
            event_type="syncProgress",
            data=str(progress)
        )

        # Send status message
        await sse_service.send_event(
            session_id=session_id,
            event_type="syncMessage",
            data=f"Processing {file.name}"
        )
```

## Frontend: Receiving Events

### Accessing the SSE API

The SSE plugin is available globally via the `sse` object:

```javascript
import { sse } from '../app.js'
```

### Registering Event Listeners

Use `addEventListener()` to listen for specific event types:

```javascript
async function install(state) {
  // Listen for sync progress updates
  sse.addEventListener('syncProgress', (event) => {
    const progress = parseInt(event.data)
    updateProgressBar(progress)
  })

  // Listen for sync messages
  sse.addEventListener('syncMessage', (event) => {
    const message = event.data
    logger.debug(`Sync: ${message}`)
  })
}
```

### Handling Structured Data

Parse JSON data when receiving structured events:

```javascript
sse.addEventListener('fileUpdate', (event) => {
  const data = JSON.parse(event.data)
  console.log(`File ${data.file_id} status: ${data.status}`)

  // Update UI based on file status
  if (data.status === 'modified') {
    refreshFileList()
  }
})
```

### Listener Registration Timing

Listeners can be registered **before or after** the SSE connection is established:

- **Before connection**: Listeners are queued and attached when connection opens
- **After connection**: Listeners are attached immediately

This allows plugins to register listeners in their `install()` method without worrying about connection state.

From [app/src/plugins/sse.js:18-28](app/src/plugins/sse.js#L18-L28):

```javascript
addEventListener: (type, listener) => {
  if (eventSource) {
    eventSource.addEventListener(type, listener)
  } else {
    // Queue listeners for when connection is established
    if (!queuedListeners[type]) {
      queuedListeners[type] = []
    }
    queuedListeners[type].push(listener)
  }
}
```

### Removing Event Listeners

Clean up listeners when they're no longer needed:

```javascript
function cleanup() {
  sse.removeEventListener('syncProgress', handleProgress)
  sse.removeEventListener('syncMessage', handleMessage)
}
```

## Real-World Use Cases

### Use Case 1: File Synchronization Progress

**Scenario**: WebDAV sync operation needs to show real-time progress to the user.

**Backend** (`fastapi_app/routers/sync.py`):

```python
@router.post("/sync")
async def sync_files(
    session_id: str = Query(...),
    sse_service: SSEService = Depends(get_sse_service)
):
    files_to_sync = get_files_to_sync()
    total = len(files_to_sync)

    for i, file in enumerate(files_to_sync):
        # Sync file...
        sync_file(file)

        # Update progress
        progress = int((i + 1) / total * 100)
        await sse_service.send_event(
            session_id=session_id,
            event_type="syncProgress",
            data=str(progress)
        )

        await sse_service.send_event(
            session_id=session_id,
            event_type="syncMessage",
            data=f"Synced {file.name}"
        )

    return {"status": "complete"}
```

**Frontend** ([app/src/plugins/sync.js:78-91](app/src/plugins/sync.js#L78-L91)):

```javascript
async function install(state) {
  const progressWidget = new StatusProgress()

  sse.addEventListener('syncProgress', (event) => {
    const progress = parseInt(event.data)
    progressWidget.indeterminate = false
    progressWidget.value = progress
  })

  sse.addEventListener('syncMessage', (event) => {
    logger.debug(`Sync: ${event.data}`)
  })
}
```

### Use Case 2: Multi-User Document Editing Notifications

**Scenario**: Notify users when another user starts editing a document they have open.

**Backend** (`fastapi_app/routers/files_save.py`):

```python
@router.post("/lock")
async def lock_document(
    stable_id: str,
    session_id: str = Query(...),
    sse_service: SSEService = Depends(get_sse_service),
    auth_manager = Depends(get_auth_manager),
    session_manager = Depends(get_session_manager)
):
    user = auth_manager.get_user_by_session_id(session_id, session_manager)

    # Acquire lock
    acquire_lock(stable_id, user.username)

    # Notify all other users viewing this document
    active_sessions = session_manager.get_all_sessions()
    for other_session_id in active_sessions:
        if other_session_id != session_id:
            await sse_service.send_event(
                session_id=other_session_id,
                event_type="documentLocked",
                data=json.dumps({
                    "stable_id": stable_id,
                    "locked_by": user.username
                })
            )

    return {"status": "locked"}
```

**Frontend**:

```javascript
sse.addEventListener('documentLocked', (event) => {
  const data = JSON.parse(event.data)

  // Show notification if current document matches
  if (currentState.documentId === data.stable_id) {
    notify(
      `Document is now being edited by ${data.locked_by}`,
      'warning',
      'exclamation-triangle'
    )

    // Make editor read-only
    updateState({ editorReadOnly: true })
  }
})
```

### Use Case 3: Background Task Completion

**Scenario**: Long-running backend task (e.g., PDF processing) needs to notify client when complete.

**Backend**:

```python
import asyncio

async def process_pdf_async(pdf_id: str, session_id: str, sse_service: SSEService):
    """Background task for processing PDF."""
    try:
        # Long-running processing
        result = await extract_text_from_pdf(pdf_id)

        # Notify completion
        await sse_service.send_event(
            session_id=session_id,
            event_type="pdfProcessed",
            data=json.dumps({
                "pdf_id": pdf_id,
                "status": "success",
                "text_length": len(result)
            })
        )
    except Exception as e:
        await sse_service.send_event(
            session_id=session_id,
            event_type="pdfProcessed",
            data=json.dumps({
                "pdf_id": pdf_id,
                "status": "error",
                "error": str(e)
            })
        )

@router.post("/process-pdf")
async def process_pdf(
    pdf_id: str,
    session_id: str = Query(...),
    sse_service: SSEService = Depends(get_sse_service)
):
    # Start background task
    asyncio.create_task(process_pdf_async(pdf_id, session_id, sse_service))
    return {"status": "processing"}
```

**Frontend**:

```javascript
sse.addEventListener('pdfProcessed', (event) => {
  const data = JSON.parse(event.data)

  if (data.status === 'success') {
    notify(
      `PDF processed: ${data.text_length} characters extracted`,
      'success',
      'check-circle'
    )
    // Reload file data to show new version
    FiledataPlugin.getInstance().reload({ refresh: true })
  } else {
    notify(
      `PDF processing failed: ${data.error}`,
      'danger',
      'exclamation-octagon'
    )
  }
})
```

### Use Case 4: Server-Initiated Data Refresh

**Scenario**: Server detects external file changes (e.g., from WebDAV sync) and notifies clients to refresh.

**Backend**:

```python
async def on_external_file_change(file_id: str, sse_service: SSEService):
    """Called when external system modifies a file."""
    # Get all active sessions
    active_sessions = session_manager.get_all_sessions()

    # Notify all connected clients
    for session_id in active_sessions:
        await sse_service.send_event(
            session_id=session_id,
            event_type="fileChanged",
            data=json.dumps({
                "file_id": file_id,
                "source": "external",
                "timestamp": datetime.now().isoformat()
            })
        )
```

**Frontend**:

```javascript
sse.addEventListener('fileChanged', (event) => {
  const data = JSON.parse(event.data)

  logger.log(`File ${data.file_id} changed externally`)

  // Reload file list to show updated content
  FiledataPlugin.getInstance().reload({ refresh: true })

  // If currently viewing the changed file, show notification
  if (currentState.documentId === data.file_id) {
    notify(
      'This document was updated externally',
      'warning',
      'info-circle'
    )
  }
})
```

## Connection Management

### Automatic Reconnection

The frontend plugin handles reconnection automatically with exponential backoff:

- Maximum 5 reconnection attempts
- Starting delay: 2 seconds
- Exponential backoff: delay × 2^attempt

From [app/src/plugins/sse.js:194-209](app/src/plugins/sse.js#L194-L209):

```javascript
if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
  const delay = RECONNECT_INTERVAL * Math.pow(2, reconnectAttempts)
  reconnectAttempts++

  logger.log(`Attempting to reconnect in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)

  reconnectTimeout = setTimeout(() => {
    if (cachedSessionId) {
      establishConnection(cachedSessionId)
    }
  }, delay)
}
```

### Manual Reconnection

Force reconnection programmatically:

```javascript
if (sse.readyState !== EventSource.OPEN) {
  sse.reconnect()
}
```

### Connection State

Check connection state:

```javascript
// readyState values:
// EventSource.CONNECTING (0) - connecting
// EventSource.OPEN (1) - connection open
// EventSource.CLOSED (2) - connection closed

if (sse.readyState === EventSource.OPEN) {
  console.log('SSE connected')
}

console.log(`Connected to: ${sse.url}`)
console.log(`Reconnect attempts: ${sse.reconnectAttempts}`)
```

## Testing SSE Events

### Backend Tests

Use the test echo endpoint to send messages:

```javascript
import { authenticatedRequest } from '../helpers/test-auth.js'

const response = await authenticatedRequest(
  session.sessionId,
  '/sse/test/echo',
  'POST',
  ['Message 1', 'Message 2', 'Message 3'],
  BASE_URL
)
```

See [tests/api/v1/sse.test.js](tests/api/v1/sse.test.js) for complete test patterns.

### Frontend Testing

Create a test connection and wait for events:

```javascript
import { createEventSource } from 'eventsource-client'

const events = []
const eventSource = createEventSource({
  url: `${BASE_URL}/api/v1/sse/subscribe`,
  headers: {
    'X-Session-Id': sessionId
  },
  onMessage: (message) => {
    if (message.event === 'test') {
      events.push(message.data)
    }
  }
})

// Wait for events
await new Promise(resolve => setTimeout(resolve, 1000))
```

## Best Practices

1. **Event Type Naming**: Use camelCase for event types (e.g., `syncProgress`, `fileChanged`)
2. **Data Format**: Use JSON for structured data, plain strings for simple messages
3. **Error Handling**: Always handle connection errors and implement retry logic
4. **Resource Cleanup**: Remove event listeners when components unmount
5. **Session Association**: Always send events to specific sessions, not globally
6. **Performance**: Avoid sending high-frequency events (>10 per second)
7. **Security**: Validate session IDs and check user permissions before sending events

## Configuration

SSE can be disabled via configuration:

```javascript
// In config
{
  "sse": {
    "enabled": false  // Disable SSE
  }
}
```

Check from [app/src/plugins/sse.js:131-137](app/src/plugins/sse.js#L131-L137):

```javascript
async function ready() {
  const sseEnabled = await config.get("sse.enabled")
  if (sseEnabled === false) {
    logger.debug('SSE is disabled.')
    return
  }
}
```

## Debugging

Enable debug logging:

```javascript
// Frontend
logger.setLevel('debug')

// Backend
import logging
logging.getLogger('fastapi_app.lib.sse_service').setLevel(logging.DEBUG)
```

Monitor SSE connection in browser DevTools:

1. Open Network tab
2. Filter by "EventStream"
3. Click on the SSE connection
4. View "EventStream" tab to see incoming events

## API Reference

### Backend API

**`SSEService.send_event(session_id: str, event_type: str, data: str)`**

Send event to specific session.

**`SSEService.subscribe(session_id: str) -> AsyncGenerator`**

Create SSE stream for session (used internally by router).

### Frontend API

**`sse.addEventListener(type: string, listener: Function)`**

Register event listener for specific event type.

**`sse.removeEventListener(type: string, listener: Function)`**

Remove event listener.

**`sse.reconnect()`**

Force reconnection attempt.

**`sse.readyState`** - Connection state (0=CONNECTING, 1=OPEN, 2=CLOSED)

**`sse.url`** - Current connection URL

**`sse.reconnectAttempts`** - Number of reconnection attempts

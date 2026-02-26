# Server Progress Bars

This document describes how to implement progress bars for long-running server processes using SSE (Server-Sent Events).

## Overview

The progress system allows backend processes to display progress indicators in the frontend. It supports:

- Multiple simultaneous progress widgets (identified by unique `progress_id`)
- Determinate (percentage) and indeterminate progress modes
- User cancellation with configurable cancel endpoints
- Toast notifications for completion/error messages
- Widget minimization with state persistence

## Architecture

```
Backend                          Frontend
┌─────────────────┐              ┌─────────────────┐
│  ProgressBar    │──SSE Events──│  progress.js    │
│  (sse_utils.py) │              │  plugin         │
└─────────────────┘              └─────────────────┘
        │                                │
        │ progressShow                   │ Creates widget
        │ progressValue                  │ Updates progress
        │ progressLabel                  │ Updates label
        │ progressHide                   │ Removes widget
        │                                │
        │                        ┌───────▼───────┐
        │◄───POST cancel────────│ Cancel button │
        │                        └───────────────┘
```

## Backend Usage

### Basic Progress Bar

```python
from fastapi import Depends
from fastapi_app.lib.core.dependencies import get_sse_service
from fastapi_app.lib.sse.sse_utils import ProgressBar

@router.post("/process")
async def process_files(
    session_id: str,
    sse_service = Depends(get_sse_service)
):
    # Create progress bar instance
    progress = ProgressBar(sse_service, session_id)

    # Show with initial label (indeterminate mode)
    progress.show(label="Starting...", cancellable=True)

    files = get_files_to_process()
    for i, file in enumerate(files):
        # Update label and percentage
        progress.set_label(f"Processing {file.name}")
        progress.set_value(int((i + 1) / len(files) * 100))

        await process_file(file)

    # Hide when complete
    progress.hide()

    return {"status": "complete"}
```

### Progress Bar with Cancellation

```python
from fastapi_app.lib.sse.sse_utils import ProgressBar, send_notification

# Module-level cancellation registry
_cancellation_tokens: dict[str, bool] = {}

class CancellationToken:
    """Simple cancellation token for cooperative cancellation."""

    def __init__(self, progress_id: str):
        self.progress_id = progress_id
        _cancellation_tokens[progress_id] = False

    def cancel(self):
        _cancellation_tokens[self.progress_id] = True

    @property
    def is_cancelled(self) -> bool:
        return _cancellation_tokens.get(self.progress_id, False)

    def cleanup(self):
        _cancellation_tokens.pop(self.progress_id, None)


@router.post("/cancel/{progress_id}")
async def cancel_operation(progress_id: str):
    """Cancel endpoint called by frontend."""
    if progress_id in _cancellation_tokens:
        _cancellation_tokens[progress_id] = True
        return {"status": "cancelled"}
    return {"status": "not_found"}


@router.post("/long-operation")
async def long_operation(
    session_id: str,
    sse_service = Depends(get_sse_service)
):
    progress = ProgressBar(sse_service, session_id)
    cancel_url = f"/api/my-plugin/cancel/{progress.progress_id}"
    token = CancellationToken(progress.progress_id)

    progress.show(
        label="Processing...",
        cancellable=True,
        cancel_url=cancel_url  # Frontend will POST here on cancel
    )

    try:
        for i, item in enumerate(items):
            # Check for cancellation
            if token.is_cancelled:
                send_notification(
                    sse_service, session_id,
                    "Operation cancelled", "warning"
                )
                progress.hide()
                return {"status": "cancelled"}

            progress.set_label(f"Item {i+1}/{len(items)}")
            progress.set_value(int((i / len(items)) * 100))

            await process_item(item)

        # Success notification
        send_notification(
            sse_service, session_id,
            "Operation complete", "success"
        )
        progress.hide()
        return {"status": "complete"}

    finally:
        token.cleanup()
        progress.hide()
```

### ProgressBar API

```python
class ProgressBar:
    def __init__(
        self,
        sse_service: SSEService,
        session_id: str,
        progress_id: str | None = None  # Auto-generated if not provided
    ):
        ...

    @property
    def progress_id(self) -> str:
        """Unique identifier for this progress instance."""
        ...

    def show(
        self,
        label: str | None = None,
        value: int | None = None,      # 0-100, None for indeterminate
        cancellable: bool = True,
        cancel_url: str | None = None  # URL for cancel button POST
    ) -> bool:
        ...

    def hide(self) -> bool:
        ...

    def set_value(self, value: int | None) -> bool:
        """Set progress value (0-100) or None for indeterminate."""
        ...

    def set_label(self, label: str) -> bool:
        """Update the progress label text."""
        ...
```

### Sending Notifications

```python
from fastapi_app.lib.sse.sse_utils import send_notification

# Variants: "info", "success", "warning", "error"
send_notification(
    sse_service,
    session_id,
    message="Operation completed successfully",
    variant="success",
    icon="check-circle"  # Optional Shoelace icon name
)
```

## Frontend Usage

The progress plugin is automatically installed and listens for SSE events. You typically don't need to interact with it directly, but the API is available:

```javascript
import { progress } from '../plugins.js'

// Show a progress widget programmatically
progress.show('my-progress-id', {
    label: 'Processing...',
    value: null,  // null for indeterminate
    cancellable: true,
    cancelUrl: '/api/my-endpoint/cancel/my-progress-id'
})

// Update progress
progress.setValue('my-progress-id', 50)
progress.setLabel('my-progress-id', 'Halfway there...')

// Hide widget
progress.hide('my-progress-id')

// Check if visible
const visible = progress.isVisible('my-progress-id')

// Get list of active widgets
const activeIds = progress.getActiveWidgets()
```

## SSE Event Format

All progress events are JSON-encoded with a `progress_id` field:

### progressShow

```json
{
    "progress_id": "abc123",
    "label": "Processing...",
    "value": null,
    "cancellable": true,
    "cancelUrl": "/api/plugins/grobid/cancel/abc123"
}
```

### progressValue

```json
{
    "progress_id": "abc123",
    "value": 50
}
```

### progressLabel

```json
{
    "progress_id": "abc123",
    "label": "Step 2 of 5..."
}
```

### progressHide

```json
{
    "progress_id": "abc123"
}
```

### notification

```json
{
    "message": "Operation complete",
    "variant": "success",
    "icon": "check-circle"
}
```

## Widget Behavior

- **Click to toggle**: Clicking on the widget toggles between minimized and maximized states
- **Stacking**: Multiple widgets stack vertically (bottom-left when minimized, centered when maximized)
- **State persistence**: Minimized state is stored per `progress_id` in session storage
- **Cancel**: When clicked, sends POST to the configured `cancelUrl`

## Complete Example: Collection Processing

This example shows a complete implementation for processing all documents in a collection:

### Backend Route

```python
@router.get("/process-collection")
async def process_collection(
    collection: str = Query(...),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager = Depends(get_session_manager),
    auth_manager = Depends(get_auth_manager),
    sse_service = Depends(get_sse_service),
):
    # Authentication
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Set up progress with cancellation
    progress = ProgressBar(sse_service, session_id_value)
    cancel_url = f"/api/my-plugin/cancel/{progress.progress_id}"
    token = CancellationToken(progress.progress_id)

    progress.show(
        label=f"Processing collection {collection}...",
        cancellable=True,
        cancel_url=cancel_url
    )

    try:
        db = get_db()
        file_repo = FileRepository(db)
        files = file_repo.get_files_by_collection(collection)

        processed = 0
        for i, file in enumerate(files):
            if token.is_cancelled:
                send_notification(
                    sse_service, session_id_value,
                    "Processing cancelled", "warning"
                )
                raise HTTPException(status_code=499, detail="Cancelled")

            progress.set_label(f"File {i+1}/{len(files)}: {file.doc_id[:20]}...")
            progress.set_value(int((i / len(files)) * 100))

            await process_file(file)
            processed += 1

        send_notification(
            sse_service, session_id_value,
            f"Processed {processed} files", "success"
        )
        progress.hide()
        return {"processed": processed}

    except HTTPException:
        progress.hide()
        token.cleanup()
        raise
    finally:
        token.cleanup()
```

### Cancel Endpoint

```python
@router.post("/cancel/{progress_id}")
async def cancel_progress(progress_id: str):
    if progress_id in _cancellation_tokens:
        _cancellation_tokens[progress_id] = True
        return {"status": "cancelled"}
    return {"status": "not_found"}
```

## Handling Blocking Operations

SSE events are delivered through the async event loop. If your route contains **synchronous blocking code** (e.g., HTTP requests using `requests`, file I/O, CPU-intensive operations), SSE events will be queued but not delivered until the blocking operation completes.

### Problem: Blocking Code Prevents SSE Delivery

```python
# BAD: Blocking call prevents SSE updates from being delivered
@router.get("/process")
async def process_files(session_id: str, sse_service = Depends(get_sse_service)):
    progress = ProgressBar(sse_service, session_id)
    progress.show(label="Starting...")  # Event queued but not sent yet

    for file in files:
        progress.set_label(f"Processing {file.name}")  # Queued
        result = blocking_http_request(file)  # Blocks event loop!
        # SSE events won't be delivered until this returns

    progress.hide()
```

### Solution 1: Run Blocking Code in Thread Pool

Use `asyncio.to_thread()` to run blocking operations in a thread pool, allowing the event loop to process SSE events:

```python
import asyncio

@router.get("/process")
async def process_files(session_id: str, sse_service = Depends(get_sse_service)):
    progress = ProgressBar(sse_service, session_id)
    progress.show(label="Starting...")
    await asyncio.sleep(0)  # Yield to deliver the show event

    for i, file in enumerate(files):
        progress.set_label(f"Processing {file.name}")
        progress.set_value(int((i / len(files)) * 100))
        await asyncio.sleep(0)  # Yield to deliver updates

        # Run blocking operation in thread pool
        result = await asyncio.to_thread(blocking_http_request, file)

    progress.hide()
```

### Solution 2: Yield Control After SSE Calls

For quick operations, adding `await asyncio.sleep(0)` after SSE calls yields control to the event loop:

```python
progress.show(label="Starting...")
await asyncio.sleep(0)  # Allow event to be sent

for i, item in enumerate(items):
    progress.set_label(f"Item {i+1}")
    progress.set_value(int((i / len(items)) * 100))
    await asyncio.sleep(0)  # Allow updates to be sent

    await process_item(item)  # Must be async
```

### When to Use Each Approach

| Scenario | Solution |
| -------- | -------- |
| Calling external APIs with `requests` | `asyncio.to_thread()` |
| Heavy file I/O operations | `asyncio.to_thread()` |
| CPU-intensive processing | `asyncio.to_thread()` |
| Quick async operations | `await asyncio.sleep(0)` after SSE calls |
| Mixed sync/async code | Combine both approaches |

## Best Practices

1. **Always hide on completion or error**: Ensure `progress.hide()` is called in all code paths
2. **Use try/finally**: Clean up cancellation tokens and hide progress in finally blocks
3. **Provide meaningful labels**: Update labels to show current operation and item counts
4. **Use notifications for final status**: Send success/error notifications when operations complete
5. **Check cancellation frequently**: Check `token.is_cancelled` at the start of each iteration
6. **Use indeterminate mode for unknown durations**: Pass `value=None` when total count is unknown
7. **Run blocking code in thread pool**: Use `asyncio.to_thread()` for synchronous operations to allow SSE delivery
8. **Yield after SSE calls**: Add `await asyncio.sleep(0)` after progress updates when needed

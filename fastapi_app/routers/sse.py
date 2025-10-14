"""
Server-Sent Events (SSE) router for FastAPI.

Provides real-time progress updates for long-running operations like sync.

For FastAPI migration - Phase 6.
"""

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
import logging

from ..lib.dependencies import get_sse_service, get_session_user
from ..lib.sse_service import SSEService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sse", tags=["sse"])


@router.get("/subscribe")
async def subscribe(
    sse_service: SSEService = Depends(get_sse_service),
    user: dict = Depends(get_session_user)
):
    """
    Subscribe to Server-Sent Events stream.

    Establishes a long-lived HTTP connection for receiving real-time updates.
    Client should connect before initiating sync operations.

    The stream sends events in SSE format:
    ```
    event: syncProgress
    data: 42

    event: syncMessage
    data: Downloading files...
    ```

    Event types:
    - connected: Initial connection confirmation
    - syncProgress: Progress percentage (0-100)
    - syncMessage: Status message
    - syncComplete: Sync finished successfully
    - syncError: Sync error occurred

    Returns:
        StreamingResponse with text/event-stream content type
    """
    # Use username as client_id
    client_id = user.get('username')

    logger.info(f"SSE subscription request from user: {client_id}")

    return StreamingResponse(
        sse_service.event_stream(client_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # Disable nginx buffering
        }
    )

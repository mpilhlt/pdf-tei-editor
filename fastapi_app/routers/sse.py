"""
Server-Sent Events (SSE) router for FastAPI.

Provides real-time progress updates for long-running operations like sync.

For FastAPI migration - Phase 6.
"""

from fastapi import APIRouter, Depends, Body, Request
from fastapi.responses import StreamingResponse
from typing import List
import logging
import asyncio

from ..lib.dependencies import get_sse_service, get_session_user, require_session_id
from ..lib.sse_service import SSEService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sse", tags=["sse"])


@router.get("/subscribe")
async def subscribe(
    request: Request,
    sse_service: SSEService = Depends(get_sse_service),
    user: dict = Depends(get_session_user),
    session_id: str = Depends(require_session_id)
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

    Example event types:
    - connected: Initial connection confirmation
    - syncProgress: Progress percentage (0-100)
    - syncMessage: Status message
    - syncComplete: Sync finished successfully
    - syncError: Sync error occurred

    Returns:
        StreamingResponse with text/event-stream content type
    """
    # Use session_id as client_id to support multiple concurrent connections
    # from the same user (each browser tab/window gets unique session)
    client_id = session_id
    username = user.get('username', 'unknown')

    logger.info(f"SSE subscription request from user {username} (session: {client_id[:8]}...)")

    return StreamingResponse(
        sse_service.event_stream(client_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # Disable nginx buffering
        }
    )


@router.post("/test/echo")
async def echo_test(
    messages: List[str] = Body(...),
    sse_service: SSEService = Depends(get_sse_service),
    user: dict = Depends(get_session_user),
    session_id: str = Depends(require_session_id)
):
    """
    Test endpoint that echoes a list of messages as SSE events.

    This endpoint is used for testing SSE functionality. It sends each message
    in the provided list as a separate SSE event to the client.

    Args:
        messages: List of strings to echo as SSE messages

    Returns:
        dict: Summary of messages sent

    Note:
        Client must be subscribed to /sse/subscribe before calling this endpoint.
        Messages are sent to the session's SSE queue (based on session_id).
    """
    # Use session_id as client_id (same as /subscribe endpoint)
    client_id = session_id
    username = user.get('username', 'unknown')

    logger.info(f"SSE echo test requested by {username} (session: {client_id[:8]}...) with {len(messages)} messages")

    # Send each message as an SSE event
    for i, message in enumerate(messages):
        result = sse_service.send_message(client_id, "test", message)
        if not result:
            logger.warning(f"Failed to send echo message {i+1}/{len(messages)} to session {client_id[:8]}...")
        else:
            logger.debug(f"Sent echo message {i+1}/{len(messages)} to session {client_id[:8]}...: {message}")
        await asyncio.sleep(0.1)  # Small delay to ensure events are separate

    return {
        "status": "ok",
        "messages_sent": len(messages)
    }

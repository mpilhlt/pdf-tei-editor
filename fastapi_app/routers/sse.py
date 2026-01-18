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

from ..lib.dependencies import get_sse_service, get_session_user, require_session_id, get_session_manager
from ..lib.sse_service import SSEService
from ..lib.sessions import SessionManager
from ..lib.sse_utils import broadcast_to_all_sessions

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


@router.post("/test/broadcast")
async def broadcast_test(
    body: dict = Body(...),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
    user: dict = Depends(get_session_user),
    session_id: str = Depends(require_session_id)
):
    """
    Test endpoint that broadcasts a message to all active sessions.

    This endpoint is used for testing the broadcast_to_all_sessions utility.
    It sends the provided message as an SSE event to all active sessions.

    Args:
        body: Dictionary containing "message" field to broadcast

    Returns:
        dict: Summary with status and sessions notified

    Note:
        All clients must be subscribed to /sse/subscribe to receive the broadcast.
    """
    message = body.get("message", "")
    username = user.get('username', 'unknown')

    logger.info(f"SSE broadcast test requested by {username} (session: {session_id[:8]}...)")

    # Broadcast to all sessions
    notified_count = broadcast_to_all_sessions(
        sse_service=sse_service,
        session_manager=session_manager,
        event_type="broadcast",
        data={"message": message},
        logger=logger
    )

    return {
        "status": "ok",
        "sessions_notified": notified_count
    }


@router.post("/test/progress")
async def progress_test(
    body: dict = Body(default={}),
    sse_service: SSEService = Depends(get_sse_service),
    user: dict = Depends(get_session_user),
    session_id: str = Depends(require_session_id)
):
    """
    Test endpoint that simulates a progress bar workflow.

    Sends progressShow, progressValue, progressLabel, and progressHide events
    to test the frontend progress widget.

    Args:
        body: Optional dictionary with:
            - steps: Number of progress steps (default: 5)
            - delay_ms: Delay between steps in ms (default: 500)
            - label_prefix: Prefix for step labels (default: "Processing step")

    Returns:
        dict: Summary with status and progress_id

    Note:
        Client must be subscribed to /sse/subscribe before calling this endpoint.
    """
    from ..lib.sse_utils import ProgressBar

    steps = body.get("steps", 5)
    delay_ms = body.get("delay_ms", 500)
    label_prefix = body.get("label_prefix", "Processing step")

    username = user.get('username', 'unknown')

    logger.info(f"SSE progress test requested by {username} (session: {session_id[:8]}...) with {steps} steps")

    # Create progress bar instance
    progress = ProgressBar(sse_service, session_id)

    # Show progress widget
    progress.show(label=f"{label_prefix} 0/{steps}", value=0, cancellable=True)
    logger.debug(f"Progress test: show (progress_id={progress.progress_id})")

    # Run progress simulation in background without blocking
    async def simulate_progress():
        # Simulate progress steps
        for i in range(1, steps + 1):
            await asyncio.sleep(delay_ms / 1000)
            value = int((i / steps) * 100)
            progress.set_value(value)
            progress.set_label(f"{label_prefix} {i}/{steps}")
            logger.debug(f"Progress test: step {i}/{steps}, value={value}")

        # Small delay before hiding
        await asyncio.sleep(delay_ms / 1000)

        # Hide progress widget
        progress.hide()
        logger.debug(f"Progress test: hide (progress_id={progress.progress_id})")

    # Start progress simulation in background
    asyncio.create_task(simulate_progress())
    
    return {
        "status": "ok",
        "progress_id": progress.progress_id,
        "steps_completed": steps
    }

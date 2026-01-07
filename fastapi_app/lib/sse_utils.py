"""
SSE utility functions for broadcasting events to multiple clients.
"""

import json
from typing import Any, Optional
from .sse_service import SSEService
from .sessions import SessionManager, SessionDict


def broadcast_to_other_sessions(
    sse_service: SSEService,
    session_manager: SessionManager,
    current_session_id: str,
    event_type: str,
    data: dict[str, Any],
    logger: Optional[Any] = None
) -> int:
    """
    Broadcast an SSE event to all sessions except the current one.

    Args:
        sse_service: SSE service instance
        session_manager: Session manager instance
        current_session_id: Current session ID (will be excluded from broadcast)
        event_type: SSE event type (e.g., "fileDataChanged")
        data: Event data dictionary (will be JSON-serialized)
        logger: Optional logger instance for debug output

    Returns:
        Number of sessions notified
    """
    active_sessions: list[SessionDict] = session_manager.get_all_sessions()
    notification_count = 0

    for session_dict in active_sessions:
        other_session_id: str = session_dict['session_id']
        if other_session_id != current_session_id:
            sse_service.send_message(
                client_id=other_session_id,
                event_type=event_type,
                data=json.dumps(data)
            )
            notification_count += 1

    if logger and notification_count > 0:
        logger.debug(
            f"Broadcast {event_type} to {notification_count} sessions: {data}"
        )

    return notification_count

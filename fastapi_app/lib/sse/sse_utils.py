"""
SSE utility functions for broadcasting events to multiple clients.

Includes:
- Broadcast functions for sending events to multiple sessions
- ProgressBar class for controlling the frontend progress widget via SSE
- send_notification function for toast notifications
"""

import json
import uuid
from typing import Any, Optional
from fastapi_app.lib.sse.sse_service import SSEService
from fastapi_app.lib.core.sessions import SessionManager, SessionDict


def send_notification(
    sse_service: SSEService,
    session_id: str,
    message: str,
    variant: str = "info",
    icon: str | None = None
) -> bool:
    """
    Send a notification to display as a toast.

    Args:
        sse_service: SSE service instance
        session_id: Target session ID
        message: Notification message text
        variant: Alert variant - "info", "success", "warning", "error"
        icon: Optional icon name

    Returns:
        True if message was queued successfully
    """
    data: dict[str, Any] = {"message": message, "variant": variant}
    if icon:
        data["icon"] = icon
    return sse_service.send_message(
        client_id=session_id,
        event_type="notification",
        data=json.dumps(data)
    )


class ProgressBar:
    """
    Controls a frontend progress widget instance via SSE events.

    Each instance gets a unique progress_id for identification, allowing
    multiple simultaneous progress widgets on the frontend.

    Sends the following SSE event types to the frontend:
    - progressShow: Shows the widget (with progress_id and optional initial settings)
    - progressValue: Sets progress value (0-100) or indeterminate (None)
    - progressLabel: Sets the text label
    - progressHide: Hides the widget

    Example usage:
        ```python
        from fastapi import Depends
        from fastapi_app.lib.core.dependencies import get_sse_service
        from fastapi_app.lib.sse.sse_utils import ProgressBar

        @router.post("/process")
        async def process_files(
            session_id: str,
            sse_service: SSEService = Depends(get_sse_service)
        ):
            progress = ProgressBar(sse_service, session_id)
            # progress.progress_id is auto-generated or can be provided

            progress.show(label="Starting...", cancellable=True)

            for i, file in enumerate(files):
                progress.set_label(f"Processing {file.name}")
                progress.set_value(int((i + 1) / len(files) * 100))
                await process_file(file)

            progress.hide()
        ```
    """

    def __init__(
        self,
        sse_service: SSEService,
        session_id: str,
        progress_id: str | None = None
    ):
        """
        Initialize the progress bar controller.

        Args:
            sse_service: SSE service instance for sending events
            session_id: Target session ID to receive progress events
            progress_id: Optional unique ID for this progress instance.
                         If not provided, a random 8-character ID is generated.
        """
        self._sse_service = sse_service
        self._session_id = session_id
        self._progress_id = progress_id or str(uuid.uuid4())[:8]

    @property
    def progress_id(self) -> str:
        """Return the unique progress ID for this instance."""
        return self._progress_id

    def show(
        self,
        label: Optional[str] = None,
        value: Optional[int] = None,
        cancellable: bool = True,
        cancel_url: Optional[str] = None
    ) -> bool:
        """
        Show the progress widget.

        Args:
            label: Initial text label
            value: Initial progress value (0-100), None for indeterminate
            cancellable: Whether to show the cancel button
            cancel_url: URL to POST to when cancel button is clicked

        Returns:
            True if message was queued successfully
        """
        data: dict[str, Any] = {
            "progress_id": self._progress_id,
            "cancellable": cancellable
        }
        if label is not None:
            data["label"] = label
        if value is not None:
            data["value"] = value
        if cancel_url is not None:
            data["cancelUrl"] = cancel_url

        return self._sse_service.send_message(
            client_id=self._session_id,
            event_type="progressShow",
            data=json.dumps(data)
        )

    def hide(self) -> bool:
        """
        Hide the progress widget.

        Returns:
            True if message was queued successfully
        """
        return self._sse_service.send_message(
            client_id=self._session_id,
            event_type="progressHide",
            data=json.dumps({"progress_id": self._progress_id})
        )

    def set_value(self, value: Optional[int]) -> bool:
        """
        Set the progress value.

        Args:
            value: Progress value (0-100), None for indeterminate mode

        Returns:
            True if message was queued successfully
        """
        data: dict[str, Any] = {"progress_id": self._progress_id, "value": value}
        return self._sse_service.send_message(
            client_id=self._session_id,
            event_type="progressValue",
            data=json.dumps(data)
        )

    def set_label(self, label: str) -> bool:
        """
        Set the text label.

        Args:
            label: Label text to display

        Returns:
            True if message was queued successfully
        """
        data: dict[str, Any] = {"progress_id": self._progress_id, "label": label}
        return self._sse_service.send_message(
            client_id=self._session_id,
            event_type="progressLabel",
            data=json.dumps(data)
        )


def _broadcast_event(
    sse_service: SSEService,
    session_manager: SessionManager,
    event_type: str,
    data: dict[str, Any],
    exclude_session_id: Optional[str] = None,
    logger: Optional[Any] = None
) -> int:
    """
    Generic broadcast function that sends SSE events to sessions.

    Args:
        sse_service: SSE service instance
        session_manager: Session manager instance
        event_type: SSE event type (e.g., "fileDataChanged")
        data: Event data dictionary (will be JSON-serialized)
        exclude_session_id: Optional session ID to exclude from broadcast
        logger: Optional logger instance for debug output

    Returns:
        Number of sessions notified
    """
    active_sessions: list[SessionDict] = session_manager.get_all_sessions()
    notification_count = 0

    for session_dict in active_sessions:
        session_id: str = session_dict['session_id']
        if exclude_session_id is None or session_id != exclude_session_id:
            sse_service.send_message(
                client_id=session_id,
                event_type=event_type,
                data=json.dumps(data)
            )
            notification_count += 1

    if logger and notification_count > 0:
        excluded_msg = f" (excluded session {exclude_session_id[:8]}...)" if exclude_session_id else ""
        logger.debug(
            f"Broadcast {event_type} to {notification_count} sessions{excluded_msg}: {data}"
        )

    return notification_count


def broadcast_to_all_sessions(
    sse_service: SSEService,
    session_manager: SessionManager,
    event_type: str,
    data: dict[str, Any],
    logger: Optional[Any] = None
) -> int:
    """
    Broadcast an SSE event to all active sessions.

    Args:
        sse_service: SSE service instance
        session_manager: Session manager instance
        event_type: SSE event type (e.g., "fileDataChanged")
        data: Event data dictionary (will be JSON-serialized)
        logger: Optional logger instance for debug output

    Returns:
        Number of sessions notified
    """
    return _broadcast_event(
        sse_service=sse_service,
        session_manager=session_manager,
        event_type=event_type,
        data=data,
        exclude_session_id=None,
        logger=logger
    )


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
    return _broadcast_event(
        sse_service=sse_service,
        session_manager=session_manager,
        event_type=event_type,
        data=data,
        exclude_session_id=current_session_id,
        logger=logger
    )

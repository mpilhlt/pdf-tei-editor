"""
SSE-based logging handler.

Broadcasts log records to subscribed SSE clients in real-time.
Only sessions that have explicitly opted in via subscribe_session()
receive log events.
"""

import json
import logging
import threading
import time
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .sse_service import SSEService

# Logger names whose records are never forwarded via SSE to prevent feedback loops.
# SSEService logs while holding its own lock, so forwarding those records
# through this handler would risk deadlocks and infinite recursion.
_SUPPRESSED_LOGGERS = frozenset((
    "fastapi_app.lib.sse_service",
    "fastapi_app.lib.sse_log_handler",
    "fastapi_app.lib.sse_utils",
    "fastapi_app.lib.dependencies",
    "uvicorn.access",
))


class SSELogHandler(logging.Handler):
    """
    Logging handler that broadcasts formatted log records to SSE subscribers.

    Maintains a separate set of subscriber session IDs. Only those sessions
    receive log events, avoiding bandwidth waste for non-subscribed clients.
    """

    SSE_EVENT_TYPE = "logEntry"

    # Thread-local storage for re-entrancy guard
    _local = threading.local()

    # Rate limiting: max messages per second across all subscribers
    _MAX_MESSAGES_PER_SECOND = 200
    _RATE_WARNING_INTERVAL = 10  # seconds between rate-limit warnings

    def __init__(self, sse_service: "SSEService", level: int = logging.DEBUG):
        super().__init__(level)
        self._sse_service = sse_service
        self._log_subscribers: set[str] = set()
        self._lock = threading.Lock()
        # Rate limiting state
        self._msg_count = 0
        self._msg_window_start = time.monotonic()
        self._last_rate_warning = 0.0
        self._dropped_count = 0
        # Periodic pruning counter
        self._emit_counter = 0
        self._PRUNE_EVERY = 50

    def subscribe_session(self, session_id: str) -> None:
        """Add a session to the log subscriber set."""
        with self._lock:
            self._log_subscribers.add(session_id)

    def unsubscribe_session(self, session_id: str) -> None:
        """Remove a session from the log subscriber set."""
        with self._lock:
            self._log_subscribers.discard(session_id)

    def get_subscribers(self) -> set[str]:
        """Return a copy of the current subscriber set."""
        with self._lock:
            return set(self._log_subscribers)

    def emit(self, record: logging.LogRecord) -> None:
        """Broadcast a log record to all subscribed SSE clients."""
        # Re-entrancy guard: prevent infinite recursion if SSEService logs
        if getattr(self._local, "emitting", False):
            return
        self._local.emitting = True
        try:
            self._do_emit(record)
        finally:
            self._local.emitting = False

    def _do_emit(self, record: logging.LogRecord) -> None:
        """Internal emit logic, called within re-entrancy guard."""
        # Skip SSE-related loggers to prevent feedback loops
        if record.name in _SUPPRESSED_LOGGERS or any(
            record.name.startswith(prefix + ".") for prefix in _SUPPRESSED_LOGGERS
        ):
            return

        # Rate limiting check
        now = time.monotonic()
        elapsed = now - self._msg_window_start
        if elapsed >= 1.0:
            self._msg_count = 0
            self._msg_window_start = now
        if self._msg_count >= self._MAX_MESSAGES_PER_SECOND:
            self._dropped_count += 1
            if now - self._last_rate_warning > self._RATE_WARNING_INTERVAL:
                self._last_rate_warning = now
                logging.getLogger(__name__).warning(
                    "SSE log handler rate limit reached (%d msg/s). "
                    "Dropped %d messages since last warning.",
                    self._MAX_MESSAGES_PER_SECOND,
                    self._dropped_count,
                )
                self._dropped_count = 0
            return
        self._msg_count += 1

        # Copy subscribers under lock, do NOT call SSEService methods while locked
        with self._lock:
            if not self._log_subscribers:
                return
            subscribers = set(self._log_subscribers)

        # Periodically prune stale subscribers (outside the lock)
        self._emit_counter += 1
        if self._emit_counter >= self._PRUNE_EVERY:
            self._emit_counter = 0
            try:
                active_clients = set(self._sse_service.get_active_clients())
                stale = subscribers - active_clients
                if stale:
                    with self._lock:
                        self._log_subscribers -= stale
                    subscribers -= stale
                    if not subscribers:
                        return
            except Exception:
                pass

        # Format outside the lock
        try:
            data = json.dumps({
                "timestamp": datetime.fromtimestamp(record.created).strftime(
                    "%Y-%m-%d %H:%M:%S.%f"
                )[:-3],
                "level": record.levelname,
                "logger": record.name,
                "message": record.getMessage(),
            })
        except Exception:
            return

        for session_id in subscribers:
            self._sse_service.send_message(
                client_id=session_id,
                event_type=self.SSE_EVENT_TYPE,
                data=data,
            )

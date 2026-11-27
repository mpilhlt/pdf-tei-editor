"""
Forwards job events to the editor's SSE streams (`/api/v1/sse/subscribe`), so that a browser tab
needs no second long-lived connection for `/api/v1/jobs/events` (browsers allow only six
connections per host on HTTP/1.1).

Each worker subscribes to the event bus of its job manager and sends every event as SSE event
`job` to the sessions whose stream this worker serves and whose user may see the job: the owner,
admins, and everyone for jobs with visibility `users` (the library's `JobManager.can_view` rule).
The data is the event's JSON, as `/api/v1/jobs/events` sends it, plus the job's `owner`. Events
that do not fit into the queue are dropped; the sessions then receive `jobsResync` and list the
jobs again.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi_jobqueue import JobEvent, JobManager

from fastapi_app.lib.core.sessions import SessionDict
from fastapi_app.lib.utils.logging_utils import get_logger

logger = get_logger(__name__)

JOB_EVENT = "job"
RESYNC_EVENT = "jobsResync"
QUEUE_SIZE = 10000


class SseSender(Protocol):
    """The part of `SSEService` the bridge uses."""

    def get_active_clients(self) -> list[str]: ...

    def send_message(self, client_id: str, event_type: str, data: str) -> bool: ...


class SessionSource(Protocol):
    """The part of `SessionManager` the bridge uses."""

    def get_all_sessions(self) -> list[SessionDict]: ...


QueuedEvent = tuple[JobEvent, str, str]
"""An event with the owner and the visibility of its job."""


def may_see(username: str, is_admin: bool, owner: str, visibility: str) -> bool:
    """Whether the user may see a job (mirrors `JobManager.can_view`)."""
    return is_admin or username == owner or visibility == "users"


def deliver(
    events: Iterable[QueuedEvent],
    sse_service: SseSender,
    sessions: SessionSource,
    is_admin: Callable[[str], bool],
    resync: bool = False,
) -> int:
    """
    Send events to the sessions of this worker whose user may see them (blocking; run in a thread).

    Args:
        events: The events with the owner and visibility of their jobs
        sse_service: The SSE service of this worker
        sessions: The session manager, to find the user of a session
        is_admin: Whether a user is an admin
        resync: Send `jobsResync` to every session first, since events were lost

    Returns:
        The number of messages sent
    """
    active = set(sse_service.get_active_clients())
    if not active:
        return 0
    targets = [(s["session_id"], s["username"]) for s in sessions.get_all_sessions() if s["session_id"] in active]
    admins: dict[str, bool] = {}
    sent = 0
    if resync:
        for session_id, _username in targets:
            sent += sse_service.send_message(session_id, RESYNC_EVENT, "{}")
    for event, owner, visibility in events:
        data = json.dumps({**event.model_dump(mode="json"), "owner": owner})
        for session_id, username in targets:
            if username not in admins:
                admins[username] = is_admin(username)
            if may_see(username, admins[username], owner, visibility):
                sent += sse_service.send_message(session_id, JOB_EVENT, data)
    return sent


class JobSseBridge:
    """Forwards the job events of a manager to the SSE streams of this worker."""

    def __init__(self, manager: JobManager, sse_service: SseSender, sessions: SessionSource, is_admin: Callable[[str], bool], queue_size: int = QUEUE_SIZE) -> None:
        self._manager = manager
        self._sse_service = sse_service
        self._sessions = sessions
        self._is_admin = is_admin
        self._queue: asyncio.Queue[QueuedEvent] = asyncio.Queue(maxsize=queue_size)
        self._overflowed = False

    def _accept(self, event: JobEvent, owner: str, visibility: str) -> bool:
        """Event bus filter: queues the event here and declines it, so that the bus's own queue stays empty."""
        try:
            self._queue.put_nowait((event, owner, visibility))
        except asyncio.QueueFull:
            self._overflowed = True
        return False

    async def run(self) -> None:
        """Forward events until cancelled."""
        subscription = self._manager.events.subscribe(self._accept)
        try:
            while True:
                batch = [await self._queue.get()]
                while not self._queue.empty():
                    batch.append(self._queue.get_nowait())
                resync, self._overflowed = self._overflowed, False
                if resync:
                    logger.warning("Job events were dropped; the sessions list the jobs again")
                try:
                    await asyncio.to_thread(deliver, batch, self._sse_service, self._sessions, self._is_admin, resync)
                except Exception:
                    logger.exception("Could not forward job events to the SSE streams")
        finally:
            self._manager.events.unsubscribe(subscription)


def _is_admin(username: str) -> bool:
    from fastapi_app.lib.core.dependencies import get_auth_manager
    from fastapi_app.lib.permissions.acl_utils import user_is_admin

    user: dict[str, Any] | None = get_auth_manager().get_user_by_username(username)
    return user is not None and user_is_admin(user)


@asynccontextmanager
async def job_sse_bridge() -> AsyncIterator[None]:
    """Forward the job events of this worker's manager to its SSE streams while the context is open (the app lifespan)."""
    from fastapi_app.lib.core.dependencies import get_session_manager, get_sse_service

    from .manager import get_job_manager

    bridge = JobSseBridge(get_job_manager(), get_sse_service(), get_session_manager(), _is_admin)
    task = asyncio.create_task(bridge.run(), name="job-sse-bridge")
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

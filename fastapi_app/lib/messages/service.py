"""
Wiring of the message index into the application: singletons, access-filtered counting,
`messagesChanged` notifications, and the event hooks that re-index saved and deleted files.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path
from typing import Any

from fastapi_app.config import get_settings
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.lib.permissions.access_control import check_file_access
from fastapi_app.lib.permissions.user_utils import list_users
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.sse.sse_service import SSEService
from fastapi_app.lib.sse.sse_utils import send_to_user_sessions
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.config_utils import get_config

from .indexer import IndexContext, MessageIndexer, UserInfo
from .store import DB_FILE_NAME, MessageRow, MessageStore

logger = logging.getLogger(__name__)

_stores: dict[str, MessageStore] = {}
_stores_lock = threading.Lock()
# Indexing runs serialized, so that two saves do not interleave their updates of shared keys
_index_lock = threading.Lock()


def get_message_store(db_dir: Path | None = None) -> MessageStore:
    """The message store of a db directory (default: the configured one)."""
    db_dir = Path(db_dir or get_settings().db_dir)
    with _stores_lock:
        store = _stores.get(str(db_dir))
        if store is None:
            store = MessageStore(db_dir)
            _stores[str(db_dir)] = store
        return store


def reset_message_stores() -> None:
    """Forgets the store singletons (tests)."""
    with _stores_lock:
        _stores.clear()


def default_index_context(db_dir: Path | None = None) -> IndexContext:
    """The current users and review mode."""
    users = {
        u["username"]: UserInfo(username=u["username"], fullname=u.get("fullname") or None, roles=list(u.get("roles") or []))
        for u in list_users(Path(db_dir or get_settings().db_dir))
        if u.get("username")
    }
    mode = get_config().get("unit-review.mode", default="majority")
    return IndexContext(users=users, review_mode="final" if mode == "final" else "majority")


def make_indexer(file_repo: FileRepository, file_storage: FileStorage, db_dir: Path | None = None) -> MessageIndexer:
    """An indexer over the given repository and storage."""
    return MessageIndexer(
        store=get_message_store(db_dir),
        file_repo=file_repo,
        file_storage=file_storage,
        context_provider=lambda: default_index_context(db_dir),
    )


def index_file_locked(indexer: MessageIndexer, stable_id: str) -> set[str]:
    """Re-indexes a file under the index lock; returns the recipients whose messages changed."""
    with _index_lock:
        return indexer.index_file(stable_id)


def remove_file_locked(indexer: MessageIndexer, stable_id: str) -> set[str]:
    """Removes a file from the index under the index lock; returns the recipients whose messages changed."""
    with _index_lock:
        return indexer.remove_file(stable_id)


def rebuild_index(file_repo: FileRepository, file_storage: FileStorage, db_dir: Path | None = None) -> int:
    """Rebuilds the whole index; returns the number of indexed files."""
    with _index_lock:
        return make_indexer(file_repo, file_storage, db_dir).rebuild()


# ── Access-filtered views ───────────────────────────────────────────────


class AccessCache:
    """Caches file metadata and view access for one request."""

    def __init__(self, file_repo: FileRepository, user: dict[str, Any]):
        self.file_repo = file_repo
        self.user = user
        self._files: dict[str, FileMetadata | None] = {}
        self._access: dict[str, bool] = {}

    def file(self, stable_id: str) -> FileMetadata | None:
        if stable_id not in self._files:
            self._files[stable_id] = self.file_repo.get_file_by_stable_id(stable_id)
        return self._files[stable_id]

    def can_view(self, stable_id: str) -> bool:
        if stable_id not in self._access:
            file = self.file(stable_id)
            self._access[stable_id] = file is not None and not file.deleted and check_file_access(file, self.user, "read")
        return self._access[stable_id]


def visible_messages(store: MessageStore, cache: AccessCache, unread_only: bool = False, kind: str | None = None) -> list[MessageRow]:
    """The messages of the cache's user in files the user can view, newest first."""
    rows = store.list_messages(cache.user["username"], unread_only=unread_only, kind=kind)  # type: ignore[arg-type]
    return [row for row in rows if cache.can_view(row.stable_id)]


def unread_count(store: MessageStore, file_repo: FileRepository, user: dict[str, Any]) -> int:
    """The number of unread messages of a user in files the user can view."""
    return len(visible_messages(store, AccessCache(file_repo, user), unread_only=True))


# ── Notifications ───────────────────────────────────────────────────────


def notify_recipients(
    recipients: set[str],
    store: MessageStore,
    file_repo: FileRepository,
    sse_service: SSEService,
    session_manager: SessionManager,
) -> None:
    """Sends `messagesChanged` with the new unread count to all sessions of each recipient."""
    if not recipients:
        return
    users = {u["username"]: u for u in list_users(Path(get_settings().db_dir)) if u.get("username")}
    for username in recipients:
        user = users.get(username)
        if user is None:
            continue
        send_to_user_sessions(
            sse_service, session_manager, username, "messagesChanged",
            {"unread": unread_count(store, file_repo, user)},
        )


# ── Event hooks ─────────────────────────────────────────────────────────


async def _reindex_and_notify(stable_id: str, remove: bool) -> None:
    from fastapi_app.lib.core.dependencies import (
        get_db,
        get_file_storage,
        get_session_manager,
        get_sse_service,
    )

    file_repo = FileRepository(get_db())
    indexer = make_indexer(file_repo, get_file_storage())
    recipients = await asyncio.to_thread(remove_file_locked if remove else index_file_locked, indexer, stable_id)
    notify_recipients(recipients, indexer.store, file_repo, get_sse_service(), get_session_manager())


async def on_document_saved(stable_id: str, **kwargs: Any) -> None:
    """`document.saved` handler: re-indexes the saved file."""
    if stable_id:
        await _reindex_and_notify(stable_id, remove=False)


async def on_file_deleted(stable_id: str, **kwargs: Any) -> None:
    """`file.deleted` handler: removes the file from the index."""
    if stable_id:
        await _reindex_and_notify(stable_id, remove=True)


def register_message_hooks() -> None:
    """Subscribes the indexer to the file events (once per process)."""
    from fastapi_app.lib.sse.event_bus import get_event_bus

    if _hooks_registered.is_set():
        return
    bus = get_event_bus()
    bus.on("document.saved", on_document_saved)
    bus.on("file.deleted", on_file_deleted)
    _hooks_registered.set()


_hooks_registered = threading.Event()


def message_index_exists(db_dir: Path | None = None) -> bool:
    """Whether `messages.db` exists (before the store is first opened)."""
    return (Path(db_dir or get_settings().db_dir) / DB_FILE_NAME).exists()

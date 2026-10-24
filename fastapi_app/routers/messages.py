"""
Messages API: review marks and comments addressed to the current user (see docs/user-manual/messages.md).

Messages come from the message index (`fastapi_app/lib/messages/`). Lists and counts only
include messages from files the user can view at request time.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, Query

from ..lib.core.dependencies import (
    get_file_repository,
    get_file_storage,
    get_session_manager,
    get_sse_service,
    require_admin_user,
    require_authenticated_user,
)
from ..lib.core.sessions import SessionManager
from ..lib.messages.service import (
    AccessCache,
    get_message_store,
    rebuild_index,
    unread_count,
    visible_messages,
)
from ..lib.messages.store import MessageRow, MessageStore
from ..lib.models.models import FileMetadata
from ..lib.models.models_messages import (
    MarkReadRequest,
    MessageCountResponse,
    MessageItem,
    MessageListResponse,
    RebuildResponse,
)
from ..lib.repository.file_repository import FileRepository
from ..lib.sse.sse_service import SSEService
from ..lib.sse.sse_utils import send_to_user_sessions
from ..lib.storage.file_storage import FileStorage

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/messages", tags=["messages"])


def get_store() -> MessageStore:
    """The message store (dependency, so tests can replace it)."""
    return get_message_store()


class _DocLabels:
    """Labels of documents, cached for one request."""

    def __init__(self, file_repo: FileRepository):
        self.file_repo = file_repo
        self._titles: dict[str, str] = {}

    def label(self, file: FileMetadata | None, doc_id: str) -> str:
        if doc_id not in self._titles:
            pdf = self.file_repo.get_pdf_for_document(doc_id)
            title = (pdf.doc_metadata or {}).get("title") if pdf else None
            self._titles[doc_id] = str(title or (pdf.label if pdf else None) or doc_id)
        title = self._titles[doc_id]
        if file is not None and file.label and file.label != title:
            return f"{title}, {file.label}"
        return title


def _to_item(row: MessageRow, cache: AccessCache, labels: _DocLabels) -> MessageItem:
    return MessageItem(
        key=row.key, kind=row.kind, reason=row.reason, doc_id=row.doc_id, stable_id=row.stable_id,
        doc_label=labels.label(cache.file(row.stable_id), row.doc_id), author=row.author,
        author_name=row.author_name, text=row.text, excerpt=row.excerpt, thread_id=row.thread_id,
        fingerprint=row.fingerprint, settled=row.settled, settled_note=row.settled_note, read=row.read,
        created_at=row.created_at,
    )


def _notify_own_sessions(
    user: dict, store: MessageStore, file_repo: FileRepository, sse_service: SSEService, session_manager: SessionManager
) -> int:
    """Sends the new count to all sessions of the user (other tabs) and returns it."""
    count = unread_count(store, file_repo, user)
    send_to_user_sessions(sse_service, session_manager, user["username"], "messagesChanged", {"unread": count})
    return count


@router.get("/count", response_model=MessageCountResponse)
def get_message_count(
    user: dict = Depends(require_authenticated_user),
    store: MessageStore = Depends(get_store),
    file_repo: FileRepository = Depends(get_file_repository),
) -> MessageCountResponse:
    """The number of unread messages of the current user."""
    return MessageCountResponse(unread=unread_count(store, file_repo, user))


@router.get("", response_model=MessageListResponse)
def list_messages(
    status: Literal["unread", "all"] = Query("all"),
    kind: Literal["review", "comment"] | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(require_authenticated_user),
    store: MessageStore = Depends(get_store),
    file_repo: FileRepository = Depends(get_file_repository),
) -> MessageListResponse:
    """The messages of the current user, newest first."""
    cache = AccessCache(file_repo, user)
    rows = visible_messages(store, cache, unread_only=status == "unread", kind=kind)
    unread = len(visible_messages(store, cache, unread_only=True))
    labels = _DocLabels(file_repo)
    items = [_to_item(row, cache, labels) for row in rows[offset:offset + limit]]
    return MessageListResponse(items=items, total=len(rows), unread=unread)


@router.post("/read", response_model=MessageCountResponse)
def mark_read(
    request: MarkReadRequest,
    user: dict = Depends(require_authenticated_user),
    store: MessageStore = Depends(get_store),
    file_repo: FileRepository = Depends(get_file_repository),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
) -> MessageCountResponse:
    """Marks messages of the current user as read or unread; returns the new unread count."""
    store.set_read(user["username"], request.keys, request.read)
    return MessageCountResponse(unread=_notify_own_sessions(user, store, file_repo, sse_service, session_manager))


@router.post("/read-all", response_model=MessageCountResponse)
def mark_all_read(
    user: dict = Depends(require_authenticated_user),
    store: MessageStore = Depends(get_store),
    file_repo: FileRepository = Depends(get_file_repository),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
) -> MessageCountResponse:
    """Marks all unread messages of the current user as read."""
    keys = [row.key for row in store.list_messages(user["username"], unread_only=True)]
    store.set_read(user["username"], keys, True)
    return MessageCountResponse(unread=_notify_own_sessions(user, store, file_repo, sse_service, session_manager))


@router.post("/rebuild", response_model=RebuildResponse)
def rebuild_messages(
    user: dict = Depends(require_admin_user),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage),
) -> RebuildResponse:
    """Rebuilds the message index from all TEI files (admin). Keeps the read state."""
    files = rebuild_index(file_repo, file_storage)
    logger.info(f"Message index rebuilt from {files} TEI files by {user.get('username')}")
    return RebuildResponse(files=files)

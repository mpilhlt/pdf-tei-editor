"""
Bookmarks API: the current user's bookmarks on elements of TEI documents (see docs/user-manual/bookmarks.md).

Bookmarks are private: every endpoint only reads and changes the bookmarks of the current user.
A bookmark can only be added to an element below `/TEI/text` of a file the user can view. Changes
are sent to the user's other sessions as the SSE event `bookmarksChanged`.
"""

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query

from ..lib.bookmarks.store import Bookmark, BookmarkStore, get_bookmark_store
from ..lib.core.dependencies import (
    get_file_repository,
    get_session_manager,
    get_sse_service,
    require_authenticated_user,
)
from ..lib.core.sessions import SessionManager
from ..lib.models.models import FileMetadata
from ..lib.models.models_bookmarks import (
    BookmarkItem,
    BookmarkListResponse,
    CreateBookmarkRequest,
    DeleteBookmarkResponse,
    UpdateBookmarkRequest,
)
from ..lib.permissions.access_control import check_file_access
from ..lib.repository.doc_labels import DocLabels
from ..lib.repository.file_repository import FileRepository
from ..lib.sse.sse_service import SSEService
from ..lib.sse.sse_utils import send_to_user_sessions

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/bookmarks", tags=["bookmarks"])

# An XPath of an element below /TEI/text, as written by elementPath() in app/src/modules/node-anchor.js
TEXT_ELEMENT_PATH = re.compile(r"^/TEI/text(?:\[1\])?(?:/[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?(?:\[\d+\])?)+$")


def get_store() -> BookmarkStore:
    """The bookmark store (dependency, so tests can replace it)."""
    return get_bookmark_store()


def _readable(file: FileMetadata | None, user: dict) -> bool:
    return file is not None and not file.deleted and check_file_access(file, user, "read")


def _to_item(bookmark: Bookmark, user: dict, file_repo: FileRepository, labels: DocLabels) -> BookmarkItem:
    file = file_repo.get_file_by_stable_id(bookmark.stable_id)
    available = _readable(file, user)
    return BookmarkItem(
        id=bookmark.id, stable_id=bookmark.stable_id, doc_id=bookmark.doc_id,
        doc_label=labels.label(file, bookmark.doc_id) if available else bookmark.doc_id,
        path=bookmark.path, fingerprint=bookmark.fingerprint, element=bookmark.element, title=bookmark.title,
        excerpt=bookmark.excerpt, available=available, created_at=bookmark.created_at,
        updated_at=bookmark.updated_at,
    )


def _notify(user: dict, sse_service: SSEService, session_manager: SessionManager) -> None:
    send_to_user_sessions(sse_service, session_manager, user["username"], "bookmarksChanged", {})


@router.get("", response_model=BookmarkListResponse)
def list_bookmarks(
    stable_id: str | None = Query(None, description="Only the bookmarks of this file"),
    user: dict = Depends(require_authenticated_user),
    store: BookmarkStore = Depends(get_store),
    file_repo: FileRepository = Depends(get_file_repository),
) -> BookmarkListResponse:
    """The bookmarks of the current user, newest first."""
    labels = DocLabels(file_repo)
    return BookmarkListResponse(
        items=[_to_item(b, user, file_repo, labels) for b in store.list(user["username"], stable_id)]
    )


@router.post("", response_model=BookmarkItem)
def create_bookmark(
    request: CreateBookmarkRequest,
    user: dict = Depends(require_authenticated_user),
    store: BookmarkStore = Depends(get_store),
    file_repo: FileRepository = Depends(get_file_repository),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
) -> BookmarkItem:
    """Adds a bookmark on an element below `/TEI/text` of a file the user can view."""
    file = file_repo.get_file_by_stable_id(request.stable_id)
    if not _readable(file, user):
        raise HTTPException(status_code=404, detail="File not found")
    assert file is not None
    if file.file_type != "tei":
        raise HTTPException(status_code=400, detail="Bookmarks can only be added to TEI documents")
    if not TEXT_ELEMENT_PATH.match(request.path):
        raise HTTPException(status_code=400, detail="Bookmarks can only be added to elements inside the text")
    bookmark = store.add(
        user["username"], file.stable_id, file.doc_id, request.path, request.fingerprint, request.element,
        request.title, request.excerpt or None,
    )
    logger.info(f"Bookmark {bookmark.id} added by {user['username']} on {file.stable_id}")
    _notify(user, sse_service, session_manager)
    return _to_item(bookmark, user, file_repo, DocLabels(file_repo))


@router.patch("/{bookmark_id}", response_model=BookmarkItem)
def update_bookmark(
    bookmark_id: str,
    request: UpdateBookmarkRequest,
    user: dict = Depends(require_authenticated_user),
    store: BookmarkStore = Depends(get_store),
    file_repo: FileRepository = Depends(get_file_repository),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
) -> BookmarkItem:
    """Renames a bookmark of the current user."""
    bookmark = store.rename(user["username"], bookmark_id, request.title)
    if bookmark is None:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    _notify(user, sse_service, session_manager)
    return _to_item(bookmark, user, file_repo, DocLabels(file_repo))


@router.delete("/{bookmark_id}", response_model=DeleteBookmarkResponse)
def delete_bookmark(
    bookmark_id: str,
    user: dict = Depends(require_authenticated_user),
    store: BookmarkStore = Depends(get_store),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
) -> DeleteBookmarkResponse:
    """Deletes a bookmark of the current user."""
    if not store.delete(user["username"], bookmark_id):
        raise HTTPException(status_code=404, detail="Bookmark not found")
    _notify(user, sse_service, session_manager)
    return DeleteBookmarkResponse(deleted=True)

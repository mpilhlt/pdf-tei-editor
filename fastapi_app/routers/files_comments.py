"""
Review marks and comments in files the user cannot edit (see docs/user-manual/editing-workflow.md).

Reviewing and commenting only need view access and a role, not ownership or the file lock:
reviewers set review marks and comment, annotators comment, in any file that is not frozen. The
server writes the user's contribution into the stored file in place (same stable_id, no new
version, no revision change); only the standOff and the respStmts change.

- `PUT /files/{stable_id}/standoff`: the editor of a read-only document sends its text; the
  server takes the user's own review annotation and comments from it (`standoff_merge.py`).
- `POST /files/{stable_id}/comments/{thread_id}/replies`: a reply from the Messages dialog.

A session that has the file open for editing merges new replies into its editor
(`commentReplyAdded`), and saving over the file keeps the other users' contributions (see
`files_save.py`).
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from lxml import etree

from ..lib.core.dependencies import (
    get_file_repository,
    get_file_storage,
    get_session_id,
    get_session_manager,
    get_sse_service,
    require_authenticated_user,
)
from ..lib.core.sessions import SessionManager
from ..lib.messages.comment_edit import ThreadNotFoundError, _element_span, add_reply
from ..lib.messages.standoff_merge import apply_contribution
from ..lib.messages.standoff_reader import COMMENT_LIST_TYPE, UnitComment, find_standoff_list, read_comments
from ..lib.models import FileMetadata, FileUpdate
from ..lib.models.models_messages import ReplyRequest, ReplyResponse, StandOffSaveRequest, StandOffSaveResponse
from ..lib.permissions.access_control import check_file_access
from ..lib.repository.file_repository import FileRepository
from ..lib.sse.event_bus import get_event_bus
from ..lib.sse.sse_service import SSEService
from ..lib.sse.sse_utils import broadcast_to_other_sessions
from ..lib.storage.file_storage import FileStorage

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/files", tags=["files"])

REPLY_ROLES = ("annotator", "reviewer", "admin", "*")
REVIEW_ROLES = ("reviewer", "admin", "*")

# Serializes the read-modify-write of one file's contributions
_file_locks: dict[str, asyncio.Lock] = {}


def _has_role(user: dict, roles: tuple[str, ...]) -> bool:
    return any(role in (user.get("roles") or []) for role in roles)


def _writable_file(stable_id: str, user: dict, file_repo: FileRepository) -> FileMetadata:
    """The TEI file a user may contribute to, or an HTTP error."""
    file = file_repo.get_file_by_stable_id(stable_id)
    if file is None or file.file_type != "tei":
        raise HTTPException(status_code=404, detail="File not found")
    if not check_file_access(file, user, "read"):
        raise HTTPException(status_code=403, detail="Access denied")
    if file_repo.is_frozen(stable_id):
        raise HTTPException(status_code=409, detail="This version is superseded by a newer version and cannot be changed.")
    return file


def _store(file: FileMetadata, xml: str, file_repo: FileRepository, file_storage: FileStorage) -> None:
    xml_bytes = xml.encode("utf-8")
    saved_hash, _ = file_storage.save_file(xml_bytes, "tei", increment_ref=False)
    if saved_hash != file.id:
        file_repo.update_file(file.id, FileUpdate(id=saved_hash, file_size=len(xml_bytes)))


def _new_replies(before: str, after: str) -> list[tuple[str, str, str]]:
    """Replies in `after` that `before` lacks, as (thread id, comment id, annotation markup)."""
    def comments(xml: str) -> list[UnitComment]:
        return read_comments(find_standoff_list(etree.fromstring(xml.encode("utf-8")), COMMENT_LIST_TYPE))

    known = {c.id for c in comments(before)}
    found: list[tuple[str, str, str]] = []
    for comment in comments(after):
        if comment.reply_to and comment.id not in known:
            start, end = _element_span(after, "annotation", comment.id)
            found.append((comment.reply_to, comment.id, after[start:end]))
    return found


@router.put("/{stable_id}/standoff", response_model=StandOffSaveResponse)
async def save_standoff_contribution(
    stable_id: str,
    request: StandOffSaveRequest,
    user: dict = Depends(require_authenticated_user),
    session_id: str | None = Depends(get_session_id),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
) -> StandOffSaveResponse:
    """Saves the user's review marks and comments from the text of their editor into a TEI file."""
    reviews = _has_role(user, REVIEW_ROLES)
    comments = _has_role(user, REPLY_ROLES)
    if not reviews and not comments:
        raise HTTPException(status_code=403, detail="Only annotators and reviewers can review or comment")
    username = user["username"]
    lock = _file_locks.setdefault(stable_id, asyncio.Lock())
    async with lock:
        file = _writable_file(stable_id, user, file_repo)
        content = file_storage.read_file(file.id, "tei")
        if content is None:
            raise HTTPException(status_code=404, detail="File content not found")
        stored = content.decode("utf-8")
        try:
            merged = apply_contribution(stored, request.xml_string, username, user.get("fullname") or username, reviews=reviews, comments=comments)
        except etree.XMLSyntaxError as e:
            raise HTTPException(status_code=400, detail=f"The XML is not well-formed: {e}")
        if merged == stored:
            return StandOffSaveResponse(stable_id=stable_id, status="unchanged")
        _store(file, merged, file_repo, file_storage)
        replies = _new_replies(stored, merged)

    events: list[tuple[str, dict]] = [("fileDataChanged", {"reason": "standoff", "stable_id": stable_id})]
    events += [
        ("commentReplyAdded", {
            "stable_id": stable_id, "thread_id": thread_id, "comment_id": comment_id, "annotation_xml": markup,
            "author": username, "author_name": user.get("fullname") or username,
        })
        for thread_id, comment_id, markup in replies
    ]
    for event_type, data in events:
        broadcast_to_other_sessions(
            sse_service=sse_service, session_manager=session_manager, current_session_id=session_id or "",
            event_type=event_type, data=data, logger=logger,
        )
    await get_event_bus().emit("document.saved", stable_id=stable_id, doc_id=file.doc_id, username=username)
    return StandOffSaveResponse(stable_id=stable_id, status="saved")


@router.post("/{stable_id}/comments/{thread_id}/replies", response_model=ReplyResponse)
async def add_comment_reply(
    stable_id: str,
    thread_id: str,
    request: ReplyRequest,
    user: dict = Depends(require_authenticated_user),
    session_id: str | None = Depends(get_session_id),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
) -> ReplyResponse:
    """Adds a reply to a comment thread of a TEI file."""
    if not _has_role(user, REPLY_ROLES):
        raise HTTPException(status_code=403, detail="Only annotators and reviewers can reply to comments")
    username = user["username"]
    lock = _file_locks.setdefault(stable_id, asyncio.Lock())
    async with lock:
        file = _writable_file(stable_id, user, file_repo)
        content = file_storage.read_file(file.id, "tei")
        if content is None:
            raise HTTPException(status_code=404, detail="File content not found")
        try:
            result = add_reply(content.decode("utf-8"), thread_id, username, user.get("fullname") or username, request.text.strip())
        except ThreadNotFoundError:
            raise HTTPException(status_code=404, detail="Comment thread not found")
        _store(file, result.xml, file_repo, file_storage)

    for event_type, data in (
        ("fileDataChanged", {"reason": "comment_reply", "stable_id": stable_id}),
        ("commentReplyAdded", {
            "stable_id": stable_id, "thread_id": thread_id, "comment_id": result.comment_id,
            "annotation_xml": result.annotation_xml, "author": username, "author_name": user.get("fullname") or username,
        }),
    ):
        broadcast_to_other_sessions(
            sse_service=sse_service, session_manager=session_manager, current_session_id=session_id or "",
            event_type=event_type, data=data, logger=logger,
        )
    await get_event_bus().emit("document.saved", stable_id=stable_id, doc_id=file.doc_id, username=username)
    return ReplyResponse(stable_id=stable_id, thread_id=thread_id, comment_id=result.comment_id, annotation_xml=result.annotation_xml)

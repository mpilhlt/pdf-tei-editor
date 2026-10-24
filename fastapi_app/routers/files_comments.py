"""
Replies to unit comment threads in files the user cannot edit (see docs/user-manual/messages.md).

Replying to an existing thread only needs view access and the annotator or reviewer role, not
ownership or the file lock. The server adds the reply to the stored file in place (same
stable_id, no new version, no revision change); only the standOff and the respStmts change.
The session that has the file open merges the reply into its editor (`commentReplyAdded`), and
saving over the file puts back replies its text lacks (see `files_save.py`).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

from ..lib.core.dependencies import (
    get_file_repository,
    get_file_storage,
    get_session_id,
    get_session_manager,
    get_sse_service,
    require_authenticated_user,
)
from ..lib.core.sessions import SessionManager
from ..lib.messages.comment_edit import ThreadNotFoundError, add_reply
from ..lib.models import FileUpdate
from ..lib.models.models_messages import ReplyRequest, ReplyResponse
from ..lib.permissions.access_control import check_file_access
from ..lib.repository.file_repository import FileRepository
from ..lib.sse.event_bus import get_event_bus
from ..lib.sse.sse_service import SSEService
from ..lib.sse.sse_utils import broadcast_to_other_sessions
from ..lib.storage.file_storage import FileStorage

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/files", tags=["files"])

REPLY_ROLES = ("annotator", "reviewer", "admin", "*")


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
    if not any(role in (user.get("roles") or []) for role in REPLY_ROLES):
        raise HTTPException(status_code=403, detail="Only annotators and reviewers can reply to comments")
    file = file_repo.get_file_by_stable_id(stable_id)
    if file is None or file.file_type != "tei":
        raise HTTPException(status_code=404, detail="File not found")
    if not check_file_access(file, user, "read"):
        raise HTTPException(status_code=403, detail="Access denied")
    if file_repo.is_frozen(stable_id):
        raise HTTPException(status_code=409, detail="This version is superseded by a newer version and cannot be changed.")
    content = file_storage.read_file(file.id, "tei")
    if content is None:
        raise HTTPException(status_code=404, detail="File content not found")

    username = user["username"]
    try:
        result = add_reply(content.decode("utf-8"), thread_id, username, user.get("fullname") or username, request.text.strip())
    except ThreadNotFoundError:
        raise HTTPException(status_code=404, detail="Comment thread not found")

    xml_bytes = result.xml.encode("utf-8")
    saved_hash, _ = file_storage.save_file(xml_bytes, "tei", increment_ref=False)
    if saved_hash != file.id:
        file_repo.update_file(file.id, FileUpdate(id=saved_hash, file_size=len(xml_bytes)))

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

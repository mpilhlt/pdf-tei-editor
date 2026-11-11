"""
File locks API router for FastAPI.

Implements lock management endpoints:
- GET /api/files/locks - List all active locks
- POST /api/files/check_lock - Check lock status for a file
- POST /api/files/acquire_lock - Acquire lock for editing
- POST /api/files/release_lock - Release lock

Key changes from Flask:
- Hash-based file identification (stable_id or full hashes accepted)
- Otherwise identical to Flask (reuses lib/locking.py)
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from ..lib.core.locking import acquire_lock, release_lock, check_lock, get_locked_file_ids, get_lock_holder_notice
from ..lib.repository.file_repository import FileRepository
from ..lib.models.models_files import (
    GetLocksResponse,
    AcquireLockRequest,
    ReleaseLockRequest,
    ReleaseLockResponse,
    CheckLockRequest,
    CheckLockResponse,
    LockedDetail
)
from ..lib.core.dependencies import (
    get_file_repository,
    get_session_id,
    get_current_user,
    get_sse_service,
    get_session_manager
)
from ..lib.permissions.access_control import check_file_access
from ..config import get_settings
from ..lib.utils.logging_utils import get_logger
from ..lib.sse.sse_service import SSEService
from ..lib.core.sessions import SessionManager
from ..lib.sse.sse_utils import broadcast_to_other_sessions
from ..lib.sse.event_bus import get_event_bus


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


def _emit_lock_changed(stable_id: str) -> None:
    """Notify listeners (e.g. sync plugins) that the lock state of a file changed."""
    get_event_bus().emit_from_thread("file.lock_changed", stable_id=stable_id)


def describe_lock_holder(
    holder_id: Optional[str],
    current_username: Optional[str],
    session_manager: SessionManager
) -> LockedDetail:
    """
    Describe who holds a lock, for the 423 response of acquire_lock.

    Args:
        holder_id: The session id under which the lock is held, None if it is not known
        current_username: The user requesting the lock
        session_manager: Session manager to look up the user of the holding session

    Returns:
        LockedDetail with the kind of holder and the notice to show
    """
    if holder_id:
        notice = get_lock_holder_notice(holder_id)
        if notice:
            return LockedDetail(holder="process", message=notice)
        username = session_manager.get_username_by_session_id(holder_id)
        if username and username == current_username:
            return LockedDetail(
                holder="own_session",
                username=username,
                message="You have this document open for editing in another window or session, so it opens read-only here"
            )
        if username:
            return LockedDetail(holder="user", username=username, message=f"This document is being edited by {username}")
    return LockedDetail(holder="user", message="This document is being edited by another user")


@router.get("/locks", response_model=GetLocksResponse)
def get_all_locks(
    repo: FileRepository = Depends(get_file_repository),
    session_id: str = Depends(get_session_id)
) -> GetLocksResponse:
    """
    Get all active locks for the current session.

    Returns a list of file stable_ids locked by this session.

    Args:
        repo: File repository (injected)
        session_id: Current session ID (injected)

    Returns:
        GetLocksResponse: List of file stable_ids locked by this session
    """
    settings = get_settings()
    locked_ids = get_locked_file_ids(settings.db_dir, logger, session_id=session_id, repo=repo)
    return GetLocksResponse(locked_files=locked_ids)


@router.post("/check_lock", response_model=CheckLockResponse)
def check_lock_endpoint(
    request: CheckLockRequest,
    repo: FileRepository = Depends(get_file_repository),
    session_id: str = Depends(get_session_id)
):
    """
    Check if a file is locked.

    Args:
        request: CheckLockRequest with file_id (stable_id or full hash)
        repo: File repository (injected)
        session_id: Current session ID (injected)

    Returns:
        CheckLockResponse with is_locked and locked_by fields
    """
    # Look up file by ID or stable_id
    file_metadata = repo.get_file_by_id_or_stable_id(request.file_id)
    if not file_metadata:
        return CheckLockResponse(is_locked=False, locked_by=None)

    settings = get_settings()
    lock_status = check_lock(file_metadata.stable_id, session_id, settings.db_dir, logger)

    return CheckLockResponse(**lock_status)


@router.post("/acquire_lock")
def acquire_lock_endpoint(
    request: AcquireLockRequest,
    repo: FileRepository = Depends(get_file_repository),
    session_id: str = Depends(get_session_id),
    current_user: dict = Depends(get_current_user),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager)
) -> str:
    """
    Acquire a lock for editing.

    Args:
        request: AcquireLockRequest with file_id (stable_id or full hash)
        repo: File repository (injected)
        session_id: Current session ID (injected)
        current_user: Current user dict (injected)
        sse_service: SSE service (injected)
        session_manager: Session manager (injected)

    Returns:
        "OK" string on success (matches Flask API)

    Raises:
        HTTPException: 403 if insufficient permissions, 404 if file not found, 423 if cannot acquire lock,
            with a LockedDetail that says who holds the lock
    """
    session_id_short = session_id[:8] if session_id else "unknown"
    logger.debug(f"[LOCK API] Session {session_id_short}... requesting lock for {request.file_id}")

    # Look up file by ID or stable_id
    file_metadata = repo.get_file_by_id_or_stable_id(request.file_id)
    if not file_metadata:
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_id}")

    # Check edit permissions
    if not check_file_access(file_metadata, current_user, 'edit'):
        logger.warning(
            f"[LOCK API] Session {session_id_short}... DENIED due to insufficient permissions"
        )
        raise HTTPException(
            status_code=403,
            detail="Access denied: You don't have permission to edit this document"
        )

    # Frozen versions (other versions were copied from them) cannot be edited
    if repo.is_frozen(file_metadata.stable_id):
        raise HTTPException(
            status_code=403,
            detail="This version is superseded by a newer version and cannot be changed"
        )

    # Acquire lock
    settings = get_settings()
    if acquire_lock(file_metadata.stable_id, session_id, settings.db_dir, logger):
        logger.info(f"[LOCK API] Session {session_id_short}... successfully acquired lock for file {file_metadata.stable_id}...")

        # Notify all other sessions about the lock acquisition
        broadcast_to_other_sessions(
            sse_service=sse_service,
            session_manager=session_manager,
            current_session_id=session_id,
            event_type="fileDataChanged",
            data={
                "reason": "lock_acquired",
                "stable_id": file_metadata.stable_id,
                "locked_by": current_user.get("username")
            },
            logger=logger
        )

        _emit_lock_changed(file_metadata.stable_id)
        return "OK"

    # Could not acquire lock
    holder_id = check_lock(file_metadata.stable_id, session_id, settings.db_dir, logger)["locked_by"]
    logger.warning(
        f"[LOCK API] Session {session_id_short}... FAILED to acquire lock (423) for file {file_metadata.stable_id}..., held by {holder_id[:8] if holder_id else 'unknown'}..."
    )
    current_username = current_user.get("username") if current_user else None
    detail = describe_lock_holder(holder_id, current_username, session_manager)
    raise HTTPException(status_code=423, detail=detail.model_dump())


@router.post("/release_lock", response_model=ReleaseLockResponse)
def release_lock_endpoint(
    request: ReleaseLockRequest,
    repo: FileRepository = Depends(get_file_repository),
    session_id: str = Depends(get_session_id),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager)
):
    """
    Release a lock.

    Args:
        request: ReleaseLockRequest with file_id (stable_id or full hash)
        repo: File repository (injected)
        session_id: Current session ID (injected)

    Returns:
        ReleaseLockResponse with action and message

    Raises:
        HTTPException: 409 if failed to release lock
    """
    # Look up file by ID or stable_id
    file_metadata = repo.get_file_by_id_or_stable_id(request.file_id)
    if not file_metadata:
        # If file doesn't exist, treat as already released (lenient behavior)
        return ReleaseLockResponse(
            action="already_released",
            message=f"File not found - lock already released: {request.file_id}"
        )

    settings = get_settings()
    result = release_lock(file_metadata.stable_id, session_id, settings.db_dir, logger)

    if result["status"] == "success":
        # Notify all other sessions that lock was released
        broadcast_to_other_sessions(
            sse_service=sse_service,
            session_manager=session_manager,
            current_session_id=session_id,
            event_type="lockReleased",
            data={
                "stable_id": file_metadata.stable_id
            },
            logger=logger
        )

        _emit_lock_changed(file_metadata.stable_id)
        return ReleaseLockResponse(
            action=result["action"],
            message=result["message"]
        )

    # Failed to release
    raise HTTPException(
        status_code=409,
        detail=result.get("message", "Failed to release lock")
    )

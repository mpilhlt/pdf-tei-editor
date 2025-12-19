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

from fastapi import APIRouter, Depends, HTTPException

from ..lib.locking import acquire_lock, release_lock, check_lock, get_locked_file_ids
from ..lib.file_repository import FileRepository
from ..lib.models_files import (
    GetLocksResponse,
    AcquireLockRequest,
    ReleaseLockRequest,
    ReleaseLockResponse,
    CheckLockRequest,
    CheckLockResponse
)
from ..lib.dependencies import (
    get_file_repository,
    get_session_id,
    get_current_user
)
from ..lib.access_control import check_file_access
from ..config import get_settings
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


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
    current_user: dict = Depends(get_current_user)
) -> str:
    """
    Acquire a lock for editing.

    Args:
        request: AcquireLockRequest with file_id (stable_id or full hash)
        repo: File repository (injected)
        session_id: Current session ID (injected)
        current_user: Current user dict (injected)

    Returns:
        "OK" string on success (matches Flask API)

    Raises:
        HTTPException: 403 if insufficient permissions, 404 if file not found, 423 if cannot acquire lock
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

    # Acquire lock
    settings = get_settings()
    if acquire_lock(file_metadata.stable_id, session_id, settings.db_dir, logger):
        logger.info(f"[LOCK API] Session {session_id_short}... successfully acquired lock for file {file_metadata.stable_id}...")
        return "OK"

    # Could not acquire lock
    logger.warning(f"[LOCK API] Session {session_id_short}... FAILED to acquire lock (423) for file {file_metadata.stable_id}...")
    raise HTTPException(
        status_code=423,
        detail=f'Could not acquire lock for {request.file_id}'
    )


@router.post("/release_lock", response_model=ReleaseLockResponse)
def release_lock_endpoint(
    request: ReleaseLockRequest,
    repo: FileRepository = Depends(get_file_repository),
    session_id: str = Depends(get_session_id)
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
        return ReleaseLockResponse(
            action=result["action"],
            message=result["message"]
        )

    # Failed to release
    raise HTTPException(
        status_code=409,
        detail=result.get("message", "Failed to release lock")
    )

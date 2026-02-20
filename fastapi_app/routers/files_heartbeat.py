"""
File heartbeat API router for FastAPI.

Implements POST /api/files/heartbeat - Refresh file lock (keep-alive).

Key changes from Flask:
- No cache_status in response (database is always current, no cache in FastAPI)
- Otherwise identical to Flask (reuses lib/locking.py)
"""

from fastapi import APIRouter, Depends, HTTPException

from ..lib.core.locking import acquire_lock
from ..lib.repository.file_repository import FileRepository
from ..lib.models.models_files import HeartbeatRequest, HeartbeatResponse
from ..lib.core.dependencies import get_session_id, get_file_repository
from ..config import get_settings
from ..lib.utils.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.post("/heartbeat", response_model=HeartbeatResponse)
def heartbeat(
    request: HeartbeatRequest,
    repo: FileRepository = Depends(get_file_repository),
    session_id: str = Depends(get_session_id)
):
    """
    Refresh file lock (keep-alive).

    The existing acquire_lock function already handles refreshing
    a lock if it's owned by the same session.

    Note: No cache_status in FastAPI (deprecated - database is always current).

    Args:
        request: HeartbeatRequest with file_id (stable_id or full hash)
        repo: File repository (injected)
        session_id: Current session ID (injected)

    Returns:
        HeartbeatResponse with status='lock_refreshed'

    Raises:
        HTTPException: 409 if failed to refresh lock
    """
    # Look up file by ID or stable_id
    file_metadata = repo.get_file_by_id_or_stable_id(request.file_id)
    if not file_metadata:
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_id}")

    logger.debug(f"Heartbeat for file {request.file_id} (session: {session_id[:8]}...)")

    # Refresh lock using acquire_lock (it handles refresh for same session)
    settings = get_settings()
    if acquire_lock(file_metadata.stable_id, session_id, settings.db_dir, logger):
        return HeartbeatResponse(status="lock_refreshed")

    # Failed to refresh
    raise HTTPException(
        status_code=409,
        detail="Failed to refresh lock. It may have been acquired by another session."
    )

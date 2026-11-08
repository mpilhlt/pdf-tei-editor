"""
File delete API router for FastAPI.

Implements POST /api/files/delete - Soft delete files.

Key changes from Flask:
- Soft delete (set deleted=1) instead of physical removal
- No .deleted marker files needed
- Database update sets sync_status='pending_delete' for sync tracking
- Physical files remain in storage until garbage collection
  (can be implemented later as administrative task)
"""

from fastapi import APIRouter, Depends, HTTPException, Request

from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage
from ..lib.models.models import FileMetadata
from ..lib.models.models_files import (
    DeleteFilesRequest,
    DeleteFilesResponse,
    DeleteHistoryRequest,
    DeleteHistoryResponse,
)
from ..lib.core.dependencies import (
    get_file_repository,
    get_file_storage,
    require_authenticated_user,
    get_session_id,
    get_sse_service,
    get_session_manager
)
from ..lib.permissions.access_control import check_file_access
from ..lib.utils.logging_utils import get_logger
from ..lib.sse.sse_service import SSEService
from ..lib.core.sessions import SessionManager
from ..lib.sse.sse_utils import broadcast_to_other_sessions
from ..lib.sse.event_bus import get_event_bus
from ..lib.permissions.acl_utils import delete_permissions_for_file


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.post("/delete", response_model=DeleteFilesResponse)
async def delete_files(
    body: DeleteFilesRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict = Depends(require_authenticated_user),
    session_id: str = Depends(get_session_id),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager)
) -> DeleteFilesResponse:
    """
    Delete files (soft delete with reference counting).

    Sets deleted=1 and sync_status='pending_delete' in database.

    Reference counting ensures physical files are deleted only when:
    - No database entries reference the file (ref_count = 0)
    - Safe for deduplication (same content shared by multiple entries)

    Args:
        body: DeleteFilesRequest with list of file IDs (stable_id or full hash)
        repo: File repository (injected)
        storage: File storage with reference counting (injected)
        current_user: Current user dict (injected)

    Returns:
        {"result": "ok"}

    Raises:
        HTTPException: 403 if insufficient permissions
    """
    logger.debug(f"Deleting {len(body.files)} files, user={current_user}")

    deleted_stable_ids = []

    for file_id in body.files:
        # Skip empty identifiers (including whitespace-only)
        if not file_id or not file_id.strip():
            logger.warning("Ignoring empty file identifier")
            continue

        # Look up file by ID or stable_id
        file_metadata = repo.get_file_by_id_or_stable_id(file_id)
        if not file_metadata:
            logger.warning(f"File not found for deletion: {file_id}")
            continue  # Skip non-existent files

        # Check write permissions
        if not check_file_access(file_metadata, current_user, 'write'):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions to delete {file_id}"
            )

        if _soft_delete(repo, file_metadata):
            deleted_stable_ids.append(file_metadata.stable_id)

    await _notify_deleted(deleted_stable_ids, sse_service, session_manager, session_id)

    return DeleteFilesResponse(result="ok")


@router.post("/delete_history", response_model=DeleteHistoryResponse)
async def delete_history(
    body: DeleteHistoryRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict = Depends(require_authenticated_user),
    session_id: str = Depends(get_session_id),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager)
) -> DeleteHistoryResponse:
    """
    Delete a version together with its history: the ancestors (`parent_stable_id` chain) that no
    other version descends from. The walk stops before the first ancestor that has another
    descendant or is a gold standard; that ancestor and everything above it are preserved.

    Permissions are checked for all files before any is deleted. With `dry_run`, only the files
    that would be deleted are returned.

    Args:
        body: DeleteHistoryRequest with the version's file ID and the dry-run flag

    Returns:
        The stable IDs of the (to be) deleted files, the version first, then its ancestors

    Raises:
        HTTPException: 404 if the file does not exist, 400 for a gold standard or a non-TEI file,
            409 if other versions were copied from the file, 403 if a file may not be deleted
    """
    file_metadata = repo.get_file_by_id_or_stable_id(body.file_id)
    if not file_metadata or file_metadata.deleted:
        raise HTTPException(status_code=404, detail=f"File not found: {body.file_id}")
    if file_metadata.file_type != 'tei' or file_metadata.is_gold_standard:
        raise HTTPException(status_code=400, detail="Only versions can be deleted with their history")
    if repo.is_frozen(file_metadata.stable_id):
        raise HTTPException(status_code=409, detail="Other versions were copied from this file; delete them first")

    history = repo.get_exclusive_history(file_metadata.stable_id)
    for item in history:
        if not check_file_access(item, current_user, 'write'):
            raise HTTPException(status_code=403, detail=f"Insufficient permissions to delete {item.stable_id}")

    stable_ids = [item.stable_id for item in history]
    if body.dry_run:
        return DeleteHistoryResponse(files=stable_ids, deleted=False)

    logger.info(f"Deleting version {file_metadata.stable_id} with its history: {stable_ids}")
    # The version first, so that each ancestor is no longer frozen when it is deleted
    deleted_stable_ids = [item.stable_id for item in history if _soft_delete(repo, item)]
    await _notify_deleted(deleted_stable_ids, sse_service, session_manager, session_id)
    return DeleteHistoryResponse(files=deleted_stable_ids, deleted=True)


def _soft_delete(repo: FileRepository, file_metadata: FileMetadata) -> bool:
    """
    Soft delete a file (FileRepository handles reference counting) and its granular permissions.

    Returns:
        True if the file was deleted
    """
    logger.info(f"Soft deleting file: {file_metadata.stable_id} (hash: {file_metadata.id[:16]}...)")
    try:
        repo.delete_file(file_metadata.id)
    except ValueError as e:
        logger.error(f"Failed to delete file {file_metadata.stable_id}: {e}")
        return False
    # Delete permissions for the file (granular mode only)
    delete_permissions_for_file(file_metadata.stable_id)
    return True


async def _notify_deleted(
    deleted_stable_ids: list[str],
    sse_service: SSEService,
    session_manager: SessionManager,
    session_id: str
) -> None:
    """Notify other sessions about deletions and emit a `file.deleted` event for each file."""
    if not deleted_stable_ids:
        return
    broadcast_to_other_sessions(
        sse_service=sse_service,
        session_manager=session_manager,
        current_session_id=session_id,
        event_type="fileDataChanged",
        data={
            "reason": "files_deleted",
            "stable_ids": deleted_stable_ids
        },
        logger=logger
    )
    event_bus = get_event_bus()
    for stable_id in deleted_stable_ids:
        await event_bus.emit("file.deleted", stable_id=stable_id)

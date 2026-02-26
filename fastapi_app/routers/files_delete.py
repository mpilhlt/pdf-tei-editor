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
from typing import List

from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage
from ..lib.models.models_files import DeleteFilesRequest, DeleteFilesResponse
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

        # Soft delete in database (FileRepository handles reference counting)
        logger.info(f"Soft deleting file: {file_id} (hash: {file_metadata.id[:16]}...)")
        try:
            repo.delete_file(file_metadata.id)
            deleted_stable_ids.append(file_metadata.stable_id)

            # Delete permissions for the file (granular mode only)
            delete_permissions_for_file(file_metadata.stable_id)

        except ValueError as e:
            logger.error(f"Failed to delete file {file_id}: {e}")
            # Continue with other files

    # Notify other sessions about deletions
    if deleted_stable_ids:
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

        # Emit file.deleted events for each deleted file
        event_bus = get_event_bus()
        for stable_id in deleted_stable_ids:
            await event_bus.emit("file.deleted", stable_id=stable_id)

    return DeleteFilesResponse(result="ok")

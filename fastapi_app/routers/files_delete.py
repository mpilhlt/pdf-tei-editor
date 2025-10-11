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

from fastapi import APIRouter, Depends, HTTPException
from typing import List

from ..lib.file_repository import FileRepository
from ..lib.models_files import DeleteFilesRequest, DeleteFilesResponse
from ..lib.dependencies import (
    get_file_repository,
    get_current_user,
    require_session,
    get_hash_abbreviator
)
from ..lib.access_control import check_file_access
from ..lib.hash_abbreviation import HashAbbreviator
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.post("/delete", response_model=DeleteFilesResponse)
@require_session
def delete_files(
    request: DeleteFilesRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict = Depends(get_current_user),
    abbreviator: HashAbbreviator = Depends(get_hash_abbreviator)
) -> DeleteFilesResponse:
    """
    Delete files (soft delete).

    Sets deleted=1 and sync_status='pending_delete' in database.
    Physical files remain in storage for sync tracking and can be
    garbage collected later once sync is confirmed.

    Args:
        request: DeleteFilesRequest with list of file IDs (abbreviated or full hashes)
        repo: File repository (injected)
        current_user: Current user dict (injected)
        abbreviator: Hash abbreviator (injected)

    Returns:
        {"result": "ok"}

    Raises:
        HTTPException: 403 if insufficient permissions
    """
    logger.debug(f"Deleting {len(request.files)} files, user={current_user}")

    for file_id in request.files:
        # Skip empty identifiers
        if not file_id:
            logger.warning("Ignoring empty file identifier")
            continue

        try:
            # Resolve abbreviated hash to full hash if needed
            full_hash = abbreviator.resolve(file_id)
        except KeyError:
            # Try as-is (might be full hash)
            full_hash = file_id

        # Look up file
        file_metadata = repo.get_file_by_id(full_hash)
        if not file_metadata:
            logger.warning(f"File not found for deletion: {file_id}")
            continue  # Skip non-existent files

        # Check write permissions
        if not check_file_access(file_metadata, current_user, 'write'):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions to delete {file_id}"
            )

        # Soft delete
        logger.info(f"Soft deleting file: {file_id} (full hash: {full_hash[:16]}...)")
        try:
            repo.delete_file(full_hash)
        except ValueError as e:
            logger.error(f"Failed to delete file {file_id}: {e}")
            # Continue with other files

    return DeleteFilesResponse(result="ok")

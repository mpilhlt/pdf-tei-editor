"""
File metadata update API endpoint.

Allows updating file metadata (fileref, title, DOI, variant) in the database.
"""

import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..lib.dependencies import (
    get_file_repository,
    require_authenticated_user,
)
from ..lib.file_repository import FileRepository
from ..lib.logging_utils import get_logger
from ..lib.user_utils import user_has_collection_access
from ..config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


class UpdateFileMetadataRequest(BaseModel):
    """Request body for updating file metadata."""
    fileref: str | None = None
    title: str | None = None
    doi: str | None = None
    variant: str | None = None
    label: str | None = None


@router.patch("/{stable_id}/metadata")
async def update_file_metadata(
    stable_id: str,
    metadata: UpdateFileMetadataRequest,
    user: dict = Depends(require_authenticated_user),
    file_repo: FileRepository = Depends(get_file_repository)
):
    """Update file metadata in the database.

    Args:
        stable_id: The stable_id of the file to update
        metadata: Updated metadata fields
        user: Authenticated user
        file_repo: File repository instance

    Returns:
        Success message

    Raises:
        HTTPException: If file not found or user doesn't have access
    """
    logger_inst = get_logger(__name__)
    settings = get_settings()

    # Get file
    file = file_repo.get_file_by_stable_id(stable_id)
    if not file:
        raise HTTPException(status_code=404, detail=f"File not found: {stable_id}")

    # Check access control
    user_has_access = False
    for collection_id in file.doc_collections or []:
        if user_has_collection_access(user, collection_id, settings.db_dir):
            user_has_access = True
            break

    if not user_has_access:
        raise HTTPException(
            status_code=403,
            detail="You do not have permission to modify this file"
        )

    # Update metadata fields
    updates = {}
    if metadata.fileref is not None:
        updates['fileref'] = metadata.fileref
    if metadata.title is not None:
        updates['title'] = metadata.title
    if metadata.doi is not None:
        updates['doi'] = metadata.doi
    if metadata.variant is not None:
        updates['variant'] = metadata.variant
    if metadata.label is not None:
        updates['label'] = metadata.label

    if not updates:
        raise HTTPException(status_code=400, detail="No metadata fields provided")

    # Update in database
    try:
        file_repo.update_file_metadata(stable_id, **updates)
        logger_inst.info(f"Updated metadata for file {stable_id}: {updates}")
        return {"message": "File metadata updated successfully"}
    except Exception as e:
        logger_inst.error(f"Failed to update file metadata: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to update metadata: {str(e)}")


@router.post("/{stable_id}/gold-standard")
async def set_gold_standard(
    stable_id: str,
    user: dict = Depends(require_authenticated_user),
    file_repo: FileRepository = Depends(get_file_repository)
):
    """Set a file as the gold standard for its document and variant.

    Only users with reviewer or admin role can set gold standard.
    Unsets gold standard for all other files with the same doc_id and variant.

    Args:
        stable_id: The stable_id of the file to make gold standard
        user: Authenticated user
        file_repo: File repository instance

    Returns:
        Success message

    Raises:
        HTTPException: If file not found, user doesn't have access, or user lacks reviewer role
    """
    logger_inst = get_logger(__name__)
    settings = get_settings()

    # Check if user has reviewer role
    user_roles = user.get('roles', [])
    if not any(role in ['admin', 'reviewer'] for role in user_roles):
        raise HTTPException(
            status_code=403,
            detail="Only reviewers and admins can set gold standard"
        )

    # Get file
    file = file_repo.get_file_by_stable_id(stable_id)
    if not file:
        raise HTTPException(status_code=404, detail=f"File not found: {stable_id}")

    # Check access control
    user_has_access = False
    for collection_id in file.doc_collections or []:
        if user_has_collection_access(user, collection_id, settings.db_dir):
            user_has_access = True
            break

    if not user_has_access:
        raise HTTPException(
            status_code=403,
            detail="You do not have permission to modify this file"
        )

    # Set gold standard
    try:
        file_repo.set_gold_standard(stable_id, file.variant)
        logger_inst.info(f"Set gold standard: {stable_id} by user {user.get('username')}")
        return {"message": "File set as gold standard successfully"}
    except Exception as e:
        logger_inst.error(f"Failed to set gold standard: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to set gold standard: {str(e)}")

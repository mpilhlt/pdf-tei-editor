"""
File metadata API endpoints.

Provides endpoints for retrieving and updating file metadata.
"""

import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..lib.dependencies import (
    get_file_repository,
    get_file_storage,
    require_authenticated_user,
    require_admin_user,
)
from ..lib.file_repository import FileRepository
from ..lib.logging_utils import get_logger
from ..lib.user_utils import user_has_collection_access
from ..lib.models import FileMetadata
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


@router.get("/{stable_id}/metadata", response_model=FileMetadata)
async def get_file_metadata(
    stable_id: str,
    user: dict = Depends(require_authenticated_user),
    file_repo: FileRepository = Depends(get_file_repository)
) -> FileMetadata:
    """Get file metadata by stable_id.

    Returns complete file metadata if user has access to the file's collections.

    Args:
        stable_id: The stable_id of the file
        user: Authenticated user
        file_repo: File repository instance

    Returns:
        Complete file metadata

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
            detail="You do not have permission to access this file"
        )

    logger_inst.debug(f"Retrieved metadata for file {stable_id}")
    return file


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


class UpdateDocIdRequest(BaseModel):
    """Request body for updating document ID."""
    doc_id: str


@router.patch("/{stable_id}/doc-id")
async def update_doc_id(
    stable_id: str,
    request: UpdateDocIdRequest,
    user: dict = Depends(require_authenticated_user),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage = Depends(get_file_storage)
):
    """Update document ID for all files belonging to a document.

    Only users with reviewer or admin role can update doc_id.
    Only gold standard files can have their doc_id updated.
    Updates doc_id for all files (PDF and artifacts) with the same doc_id.
    Also updates the fileref in all TEI XML files.

    Args:
        stable_id: The stable_id of the gold file
        request: Request body with new doc_id
        user: Authenticated user
        file_repo: File repository instance
        file_storage: File storage instance

    Returns:
        Success message

    Raises:
        HTTPException: If file not found, not gold standard, user doesn't have access, or lacks reviewer role
    """
    logger_inst = get_logger(__name__)
    settings = get_settings()

    # Check if user has reviewer role
    user_roles = user.get('roles', [])
    if not any(role in ['admin', 'reviewer'] for role in user_roles):
        raise HTTPException(
            status_code=403,
            detail="Only reviewers and admins can update document ID"
        )

    # Get file
    file = file_repo.get_file_by_stable_id(stable_id)
    if not file:
        raise HTTPException(status_code=404, detail=f"File not found: {stable_id}")

    # Check if file is gold standard
    if not file.is_gold_standard:
        raise HTTPException(
            status_code=400,
            detail="Only gold standard files can have their document ID updated"
        )

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

    # Update doc_id
    try:
        file_repo.update_doc_id(stable_id, request.doc_id, file_storage)
        logger_inst.info(
            f"Updated doc_id to '{request.doc_id}' for document (stable_id: {stable_id}) "
            f"by user {user.get('username')}"
        )
        return {"message": "Document ID updated successfully"}
    except ValueError as e:
        logger_inst.warning(f"Failed to update doc_id: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger_inst.error(f"Failed to update doc_id: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to update document ID: {str(e)}")

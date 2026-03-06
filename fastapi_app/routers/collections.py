"""
Collection management API router for FastAPI.

Implements standard REST endpoints:
- GET /api/v1/collections - List all collections
- POST /api/v1/collections - Create a new collection
- GET /api/v1/collections/{collection_id} - Get collection details
- PUT /api/v1/collections/{collection_id} - Update collection
- DELETE /api/v1/collections/{collection_id} - Delete collection
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional

from ..lib.utils.collection_utils import (
    get_collections_with_details,
    add_collection,
    find_collection,
    remove_collection,
    set_collection_property,
    grant_user_collection_access
)
from ..lib.core.dependencies import get_current_user, get_file_repository
from ..lib.repository.file_repository import FileRepository
from ..lib.utils.logging_utils import get_logger
from ..config import get_settings

logger = get_logger(__name__)
router = APIRouter(prefix="/collections", tags=["collections"])


class Collection(BaseModel):
    """Collection information model."""
    id: str = Field(..., description="Unique collection identifier")
    name: str = Field(..., description="Display name for the collection")
    description: Optional[str] = Field(default="", description="Collection description")


class CollectionFileItem(BaseModel):
    """Simplified file item for collection file listing."""
    filename: str = Field(..., description="Original filename")
    stable_id: str = Field(..., description="Stable file identifier")
    file_type: str = Field(..., description="File type (pdf, tei, etc.)")


class CollectionFilesResponse(BaseModel):
    """Response model for collection files listing."""
    collection_id: str = Field(..., description="Collection identifier")
    files: List[CollectionFileItem] = Field(..., description="List of files in collection")


def require_authenticated(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    """Dependency that requires authentication."""
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return current_user


def require_admin(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    """Dependency that requires admin authentication."""
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")

    user_roles = current_user.get('roles', [])
    is_admin = '*' in user_roles or 'admin' in user_roles

    if not is_admin:
        raise HTTPException(
            status_code=403,
            detail="Insufficient permissions. Admin role required."
        )

    return current_user


def require_reviewer_or_admin(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    """Dependency that requires reviewer or admin authentication."""
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")

    user_roles = current_user.get('roles', [])
    has_permission = '*' in user_roles or 'admin' in user_roles or 'reviewer' in user_roles

    if not has_permission:
        raise HTTPException(
            status_code=403,
            detail="Insufficient permissions. Reviewer or admin role required."
        )

    return current_user


@router.get("", response_model=List[Collection])
def list_all_collections(
    current_user: dict = Depends(require_authenticated)
):
    """
    List all collections accessible to the current user.

    Filters collections based on user's group memberships. Admin users and
    users with wildcard access see all collections.

    Returns:
        List of Collection objects
    """
    from ..lib.permissions.user_utils import get_user_collections

    settings = get_settings()

    try:
        all_collections = get_collections_with_details(settings.db_dir)

        # Get user's accessible collections
        accessible_collection_ids = get_user_collections(current_user, settings.db_dir)

        # Filter collections if user has limited access
        if accessible_collection_ids is not None:
            # User has limited access - only return accessible collections
            collections = [
                Collection(
                    id=col.get('id', ''),
                    name=col.get('name', col.get('id', '')),
                    description=col.get('description', '')
                )
                for col in all_collections # type: ignore
                if col.get('id') in accessible_collection_ids
            ]
        else:
            # User has access to all collections (admin or wildcard)
            collections = [
                Collection(
                    id=col.get('id', ''),
                    name=col.get('name', col.get('id', '')),
                    description=col.get('description', '')
                )
                for col in all_collections # type: ignore
            ]

        # Sort collections alphabetically by name (case-insensitive)
        collections.sort(key=lambda c: c.name.lower())

        return collections
    except Exception as e:
        logger.error(f"Error listing collections: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving collections: {str(e)}")


@router.get("/{collection_id}", response_model=Collection)
def get_collection(
    collection_id: str,
    current_user: dict = Depends(require_authenticated)
):
    """
    Get a specific collection by ID.

    Args:
        collection_id: Collection identifier
        current_user: Current user dict (injected)

    Returns:
        Collection object

    Raises:
        HTTPException: 404 if collection not found
    """
    settings = get_settings()

    try:
        all_collections = get_collections_with_details(settings.db_dir)
        if all_collections is None:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_id}' not found")

        collection = find_collection(collection_id, all_collections)

        if not collection:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_id}' not found")

        return Collection(
            id=collection.get('id', ''),
            name=collection.get('name', collection.get('id', '')),
            description=collection.get('description', '')
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting collection: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving collection: {str(e)}")


@router.post("", response_model=Collection, status_code=201)
def create_collection_rest(
    collection: Collection,
    current_user: dict = Depends(require_reviewer_or_admin)
):
    """
    Create a new collection.

    Args:
        collection: Collection data
        current_user: Current user dict (injected)

    Returns:
        Created Collection object

    Raises:
        HTTPException: 400 if validation fails or collection exists
    """
    settings = get_settings()

    # Validate collection ID format
    import re
    if not re.match(r'^[a-zA-Z0-9_-]+$', collection.id):
        raise HTTPException(
            status_code=400,
            detail="Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed."
        )

    try:
        success, message = add_collection(
            db_dir=settings.db_dir,
            collection_id=collection.id,
            name=collection.name,
            description=collection.description or ""
        )

        if success:
            username = current_user.get('username', '')
            logger.info(f"Collection '{collection.id}' created by user '{username}'")

            # Grant user access to the new collection
            if username:
                grant_user_collection_access(
                    settings.db_dir, username, collection.id, logger=logger
                )

            return collection
        else:
            raise HTTPException(status_code=400, detail=message)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating collection: {e}")
        raise HTTPException(status_code=500, detail=f"Error creating collection: {str(e)}")


@router.put("/{collection_id}", response_model=Collection)
def update_collection(
    collection_id: str,
    collection: Collection,
    current_user: dict = Depends(require_admin)
):
    """
    Update an existing collection.

    Args:
        collection_id: Collection identifier
        collection: Updated collection data
        current_user: Current user dict (injected)

    Returns:
        Updated Collection object

    Raises:
        HTTPException: 404 if collection not found, 400 if validation fails
    """
    settings = get_settings()

    try:
        # Check if collection exists
        all_collections = get_collections_with_details(settings.db_dir)
        if all_collections is None:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_id}' not found")

        existing = find_collection(collection_id, all_collections)

        if not existing:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_id}' not found")

        # Update name if changed
        if collection.name != existing.get('name'):
            success, message = set_collection_property(
                settings.db_dir, collection_id, 'name', collection.name
            )
            if not success:
                raise HTTPException(status_code=400, detail=message)

        # Update description if changed
        if collection.description != existing.get('description', ''):
            success, message = set_collection_property(
                settings.db_dir, collection_id, 'description', collection.description or ""
            )
            if not success:
                raise HTTPException(status_code=400, detail=message)

        # Note: ID changes are not allowed for collections (immutable)
        if collection.id != collection_id:
            raise HTTPException(
                status_code=400,
                detail="Collection ID cannot be changed"
            )

        logger.info(f"Collection '{collection_id}' updated by user '{current_user.get('username')}'")
        return collection
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating collection: {e}")
        raise HTTPException(status_code=500, detail=f"Error updating collection: {str(e)}")


class CollectionDeleteResponse(BaseModel):
    """Response model for collection deletion."""
    success: bool = Field(..., description="Whether deletion was successful")
    collection_id: str = Field(..., description="ID of the deleted collection")
    files_updated: int = Field(..., description="Number of files updated (collection removed)")
    files_deleted: int = Field(..., description="Number of files marked as deleted")


@router.get("/{collection_id}/files", response_model=CollectionFilesResponse)
def list_collection_files(
    collection_id: str,
    current_user: dict = Depends(require_authenticated),
    repo: FileRepository = Depends(get_file_repository)
):
    """
    List all files in a specific collection.

    Returns a simplified list of files (filename and stable_id only) for resume/skip logic
    in batch operations. Only returns PDF files as those are the source files that get
    uploaded and extracted.

    Args:
        collection_id: Collection identifier
        current_user: Current user dict (injected)
        repo: File repository (injected)

    Returns:
        CollectionFilesResponse with list of files

    Raises:
        HTTPException: 404 if collection not found
    """
    settings = get_settings()

    try:
        # Check if collection exists
        all_collections = get_collections_with_details(settings.db_dir)
        if all_collections is None:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_id}' not found")

        collection = find_collection(collection_id, all_collections)
        if not collection:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_id}' not found")

        # Get all files in this collection using file_repository
        files = repo.get_files_by_collection(collection_id, include_deleted=False)

        # Filter to PDF files only (source files) and convert to response model
        pdf_files = [
            CollectionFileItem(
                filename=file.file_metadata.get('original_filename', file.filename),
                stable_id=file.stable_id,
                file_type=file.file_type
            )
            for file in files
            if file.file_type == 'pdf'
        ]

        logger.debug(f"Found {len(pdf_files)} PDF files in collection '{collection_id}'")

        return CollectionFilesResponse(
            collection_id=collection_id,
            files=pdf_files
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing collection files: {e}")
        raise HTTPException(status_code=500, detail=f"Error listing collection files: {str(e)}")


@router.delete("/{collection_id}", response_model=CollectionDeleteResponse)
def delete_collection(
    collection_id: str,
    current_user: dict = Depends(require_admin)
):
    """
    Delete a collection and clean up file metadata.

    For each file in the collection:
    - Removes the collection from the file's collections list
    - If the file has no other collections, marks it as deleted

    Args:
        collection_id: Collection identifier
        current_user: Current user dict (injected)

    Returns:
        CollectionDeleteResponse with deletion statistics

    Raises:
        HTTPException: 404 if collection not found
    """
    settings = get_settings()

    try:
        success, message, stats = remove_collection(settings.db_dir, collection_id)

        if success:
            logger.info(
                f"Collection '{collection_id}' deleted by user '{current_user.get('username')}': "
                f"{stats.get('files_updated', 0)} files updated, "
                f"{stats.get('files_deleted', 0)} files deleted"
            )
            return CollectionDeleteResponse(
                success=True,
                collection_id=collection_id,
                files_updated=stats.get('files_updated', 0),
                files_deleted=stats.get('files_deleted', 0)
            )
        else:
            raise HTTPException(status_code=404, detail=message)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting collection: {e}")
        raise HTTPException(status_code=500, detail=f"Error deleting collection: {str(e)}")

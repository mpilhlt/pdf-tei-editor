"""
Collection management API router for FastAPI.

Implements:
- GET /api/v1/collections/list - List all accessible collections
- POST /api/v1/collections/create - Create a new collection
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

from ..lib.collection_utils import (
    get_collections_with_details,
    add_collection,
    validate_collection
)
from ..lib.user_utils import get_user_collections
from ..lib.dependencies import get_current_user
from ..lib.logging_utils import get_logger
from ..config import get_settings

logger = get_logger(__name__)
router = APIRouter(prefix="/collections", tags=["collections"])


class Collection(BaseModel):
    """Collection information model."""
    id: str = Field(..., description="Unique collection identifier")
    name: str = Field(..., description="Display name for the collection")
    description: Optional[str] = Field(default="", description="Collection description")


class CollectionsListResponse(BaseModel):
    """Response model for collections list endpoint."""
    collections: List[Collection] = Field(..., description="List of collections accessible to the user")


class CreateCollectionRequest(BaseModel):
    """Request model for creating a new collection."""
    id: str = Field(..., description="Unique collection identifier (only letters, numbers, hyphens, underscores)")
    name: Optional[str] = Field(None, description="Display name (defaults to id if not provided)")
    description: Optional[str] = Field(default="", description="Collection description")


class CreateCollectionResponse(BaseModel):
    """Response model for collection creation."""
    success: bool = Field(..., description="Whether the operation succeeded")
    message: str = Field(..., description="Result message")
    collection: Optional[Collection] = Field(None, description="Created collection details")


@router.get("/list", response_model=CollectionsListResponse)
def list_collections(
    current_user: Optional[dict] = Depends(get_current_user)
):
    """
    List all collections accessible to the current user.

    For users with wildcard access (admin role, * in roles/groups), returns all collections.
    For regular users, returns only collections their groups have access to.
    Anonymous users get an empty list.

    Args:
        current_user: Current user dict or None (injected)

    Returns:
        CollectionsListResponse with accessible collections
    """
    settings = get_settings()

    try:
        # Get all collections from collections.json
        all_collections = get_collections_with_details(settings.db_dir)

        # Get user's accessible collections (None = all, [] = none, [ids] = specific)
        accessible_collection_ids = get_user_collections(current_user, settings.db_dir)

        # Filter collections based on user access
        if accessible_collection_ids is None:
            # User has wildcard access - return all collections
            filtered_collections = all_collections
        elif not accessible_collection_ids:
            # User has no collection access - return empty list
            filtered_collections = []
        else:
            # User has specific collection access - filter
            filtered_collections = [
                col for col in all_collections
                if col.get('id') in accessible_collection_ids
            ]

        # Convert to response models
        collections = [
            Collection(
                id=col.get('id', ''),
                name=col.get('name', col.get('id', '')),
                description=col.get('description', '')
            )
            for col in filtered_collections
        ]

        logger.debug(f"Returning {len(collections)} collections for user")
        return CollectionsListResponse(collections=collections)

    except Exception as e:
        logger.error(f"Error listing collections: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving collections: {str(e)}")


@router.post("/create", response_model=CreateCollectionResponse)
def create_collection(
    body: CreateCollectionRequest,
    current_user: Optional[dict] = Depends(get_current_user)
):
    """
    Create a new collection.

    Requires admin or reviewer role.
    Collection ID must be unique and contain only letters, numbers, hyphens, and underscores.
    If name is not provided, uses id as the display name.

    Args:
        body: CreateCollectionRequest with collection details
        current_user: Current user dict (injected)

    Returns:
        CreateCollectionResponse with success status and created collection

    Raises:
        HTTPException: 401 if not authenticated, 403 if insufficient permissions, 400 if validation fails
    """
    settings = get_settings()

    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Check if user has admin or reviewer role
    user_roles = current_user.get('roles', [])
    is_admin = '*' in user_roles or 'admin' in user_roles or 'reviewer' in user_roles

    if not is_admin:
        raise HTTPException(
            status_code=403,
            detail="Insufficient permissions. Admin or reviewer role required."
        )

    # Validate collection ID format
    import re
    if not re.match(r'^[a-zA-Z0-9_-]+$', body.id):
        raise HTTPException(
            status_code=400,
            detail="Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed."
        )

    # Use id as name if name not provided
    name = body.name if body.name else body.id

    try:
        # Add collection to collections.json
        success, message = add_collection(
            db_dir=settings.db_dir,
            collection_id=body.id,
            name=name,
            description=body.description or ""
        )

        if success:
            collection = Collection(
                id=body.id,
                name=name,
                description=body.description or ""
            )
            logger.info(f"Collection '{body.id}' created by user '{current_user.get('username')}'")
            return CreateCollectionResponse(
                success=True,
                message=message,
                collection=collection
            )
        else:
            raise HTTPException(status_code=400, detail=message)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating collection: {e}")
        raise HTTPException(status_code=500, detail=f"Error creating collection: {str(e)}")

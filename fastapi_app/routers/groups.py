"""
Group management API router for FastAPI.

Implements:
- GET /api/v1/groups - List all groups (admin only)
- GET /api/v1/groups/{group_id} - Get specific group (admin only)
- POST /api/v1/groups - Create a new group (admin only)
- PUT /api/v1/groups/{group_id} - Update group (admin only)
- DELETE /api/v1/groups/{group_id} - Delete group (admin only)
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional

from ..lib.group_utils import (
    find_group,
    group_exists,
    create_group
)
from ..lib.data_utils import load_entity_data, save_entity_data
from ..lib.dependencies import get_current_user
from ..lib.logging_utils import get_logger
from ..config import get_settings

logger = get_logger(__name__)
router = APIRouter(prefix="/groups", tags=["groups"])


class Group(BaseModel):
    """Group information model."""
    id: str = Field(..., description="Unique group identifier")
    name: str = Field(..., description="Group display name")
    description: Optional[str] = Field(default="", description="Group description")
    collections: List[str] = Field(default=[], description="List of collection IDs accessible to this group")


class GroupsListResponse(BaseModel):
    """Response model for groups list endpoint."""
    groups: List[Group] = Field(..., description="List of groups")


class CreateGroupRequest(BaseModel):
    """Request model for creating a new group."""
    id: str = Field(..., description="Unique group identifier")
    name: str = Field(..., description="Group display name")
    description: Optional[str] = Field(default="", description="Group description")
    collections: Optional[List[str]] = Field(default=None, description="List of collection IDs")


class UpdateGroupRequest(BaseModel):
    """Request model for updating a group."""
    name: Optional[str] = Field(None, description="Group display name")
    description: Optional[str] = Field(None, description="Group description")
    collections: Optional[List[str]] = Field(None, description="List of collection IDs")


def require_admin(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    """Verify user is authenticated and has admin role."""
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


@router.get("", response_model=List[Group])
def list_groups(
    current_user: dict = Depends(require_admin)
):
    """
    List all groups.

    Requires admin role.

    Returns:
        List of Group objects
    """
    settings = get_settings()

    try:
        groups_data = load_entity_data(settings.db_dir, 'groups')

        # Convert to response models
        groups = [
            Group(
                id=group.get('id', ''),
                name=group.get('name', ''),
                description=group.get('description', ''),
                collections=group.get('collections', [])
            )
            for group in groups_data
        ]

        logger.debug(f"Returning {len(groups)} groups")
        return groups

    except Exception as e:
        logger.error(f"Error listing groups: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving groups: {str(e)}")


@router.get("/{group_id}", response_model=Group)
def get_group(
    group_id: str,
    current_user: dict = Depends(require_admin)
):
    """
    Get a specific group by ID.

    Requires admin role.

    Returns:
        Group information
    """
    settings = get_settings()

    try:
        groups_data = load_entity_data(settings.db_dir, 'groups')
        group = find_group(group_id, groups_data)

        if not group:
            raise HTTPException(status_code=404, detail=f"Group '{group_id}' not found")

        return Group(
            id=group.get('id', ''),
            name=group.get('name', ''),
            description=group.get('description', ''),
            collections=group.get('collections', [])
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting group: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving group: {str(e)}")


@router.post("", response_model=Group)
def create_group_endpoint(
    body: CreateGroupRequest,
    current_user: dict = Depends(require_admin)
):
    """
    Create a new group.

    Requires admin role.

    Returns:
        Created group information
    """
    settings = get_settings()

    try:
        groups_data = load_entity_data(settings.db_dir, 'groups')

        # Check if group already exists
        if group_exists(body.id, groups_data):
            raise HTTPException(status_code=400, detail=f"Group '{body.id}' already exists")

        # Create group dict
        new_group = create_group(
            group_id=body.id,
            name=body.name,
            description=body.description or "",
            collections=body.collections or []
        )

        # Add to groups list
        groups_data.append(new_group)

        # Save to file
        save_entity_data(settings.db_dir, 'groups', groups_data)

        logger.info(f"Group '{body.id}' created by admin '{current_user.get('username')}'")

        return Group(
            id=new_group['id'],
            name=new_group['name'],
            description=new_group['description'],
            collections=new_group['collections']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating group: {e}")
        raise HTTPException(status_code=500, detail=f"Error creating group: {str(e)}")


@router.put("/{group_id}", response_model=Group)
def update_group_endpoint(
    group_id: str,
    body: UpdateGroupRequest,
    current_user: dict = Depends(require_admin)
):
    """
    Update an existing group.

    Requires admin role.

    Returns:
        Updated group information
    """
    settings = get_settings()

    try:
        groups_data = load_entity_data(settings.db_dir, 'groups')
        group = find_group(group_id, groups_data)

        if not group:
            raise HTTPException(status_code=404, detail=f"Group '{group_id}' not found")

        # Update fields if provided
        if body.name is not None:
            group['name'] = body.name
        if body.description is not None:
            group['description'] = body.description
        if body.collections is not None:
            group['collections'] = body.collections

        # Save to file
        save_entity_data(settings.db_dir, 'groups', groups_data)

        logger.info(f"Group '{group_id}' updated by admin '{current_user.get('username')}'")

        return Group(
            id=group['id'],
            name=group['name'],
            description=group['description'],
            collections=group['collections']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating group: {e}")
        raise HTTPException(status_code=500, detail=f"Error updating group: {str(e)}")


@router.delete("/{group_id}")
def delete_group_endpoint(
    group_id: str,
    current_user: dict = Depends(require_admin)
):
    """
    Delete a group.

    Requires admin role.

    Returns:
        Success message
    """
    settings = get_settings()

    try:
        groups_data = load_entity_data(settings.db_dir, 'groups')

        # Find and remove group
        initial_count = len(groups_data)
        groups_data = [g for g in groups_data if g.get('id') != group_id]

        if len(groups_data) == initial_count:
            raise HTTPException(status_code=404, detail=f"Group '{group_id}' not found")

        # Save to file
        save_entity_data(settings.db_dir, 'groups', groups_data)

        logger.info(f"Group '{group_id}' deleted by admin '{current_user.get('username')}'")

        return {"success": True, "message": f"Group '{group_id}' deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting group: {e}")
        raise HTTPException(status_code=500, detail=f"Error deleting group: {str(e)}")

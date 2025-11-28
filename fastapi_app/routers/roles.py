"""
Role management API router for FastAPI.

Implements:
- GET /api/v1/roles - List all roles (admin only)
- GET /api/v1/roles/{role_id} - Get specific role (admin only)
- POST /api/v1/roles - Create a new role (admin only)
- PUT /api/v1/roles/{role_id} - Update role (admin only)
- DELETE /api/v1/roles/{role_id} - Delete role (admin only)
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional

from ..lib.role_utils import (
    find_role,
    role_exists,
    create_role
)
from ..lib.data_utils import load_entity_data, save_entity_data
from ..lib.dependencies import get_current_user
from ..lib.logging_utils import get_logger
from ..config import get_settings

logger = get_logger(__name__)
router = APIRouter(prefix="/roles", tags=["roles"])


class Role(BaseModel):
    """Role information model."""
    id: str = Field(..., description="Unique role identifier")
    roleName: str = Field(..., description="Role display name")
    description: Optional[str] = Field(default="", description="Role description")


class RolesListResponse(BaseModel):
    """Response model for roles list endpoint."""
    roles: List[Role] = Field(..., description="List of roles")


class CreateRoleRequest(BaseModel):
    """Request model for creating a new role."""
    id: str = Field(..., description="Unique role identifier")
    roleName: str = Field(..., description="Role display name")
    description: Optional[str] = Field(default="", description="Role description")


class UpdateRoleRequest(BaseModel):
    """Request model for updating a role."""
    roleName: Optional[str] = Field(None, description="Role display name")
    description: Optional[str] = Field(None, description="Role description")


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


@router.get("", response_model=List[Role])
def list_roles(
    current_user: dict = Depends(require_admin)
):
    """
    List all roles.

    Requires admin role.

    Returns:
        List of Role objects
    """
    settings = get_settings()

    try:
        roles_data = load_entity_data(settings.db_dir, 'roles')

        # Convert to response models
        roles = [
            Role(
                id=role.get('id', ''),
                roleName=role.get('roleName', ''),
                description=role.get('description', '')
            )
            for role in roles_data
        ]

        logger.debug(f"Returning {len(roles)} roles")
        return roles

    except Exception as e:
        logger.error(f"Error listing roles: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving roles: {str(e)}")


@router.get("/{role_id}", response_model=Role)
def get_role(
    role_id: str,
    current_user: dict = Depends(require_admin)
):
    """
    Get a specific role by ID.

    Requires admin role.

    Returns:
        Role information
    """
    settings = get_settings()

    try:
        roles_data = load_entity_data(settings.db_dir, 'roles')
        role = find_role(role_id, roles_data)

        if not role:
            raise HTTPException(status_code=404, detail=f"Role '{role_id}' not found")

        return Role(
            id=role.get('id', ''),
            roleName=role.get('roleName', ''),
            description=role.get('description', '')
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting role: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving role: {str(e)}")


@router.post("", response_model=Role)
def create_role_endpoint(
    body: CreateRoleRequest,
    current_user: dict = Depends(require_admin)
):
    """
    Create a new role.

    Requires admin role.

    Returns:
        Created role information
    """
    settings = get_settings()

    try:
        roles_data = load_entity_data(settings.db_dir, 'roles')

        # Check if role already exists
        if role_exists(body.id, roles_data):
            raise HTTPException(status_code=400, detail=f"Role '{body.id}' already exists")

        # Create role dict
        new_role = create_role(
            role_id=body.id,
            role_name=body.roleName,
            description=body.description or ""
        )

        # Add to roles list
        roles_data.append(new_role)

        # Save to file
        save_entity_data(settings.db_dir, 'roles', roles_data)

        logger.info(f"Role '{body.id}' created by admin '{current_user.get('username')}'")

        return Role(
            id=new_role['id'],
            roleName=new_role['roleName'],
            description=new_role['description']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating role: {e}")
        raise HTTPException(status_code=500, detail=f"Error creating role: {str(e)}")


@router.put("/{role_id}", response_model=Role)
def update_role_endpoint(
    role_id: str,
    body: UpdateRoleRequest,
    current_user: dict = Depends(require_admin)
):
    """
    Update an existing role.

    Requires admin role.

    Returns:
        Updated role information
    """
    settings = get_settings()

    try:
        roles_data = load_entity_data(settings.db_dir, 'roles')
        role = find_role(role_id, roles_data)

        if not role:
            raise HTTPException(status_code=404, detail=f"Role '{role_id}' not found")

        # Update fields if provided
        if body.roleName is not None:
            role['roleName'] = body.roleName
        if body.description is not None:
            role['description'] = body.description

        # Save to file
        save_entity_data(settings.db_dir, 'roles', roles_data)

        logger.info(f"Role '{role_id}' updated by admin '{current_user.get('username')}'")

        return Role(
            id=role['id'],
            roleName=role['roleName'],
            description=role['description']
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating role: {e}")
        raise HTTPException(status_code=500, detail=f"Error updating role: {str(e)}")


@router.delete("/{role_id}")
def delete_role_endpoint(
    role_id: str,
    current_user: dict = Depends(require_admin)
):
    """
    Delete a role.

    Requires admin role.
    Cannot delete built-in roles (admin, user, reviewer, annotator).

    Returns:
        Success message
    """
    settings = get_settings()

    # Prevent deletion of built-in roles
    built_in_roles = ['admin', 'user', 'reviewer', 'annotator']
    if role_id in built_in_roles:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete built-in role '{role_id}'"
        )

    try:
        roles_data = load_entity_data(settings.db_dir, 'roles')

        # Find and remove role
        initial_count = len(roles_data)
        roles_data = [r for r in roles_data if r.get('id') != role_id]

        if len(roles_data) == initial_count:
            raise HTTPException(status_code=404, detail=f"Role '{role_id}' not found")

        # Save to file
        save_entity_data(settings.db_dir, 'roles', roles_data)

        logger.info(f"Role '{role_id}' deleted by admin '{current_user.get('username')}'")

        return {"success": True, "message": f"Role '{role_id}' deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting role: {e}")
        raise HTTPException(status_code=500, detail=f"Error deleting role: {str(e)}")

"""
User management API router for FastAPI.

Implements:
- GET /api/v1/users - List all users (admin only)
- GET /api/v1/users/{username} - Get specific user (admin only)
- POST /api/v1/users - Create a new user (admin only)
- PUT /api/v1/users/{username} - Update user (admin only)
- DELETE /api/v1/users/{username} - Delete user (admin only)
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional

from ..lib.permissions.user_utils import (
    create_user,
    find_user,
    user_exists,
    hash_password
)
from ..lib.utils.data_utils import load_entity_data, save_entity_data
from ..lib.core.dependencies import get_current_user
from ..lib.utils.logging_utils import get_logger
from ..config import get_settings

logger = get_logger(__name__)
router = APIRouter(prefix="/users", tags=["users"])


class User(BaseModel):
    """User information model."""
    username: str = Field(..., description="Unique username")
    fullname: Optional[str] = Field(default="", description="User's full name")
    email: Optional[str] = Field(default="", description="User's email address")
    roles: List[str] = Field(default=["user"], description="List of user roles")
    groups: List[str] = Field(default=[], description="List of groups user belongs to")
    session_id: Optional[str] = Field(default=None, description="Current session ID")


class UsersListResponse(BaseModel):
    """Response model for users list endpoint."""
    users: List[User] = Field(..., description="List of users")


class CreateUserRequest(BaseModel):
    """Request model for creating a new user."""
    username: str = Field(..., description="Unique username")
    password: str = Field(..., description="User password (will be hashed server-side)")
    fullname: Optional[str] = Field(default="", description="User's full name")
    email: Optional[str] = Field(default="", description="User's email address")
    roles: Optional[List[str]] = Field(default=None, description="List of user roles")
    groups: Optional[List[str]] = Field(default=None, description="List of groups")


class UpdateUserRequest(BaseModel):
    """Request model for updating a user."""
    fullname: Optional[str] = Field(None, description="User's full name")
    email: Optional[str] = Field(None, description="User's email address")
    password: Optional[str] = Field(None, description="New password (will be hashed server-side)")
    roles: Optional[List[str]] = Field(None, description="List of user roles")
    groups: Optional[List[str]] = Field(None, description="List of groups")


class UpdateProfileRequest(BaseModel):
    """Request model for updating own user profile."""
    fullname: Optional[str] = Field(None, description="User's full name")
    email: Optional[str] = Field(None, description="User's email address")
    password: Optional[str] = Field(None, description="New password (will be hashed server-side)")


def require_authenticated(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    """Dependency that requires authentication."""
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return current_user


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


@router.get("", response_model=List[User])
def list_users(
    current_user: dict = Depends(require_authenticated)
):
    """
    List all users.

    Requires authentication.

    Returns:
        List of User objects (passwords excluded)
    """
    settings = get_settings()

    try:
        users_data = load_entity_data(settings.db_dir, 'users')

        # Convert to response models (exclude passwd_hash)
        users = [
            User(
                username=user.get('username', ''),
                fullname=user.get('fullname', ''),
                email=user.get('email', ''),
                roles=user.get('roles', ['user']),
                groups=user.get('groups', []),
                session_id=user.get('session_id')
            )
            for user in users_data
        ]

        logger.debug(f"Returning {len(users)} users")
        return users

    except Exception as e:
        logger.error(f"Error listing users: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving users: {str(e)}")


@router.get("/{username}", response_model=User)
def get_user(
    username: str,
    current_user: dict = Depends(require_authenticated)
):
    """
    Get a specific user by username.

    Requires authentication.

    Returns:
        User information (password excluded)
    """
    settings = get_settings()

    try:
        users_data = load_entity_data(settings.db_dir, 'users')
        user = find_user(username, users_data)

        if not user:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        return User(
            username=user.get('username', ''),
            fullname=user.get('fullname', ''),
            email=user.get('email', ''),
            roles=user.get('roles', ['user']),
            groups=user.get('groups', []),
            session_id=user.get('session_id')
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting user: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving user: {str(e)}")


@router.post("", response_model=User)
def create_user_endpoint(
    body: CreateUserRequest,
    current_user: dict = Depends(require_admin)
):
    """
    Create a new user.

    Requires admin role.

    Returns:
        Created user information (password excluded)
    """
    settings = get_settings()

    try:
        users_data = load_entity_data(settings.db_dir, 'users')

        # Check if user already exists
        if user_exists(body.username, users_data):
            raise HTTPException(status_code=400, detail=f"User '{body.username}' already exists")

        # Create user dict
        new_user = create_user(
            username=body.username,
            password=body.password,  # Will be hashed by create_user
            fullname=body.fullname or "",
            email=body.email or "",
            roles=body.roles,
            groups=body.groups
        )

        # Add to users list
        users_data.append(new_user)

        # Save to file
        save_entity_data(settings.db_dir, 'users', users_data)

        logger.info(f"User '{body.username}' created by admin '{current_user.get('username')}'")

        return User(
            username=new_user['username'],
            fullname=new_user['fullname'],
            email=new_user['email'],
            roles=new_user['roles'],
            groups=new_user['groups'],
            session_id=new_user.get('session_id')
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating user: {e}")
        raise HTTPException(status_code=500, detail=f"Error creating user: {str(e)}")


@router.put("/{username}", response_model=User)
def update_user_endpoint(
    username: str,
    body: UpdateUserRequest,
    current_user: dict = Depends(require_admin)
):
    """
    Update an existing user.

    Requires admin role.

    Returns:
        Updated user information (password excluded)
    """
    settings = get_settings()

    try:
        users_data = load_entity_data(settings.db_dir, 'users')
        user = find_user(username, users_data)

        if not user:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        # Update fields if provided
        if body.fullname is not None:
            user['fullname'] = body.fullname
        if body.email is not None:
            user['email'] = body.email
        if body.password is not None:
            user['passwd_hash'] = hash_password(body.password)
        if body.roles is not None:
            user['roles'] = body.roles
        if body.groups is not None:
            user['groups'] = body.groups

        # Save to file
        save_entity_data(settings.db_dir, 'users', users_data)

        logger.info(f"User '{username}' updated by admin '{current_user.get('username')}'")

        return User(
            username=user['username'],
            fullname=user['fullname'],
            email=user['email'],
            roles=user['roles'],
            groups=user['groups'],
            session_id=user.get('session_id')
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user: {e}")
        raise HTTPException(status_code=500, detail=f"Error updating user: {str(e)}")


@router.put("/me/profile", response_model=User)
def update_own_profile(
    body: UpdateProfileRequest,
    current_user: dict = Depends(require_authenticated)
):
    """
    Update own user profile.

    Allows authenticated users to update their own fullname, email, and password.
    Cannot modify roles or groups.

    Returns:
        Updated user information (password excluded)
    """
    settings = get_settings()
    username = current_user.get('username')

    if not username:
        raise HTTPException(status_code=400, detail="Username not found in session")

    try:
        users_data = load_entity_data(settings.db_dir, 'users')
        user = find_user(username, users_data)

        if not user:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        # Update fields if provided
        if body.fullname is not None:
            user['fullname'] = body.fullname
        if body.email is not None:
            user['email'] = body.email
        if body.password is not None:
            user['passwd_hash'] = hash_password(body.password)

        # Save to file
        save_entity_data(settings.db_dir, 'users', users_data)

        logger.info(f"User '{username}' updated their own profile")

        return User(
            username=user['username'],
            fullname=user['fullname'],
            email=user['email'],
            roles=user['roles'],
            groups=user['groups'],
            session_id=user.get('session_id')
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating profile: {e}")
        raise HTTPException(status_code=500, detail=f"Error updating profile: {str(e)}")


@router.delete("/{username}")
def delete_user_endpoint(
    username: str,
    current_user: dict = Depends(require_admin)
):
    """
    Delete a user.

    Requires admin role.
    Cannot delete yourself.

    Returns:
        Success message
    """
    settings = get_settings()

    # Prevent self-deletion
    if username == current_user.get('username'):
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    try:
        users_data = load_entity_data(settings.db_dir, 'users')

        # Find and remove user
        initial_count = len(users_data)
        users_data = [u for u in users_data if u.get('username') != username]

        if len(users_data) == initial_count:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found")

        # Save to file
        save_entity_data(settings.db_dir, 'users', users_data)

        logger.info(f"User '{username}' deleted by admin '{current_user.get('username')}'")

        return {"success": True, "message": f"User '{username}' deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting user: {e}")
        raise HTTPException(status_code=500, detail=f"Error deleting user: {str(e)}")

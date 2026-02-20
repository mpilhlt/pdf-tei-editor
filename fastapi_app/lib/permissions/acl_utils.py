"""
Access Control List utility functions for role-based permissions.

Backend equivalent of app/src/modules/acl-utils.js.
"""

from typing import Dict, List, Optional, Union
import logging

logger = logging.getLogger(__name__)


def user_has_role(user: Optional[Dict], role: Union[str, List[str]]) -> bool:
    """
    Check if user has one or more specific roles.

    Args:
        user: User dict with 'roles' key, or None
        role: Role name or list of role names

    Returns:
        True if user has any of the specified roles

    Note:
        If user has "*" in their roles array, they match any role check.
    """
    if not user or 'roles' not in user:
        return False

    user_roles = user.get('roles', [])

    # Wildcard "*" in user's roles grants access to any role check
    if '*' in user_roles:
        return True

    if isinstance(role, list):
        return any(r in user_roles for r in role)

    return role in user_roles


def user_has_all_roles(user: Optional[Dict], roles: List[str]) -> bool:
    """
    Check if user has all specified roles.

    Args:
        user: User dict with 'roles' key, or None
        roles: List of role names

    Returns:
        True if user has all specified roles

    Note:
        If user has "*" in their roles array, they match any role check.
    """
    if not user or 'roles' not in user or not isinstance(roles, list):
        return False

    user_roles = user.get('roles', [])

    # Wildcard "*" in user's roles grants access to any role check
    if '*' in user_roles:
        return True

    return all(role in user_roles for role in roles)


def user_is_admin(user: Optional[Dict]) -> bool:
    """
    Check if user is an admin.

    Args:
        user: User dict or None

    Returns:
        True if user has 'admin' role
    """
    return user_has_role(user, 'admin')


def user_owns_resource(user: Optional[Dict], owner: Optional[str]) -> bool:
    """
    Check if user owns a resource.

    Args:
        user: User dict or None
        owner: Owner username or None

    Returns:
        True if user's username matches owner
    """
    if not user or not owner:
        return False

    return user.get('username') == owner


def user_can_access_owned_resource(user: Optional[Dict], owner: Optional[str]) -> bool:
    """
    Check if user can access a resource based on ownership or admin privileges.

    Args:
        user: User dict or None
        owner: Resource owner username or None

    Returns:
        True if user is admin or owns the resource
    """
    return user_is_admin(user) or user_owns_resource(user, owner)


def user_has_reviewer_role(user: Optional[Dict]) -> bool:
    """
    Check if user has reviewer role.

    Args:
        user: User dict or None

    Returns:
        True if user has 'reviewer' role
    """
    if not user:
        return False
    return user_has_role(user, 'reviewer')


def user_has_annotator_role(user: Optional[Dict]) -> bool:
    """
    Check if user has annotator role.

    Args:
        user: User dict or None

    Returns:
        True if user has 'annotator' role
    """
    if not user:
        return False
    return user_has_role(user, 'annotator')


def is_gold_file(file_metadata) -> bool:
    """
    Check if a file is a gold standard file.

    Args:
        file_metadata: File metadata object with is_gold_standard attribute

    Returns:
        True if file is a gold standard
    """
    if not file_metadata:
        return False

    if hasattr(file_metadata, 'is_gold_standard'):
        return file_metadata.is_gold_standard is True

    # Handle dict case
    if isinstance(file_metadata, dict):
        return file_metadata.get('is_gold_standard') is True

    return False


def is_version_file(file_metadata) -> bool:
    """
    Check if a file is a version file (non-gold artifact).

    Args:
        file_metadata: File metadata object with is_gold_standard attribute

    Returns:
        True if file is a version (artifact but not gold standard)
    """
    if not file_metadata:
        return False

    if hasattr(file_metadata, 'is_gold_standard'):
        return file_metadata.is_gold_standard is False

    # Handle dict case
    if isinstance(file_metadata, dict):
        return file_metadata.get('is_gold_standard') is False

    return False


# High-level permission management functions for granular mode

def get_access_control_mode() -> str:
    """
    Get the current access control mode.

    Environment variable ACCESS_CONTROL_MODE takes precedence over config.
    This allows testing different modes without changing config files.

    Returns:
        'role-based', 'owner-based', or 'granular'
    """
    import os

    # Check environment variable first (useful for testing)
    env_mode = os.environ.get('ACCESS_CONTROL_MODE')
    if env_mode:
        valid_modes = ('role-based', 'owner-based', 'granular')
        if env_mode in valid_modes:
            return env_mode
        else:
            logger.warning(
                f"Invalid ACCESS_CONTROL_MODE '{env_mode}', "
                f"must be one of {valid_modes}. Falling back to config."
            )

    # Fall back to config
    from fastapi_app.lib.utils.config_utils import get_config
    config = get_config()
    return config.get('access-control.mode', default='role-based')


def _get_permissions_db():
    """
    Get a PermissionsDB instance using application settings.

    Returns:
        PermissionsDB instance
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.repository.permissions_db import PermissionsDB

    settings = get_settings()
    return PermissionsDB(settings.db_dir / "permissions.db", logger)


def get_file_permissions(stable_id: str, default_owner: Optional[str] = None) -> Optional[Dict]:
    """
    Get permissions for a file.

    Only returns permissions if access-control.mode is 'granular'.
    In other modes, returns None (permissions are implicit from mode rules).

    Args:
        stable_id: The stable ID of the file
        default_owner: Default owner if not in database

    Returns:
        Dict with visibility, editability, owner, or None if not in granular mode
    """
    mode = get_access_control_mode()
    if mode != 'granular':
        return None

    try:
        from fastapi_app.lib.utils.config_utils import get_config
        from fastapi_app.lib.repository.permissions_db import get_document_permissions

        config = get_config()
        default_visibility = config.get('access-control.default-visibility', default='collection')
        default_editability = config.get('access-control.default-editability', default='owner')

        permissions_db = _get_permissions_db()

        perms = get_document_permissions(
            stable_id,
            permissions_db,
            default_visibility=default_visibility,
            default_editability=default_editability,
            default_owner=default_owner
        )

        return {
            'stable_id': perms.stable_id,
            'visibility': perms.visibility,
            'editability': perms.editability,
            'owner': perms.owner,
            'created_at': perms.created_at,
            'updated_at': perms.updated_at
        }

    except Exception as e:
        logger.warning(f"Failed to get permissions for {stable_id}: {e}")
        return None


def set_default_permissions_for_new_file(stable_id: str, owner: str) -> bool:
    """
    Set default permissions for a newly created file.

    Only creates permission record if access-control.mode is 'granular'.
    Safe to call in any mode - will no-op in non-granular modes.

    Args:
        stable_id: The stable ID of the newly created file
        owner: The username of the file creator

    Returns:
        True if permissions were set, False otherwise
    """
    mode = get_access_control_mode()
    if mode != 'granular':
        return False

    try:
        from fastapi_app.lib.utils.config_utils import get_config
        from fastapi_app.lib.repository.permissions_db import set_document_permissions

        config = get_config()
        default_visibility = config.get('access-control.default-visibility', default='collection')
        default_editability = config.get('access-control.default-editability', default='owner')

        permissions_db = _get_permissions_db()

        set_document_permissions(
            stable_id=stable_id,
            visibility=default_visibility,
            editability=default_editability,
            owner=owner,
            permissions_db=permissions_db
        )

        logger.debug(f"Set default permissions for {stable_id}: visibility={default_visibility}, editability={default_editability}, owner={owner}")
        return True

    except Exception as e:
        logger.warning(f"Failed to set default permissions for {stable_id}: {e}")
        return False


def delete_permissions_for_file(stable_id: str) -> bool:
    """
    Delete permissions for a file being deleted.

    Only deletes permission record if access-control.mode is 'granular'.
    Safe to call in any mode - will no-op in non-granular modes.

    Args:
        stable_id: The stable ID of the file being deleted

    Returns:
        True if permissions were deleted, False otherwise
    """
    mode = get_access_control_mode()
    if mode != 'granular':
        return False

    try:
        from fastapi_app.lib.repository.permissions_db import delete_document_permissions

        permissions_db = _get_permissions_db()

        delete_document_permissions(stable_id, permissions_db)

        logger.debug(f"Deleted permissions for {stable_id}")
        return True

    except Exception as e:
        logger.warning(f"Failed to delete permissions for {stable_id}: {e}")
        return False

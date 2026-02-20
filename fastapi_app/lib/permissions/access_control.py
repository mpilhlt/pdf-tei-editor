"""
Access control logic supporting three modes:
- role-based: only role restrictions (gold = reviewers only)
- owner-based: documents editable only by owner
- granular: database-backed per-document permissions
"""

from typing import Optional, Dict, Any
import logging

from .config_utils import get_config
from .acl_utils import (
    user_has_reviewer_role,
    user_has_annotator_role,
    is_gold_file,
    is_version_file,
    user_is_admin,
    get_access_control_mode
)

logger = logging.getLogger(__name__)


def can_view_document(
    stable_id: str,
    file_metadata: Any,
    user: Optional[Dict],
    permissions_db=None  # PermissionsDB instance, required for granular mode
) -> bool:
    """
    Check if user can view document.

    Assumes user already has collection access.

    Args:
        stable_id: Artifact stable ID
        file_metadata: File metadata object with created_by attribute
        user: Current user dict
        permissions_db: PermissionsDB instance (required for granular mode)
    """
    mode = get_access_control_mode()

    # Reviewers and admins can always view
    if user_has_reviewer_role(user) or user_is_admin(user):
        return True

    if mode == 'role-based':
        # Everyone with collection access can view
        return True

    elif mode == 'owner-based':
        # Everyone with collection access can view
        return True

    elif mode == 'granular':
        if permissions_db is None:
            raise ValueError("permissions_db required for granular mode")
        config = get_config()

        from .permissions_db import get_document_permissions

        default_visibility = config.get('access-control.default-visibility', default='collection')
        default_owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None

        perms = get_document_permissions(
            stable_id,
            permissions_db,
            default_visibility=default_visibility,
            default_owner=default_owner
        )

        if perms.visibility == 'collection':
            return True
        elif perms.visibility == 'owner':
            return perms.owner == user.get('username') if user else False

    return True  # Default: allow view


def can_edit_document(
    stable_id: str,
    file_metadata: Any,
    user: Optional[Dict],
    permissions_db=None  # PermissionsDB instance, required for granular mode
) -> bool:
    """
    Check if user can edit document.

    Assumes user already has collection access.

    Args:
        stable_id: Artifact stable ID
        file_metadata: File metadata object with created_by and is_gold_standard attributes
        user: Current user dict
        permissions_db: PermissionsDB instance (required for granular mode)
    """
    mode = get_access_control_mode()

    if mode == 'role-based':
        # Reviewers and admins can always edit in role-based mode
        if user_has_reviewer_role(user) or user_is_admin(user):
            return True

        # Role-based restrictions for file types
        if is_gold_file(file_metadata):
            return user_has_reviewer_role(user)
        if is_version_file(file_metadata):
            return user_has_annotator_role(user) or user_has_reviewer_role(user)
        return True

    elif mode == 'owner-based':
        # Admins can always edit (they have ultimate authority)
        if user_is_admin(user):
            return True

        owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None
        username = user.get('username') if user else None

        # If file has no owner, allow reviewers to manage it
        if not owner:
            return user_has_reviewer_role(user)

        # Otherwise only owner can edit
        return owner == username

    elif mode == 'granular':
        if permissions_db is None:
            raise ValueError("permissions_db required for granular mode")
        config = get_config()

        from .permissions_db import get_document_permissions

        default_editability = config.get('access-control.default-editability', default='owner')
        default_owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None

        perms = get_document_permissions(
            stable_id,
            permissions_db,
            default_editability=default_editability,
            default_owner=default_owner
        )

        if perms.editability == 'collection':
            # Reviewers and admins can edit in collection mode
            if user_has_reviewer_role(user) or user_is_admin(user):
                return True
            # Still apply role-based restrictions for file types
            if is_gold_file(file_metadata):
                return user_has_reviewer_role(user)
            return True
        elif perms.editability == 'owner':
            # Only owner can edit (admins can always edit as they have ultimate authority)
            if user_is_admin(user):
                return True
            username = user.get('username') if user else None
            return perms.owner == username if user else False

    return False


def can_delete_document(
    stable_id: str,
    file_metadata: Any,
    user: Optional[Dict],
    permissions_db=None  # PermissionsDB instance, required for granular mode
) -> bool:
    """
    Check if user can delete document.

    Deletion rules:
    - Reviewers and admins can always delete
    - In role-based and owner-based modes: only owner can delete (besides reviewers)
    - Documents without owner: only reviewers can delete
    - In granular mode: follows editability rules

    Args:
        stable_id: Artifact stable ID
        file_metadata: File metadata object with created_by attribute
        user: Current user dict
        permissions_db: PermissionsDB instance (required for granular mode)
    """
    # Reviewers and admins can always delete
    if user_has_reviewer_role(user) or user_is_admin(user):
        return True

    mode = get_access_control_mode()

    if mode in ('role-based', 'owner-based'):
        # Only owner can delete (reviewers already handled above)
        # Documents without owner can only be deleted by reviewers
        owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None
        if not owner:
            return False  # No owner = only reviewers can delete
        return owner == user.get('username') if user else False

    elif mode == 'granular':
        # Granular mode: follows editability rules
        return can_edit_document(stable_id, file_metadata, user, permissions_db)

    return False


def can_modify_permissions(
    stable_id: str,
    file_metadata: Any,
    user: Optional[Dict],
    permissions_db=None  # PermissionsDB instance, required for granular mode
) -> bool:
    """
    Check if user can modify document permissions.

    Only available in granular mode. Owner and reviewers can modify permissions.

    Args:
        stable_id: Artifact stable ID
        file_metadata: File metadata object with created_by attribute
        user: Current user dict
        permissions_db: PermissionsDB instance (required for granular mode)
    """
    if not user:
        return False

    mode = get_access_control_mode()

    if mode != 'granular':
        return False  # Permission modification only in granular mode

    # Reviewers and admins can always modify permissions
    if user_has_reviewer_role(user) or user_is_admin(user):
        return True

    # Get current permissions to check ownership
    if permissions_db is None:
        raise ValueError("permissions_db required for granular mode")

    from .permissions_db import get_document_permissions

    default_owner = file_metadata.created_by if hasattr(file_metadata, 'created_by') else None

    perms = get_document_permissions(
        stable_id,
        permissions_db,
        default_owner=default_owner
    )

    # Owner can modify permissions
    return perms.owner == user.get('username')


def can_promote_demote(user: Optional[Dict]) -> bool:
    """
    Check if user can promote/demote documents (gold standard status).

    Only reviewers and admins can promote/demote.

    Args:
        user: Current user dict
    """
    return user_has_reviewer_role(user) or user_is_admin(user)


def check_file_access(file_metadata: Any, user: Optional[Dict], operation: str = 'read') -> bool:
    """
    Check if user has access to a file.

    Backwards-compatible function that uses the new mode-aware access control.
    Gets permissions_db internally if in granular mode.

    Args:
        file_metadata: FileMetadata Pydantic model with stable_id, created_by, is_gold_standard
        user: User dict with username and roles, or None
        operation: 'read', 'write', 'edit', or 'delete'

    Returns:
        True if access allowed
    """
    # Get stable_id from file metadata
    stable_id = file_metadata.stable_id if hasattr(file_metadata, 'stable_id') else None

    if not stable_id:
        # No stable_id means we can't check permissions properly, default to role-based
        logger.warning("check_file_access called without stable_id, defaulting to allow")
        return True

    # Get permissions_db if in granular mode
    mode = get_access_control_mode()

    permissions_db = None
    if mode == 'granular':
        from .acl_utils import _get_permissions_db
        permissions_db = _get_permissions_db()

    # Map operation to appropriate check function
    if operation == 'read':
        return can_view_document(stable_id, file_metadata, user, permissions_db)
    elif operation in ('write', 'edit'):
        return can_edit_document(stable_id, file_metadata, user, permissions_db)
    elif operation == 'delete':
        return can_delete_document(stable_id, file_metadata, user, permissions_db)
    else:
        logger.warning(f"Unknown operation '{operation}' in check_file_access, defaulting to read")
        return can_view_document(stable_id, file_metadata, user, permissions_db)


# Legacy compatibility - DocumentAccessFilter for files_list.py
class DocumentAccessFilter:
    """Filters document lists based on user access permissions."""

    @staticmethod
    def filter_files_by_access(documents, user: Optional[Dict]):
        """
        Filter document list based on user access.

        Args:
            documents: List of document objects
            user: User dict or None

        Returns:
            Filtered list containing only accessible documents
        """
        mode = get_access_control_mode()

        permissions_db = None
        if mode == 'granular':
            from .acl_utils import _get_permissions_db
            permissions_db = _get_permissions_db()

        filtered_documents = []

        for doc in documents:
            # Get stable_id for permission check
            stable_id = doc.stable_id if hasattr(doc, 'stable_id') else None

            if not stable_id:
                # No stable_id, include by default
                filtered_documents.append(doc)
                continue

            # Check view permission
            if can_view_document(stable_id, doc, user, permissions_db):
                filtered_documents.append(doc)

        return filtered_documents

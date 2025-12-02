"""
Access Control utilities for FastAPI.

Ported from server/lib/access_control.py with these changes:
- Work with Pydantic models instead of dicts
- Use database metadata instead of file parsing
- Remove Flask dependencies
- Simplified for file metadata-based access control
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Any
import logging

logger = logging.getLogger(__name__)


@dataclass
class DocumentPermissions:
    """Represents the access permissions for a document."""
    visibility: str  # 'public' or 'private'
    editability: str  # 'editable' or 'protected'
    owner: Optional[str]  # username of the owner
    status_values: List[str]  # raw status values from XML
    change_timestamp: Optional[str]  # when permissions were last changed


class AccessControlChecker:
    """Checks user access permissions against document permissions."""

    @staticmethod
    def check_document_access(
        permissions: DocumentPermissions,
        user: Optional[Dict],
        required_access: str = 'read'
    ) -> bool:
        """
        Check if user has required access to document.

        Args:
            permissions: Document permissions
            user: User dict with username and roles, or None for anonymous
            required_access: 'read' or 'write'

        Returns:
            True if access allowed, False otherwise
        """
        logger.debug(
            f"ACCESS CONTROL: checking access for user={user}, "
            f"permissions={permissions}, required_access={required_access}"
        )

        if not user:
            # Anonymous users can only read public documents
            result = permissions.visibility == 'public' and required_access == 'read'
            logger.debug(f"ACCESS CONTROL: anonymous user, result={result}")
            return result

        # Admin users have full access to everything
        if 'admin' in user.get('roles', []):
            logger.debug("ACCESS CONTROL: admin user, allowing access")
            return True

        username = user.get('username')
        logger.debug(f"ACCESS CONTROL: user={username}, roles={user.get('roles', [])}")

        # Check visibility permissions
        if permissions.visibility == 'private':
            # Private documents only accessible by owner
            if permissions.owner != username:
                logger.debug(
                    f"ACCESS CONTROL: private document, owner={permissions.owner}, "
                    f"user={username}, access denied"
                )
                return False

        # Check write permissions
        if required_access == 'write':
            if permissions.editability == 'protected':
                # Protected documents only writable by owner
                if permissions.owner != username:
                    logger.debug(
                        f"ACCESS CONTROL: protected document, owner={permissions.owner}, "
                        f"user={username}, write access denied"
                    )
                    return False

        logger.debug(
            f"ACCESS CONTROL: allowing access - visibility={permissions.visibility}, "
            f"editability={permissions.editability}, owner={permissions.owner}"
        )
        return True

    @staticmethod
    def can_modify_permissions(permissions: DocumentPermissions, user: Optional[Dict]) -> bool:
        """
        Check if user can modify document permissions.
        Only document owners and admins can modify permissions.

        Args:
            permissions: Current document permissions
            user: User dict or None

        Returns:
            True if user can modify permissions
        """
        if not user:
            return False

        # Admin users can always modify permissions
        if 'admin' in user.get('roles', []):
            return True

        # Document owners can modify permissions
        username = user.get('username')
        return permissions.owner == username


def get_document_permissions_from_metadata(metadata: Dict) -> DocumentPermissions:
    """
    Get permissions for a document from cached metadata.

    Args:
        metadata: File metadata dict (from FileMetadata.file_metadata or doc_metadata)

    Returns:
        DocumentPermissions object
    """
    access_control_data = metadata.get('access_control', {})

    if not access_control_data:
        # No access control metadata - return defaults
        return DocumentPermissions('public', 'editable', None, [], None)

    return DocumentPermissions(
        visibility=access_control_data.get('visibility', 'public'),
        editability=access_control_data.get('editability', 'editable'),
        owner=access_control_data.get('owner'),
        status_values=access_control_data.get('status_values', []),
        change_timestamp=metadata.get('last_update')
    )


def check_file_access(file_metadata: Any, user: Optional[Dict], operation: str = 'read') -> bool:
    """
    Check if user has access to a file.

    Args:
        file_metadata: FileMetadata Pydantic model
        user: User dict with username and roles, or None
        operation: 'read', 'write', or 'edit'

    Returns:
        True if access allowed
    """
    # Map operation to access type
    required_access = 'write' if operation in ['write', 'edit'] else 'read'

    # Get permissions from metadata
    metadata_dict = file_metadata.file_metadata or {}
    if hasattr(file_metadata, 'doc_metadata') and file_metadata.doc_metadata:
        # Also check doc_metadata for access control
        metadata_dict = {**metadata_dict, **(file_metadata.doc_metadata or {})}

    permissions = get_document_permissions_from_metadata(metadata_dict)

    return AccessControlChecker.check_document_access(permissions, user, required_access)


def filter_files_by_access(files: List[Any], user: Optional[Dict]) -> List[Any]:
    """
    Filter list of FileMetadata objects based on user access.

    Args:
        files: List of FileMetadata Pydantic models
        user: User dict or None

    Returns:
        Filtered list containing only accessible files
    """
    # Admin users see everything
    if user and 'admin' in user.get('roles', []):
        return files

    return [f for f in files if check_file_access(f, user, 'read')]


class DocumentAccessFilter:
    """Filters document lists based on user access permissions."""

    @staticmethod
    def filter_files_by_access(documents: List[Any], user: Optional[Dict]) -> List[Any]:
        """
        Filter document list (DocumentGroup objects) based on user access.

        Args:
            documents: List of DocumentGroup Pydantic models
            user: User dict or None

        Returns:
            Filtered list containing only accessible documents
        """
        # Admin users see everything
        if user and 'admin' in user.get('roles', []):
            return documents

        filtered_documents = []

        for doc in documents:
            # Get doc metadata for permissions
            doc_metadata = doc.doc_metadata or {}

            # Filter artifacts
            accessible_artifacts = []

            # Check source file access
            source_accessible = True
            if doc.source:
                source_accessible = DocumentAccessFilter._can_access_file(doc.source, doc_metadata, user)

            # Filter artifacts
            for artifact in doc.artifacts:
                if DocumentAccessFilter._can_access_file(artifact, doc_metadata, user):
                    accessible_artifacts.append(artifact)

            # Only include document if user has access to source or at least one artifact
            if source_accessible or accessible_artifacts:
                # Create a copy with filtered files
                doc_copy = doc.model_copy(deep=True)
                doc_copy.artifacts = accessible_artifacts
                # If source is not accessible, set it to None
                if not source_accessible:
                    doc_copy.source = None
                filtered_documents.append(doc_copy)

        return filtered_documents

    @staticmethod
    def _can_access_file(file_item: Any, doc_metadata: Dict, user: Optional[Dict]) -> bool:
        """Check if user can access a specific file using metadata."""
        # Combine file metadata and doc metadata
        file_metadata_dict = file_item.doc_metadata if hasattr(file_item, 'doc_metadata') else doc_metadata

        if not file_metadata_dict:
            # No metadata - default to allow access
            return True

        permissions = get_document_permissions_from_metadata(file_metadata_dict)
        return AccessControlChecker.check_document_access(permissions, user, 'read')

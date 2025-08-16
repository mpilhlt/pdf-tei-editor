"""
Access Control utilities for TEI documents.

Implements permission checking based on TEI revisionDesc/change elements.
Uses the last change element to determine current access permissions.
"""

import os
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Any
from datetime import datetime
from lxml import etree
from flask import current_app

from server.lib.server_utils import safe_file_path

logger = logging.getLogger(__name__)

@dataclass
class DocumentPermissions:
    """Represents the access permissions for a document."""
    visibility: str  # 'public' or 'private'
    editability: str  # 'editable' or 'protected'  
    owner: Optional[str]  # username of the owner
    status_values: List[str]  # raw status values from XML
    change_timestamp: Optional[str]  # when permissions were last changed

class AccessControlParser:
    """Parser for TEI document access control metadata."""
    
    @staticmethod
    def parse_document_permissions(xml_content: str) -> DocumentPermissions:
        """
        Parse access control metadata from TEI document XML.
        
        Args:
            xml_content: Full XML content of TEI document
            
        Returns:
            DocumentPermissions object with current permissions
        """
        try:
            root = etree.fromstring(xml_content)
            ns = {"tei": "http://www.tei-c.org/ns/1.0"}
            
            # Find all change elements in revisionDesc
            changes = root.xpath('.//tei:revisionDesc/tei:change', namespaces=ns)
            if not changes:
                # Default permissions if no change elements
                return DocumentPermissions(
                    visibility='public',
                    editability='editable',
                    owner=None,
                    status_values=[],
                    change_timestamp=None
                )
            
            # Get the last change element (most recent)
            last_change = changes[-1]
            status_attr = last_change.get('status', '')
            who_attr = last_change.get('who', '')
            when_attr = last_change.get('when', '')
            
            # Parse status values (space-separated)
            status_values = status_attr.split() if status_attr else []
            
            # Determine visibility: private if 'private' in status, otherwise public
            visibility = 'private' if 'private' in status_values else 'public'
            
            # Determine editability: protected if 'protected' in status, otherwise editable
            editability = 'protected' if 'protected' in status_values else 'editable'
            
            return DocumentPermissions(
                visibility=visibility,
                editability=editability,
                owner=who_attr if who_attr else None,
                status_values=status_values,
                change_timestamp=when_attr if when_attr else None
            )
            
        except Exception as e:
            logger.warning(f"Could not parse access control from XML: {e}")
            # Default to public/editable on parse error (fail-safe)
            return DocumentPermissions(
                visibility='public',
                editability='editable',
                owner=None,
                status_values=[],
                change_timestamp=None
            )

class AccessControlChecker:
    """Checks user access permissions against document permissions."""
    
    @staticmethod
    def check_document_access(permissions: DocumentPermissions, user: Optional[Dict], 
                            required_access: str = 'read') -> bool:
        """
        Check if user has required access to document.
        
        Args:
            permissions: Document permissions from parse_document_permissions()
            user: User dict with username and roles, or None for anonymous
            required_access: 'read' or 'write'
        
        Returns:
            True if access allowed, False otherwise
        """
        if not user:
            # Anonymous users can only read public documents
            return permissions.visibility == 'public' and required_access == 'read'
        
        # Admin users have full access to everything
        if 'admin' in user.get('roles', []):
            return True
        
        username = user.get('username')
        
        # Check visibility permissions
        if permissions.visibility == 'private':
            # Private documents only accessible by owner
            if permissions.owner != username:
                return False
        
        # Check write permissions
        if required_access == 'write':
            if permissions.editability == 'protected':
                # Protected documents only writable by owner
                if permissions.owner != username:
                    return False
        
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

class DocumentAccessFilter:
    """Filters document lists based on user access permissions."""
    
    @staticmethod
    def filter_files_by_access(files_data: List[Dict], user: Optional[Dict]) -> List[Dict]:
        """
        Filter file list based on user access permissions.
        Uses access control metadata from file_data (parsed during metadata collection).
        
        Args:
            files_data: List of file data dicts from get_file_data()
            user: User dict or None for anonymous access
            
        Returns:
            Filtered list containing only accessible files
        """
        # Admin users see everything
        if user and 'admin' in user.get('roles', []):
            return files_data
        
        filtered_files = []
        
        for file_data in files_data:
            if 'versions' in file_data:
                accessible_versions = []
                
                for version in file_data['versions']:
                    if DocumentAccessFilter._can_access_version_from_metadata(version, user):
                        accessible_versions.append(version)
                
                # Only include file if user has access to at least one version
                if accessible_versions:
                    file_data_copy = file_data.copy()
                    file_data_copy['versions'] = accessible_versions
                    filtered_files.append(file_data_copy)
        
        return filtered_files
    
    @staticmethod
    def _can_access_version_from_metadata(version: Dict, user: Optional[Dict]) -> bool:
        """Check if user can access a specific file version using cached metadata."""
        metadata = version.get('metadata', {})
        access_control_data = metadata.get('access_control', {})
        
        if not access_control_data:
            # No access control metadata - default to allow access
            return True
        
        # Convert metadata access control to DocumentPermissions object
        permissions = DocumentPermissions(
            visibility=access_control_data.get('visibility', 'public'),
            editability=access_control_data.get('editability', 'editable'),
            owner=access_control_data.get('owner'),
            status_values=access_control_data.get('status_values', []),
            change_timestamp=metadata.get('last_update')
        )
        
        return AccessControlChecker.check_document_access(permissions, user, 'read')
    
    @staticmethod
    def _can_access_version(version: Dict, user: Optional[Dict]) -> bool:
        """Check if user can access a specific file version (fallback - re-parses XML)."""
        # This method is kept as fallback but should rarely be used
        # since metadata now includes access control information
        version_path = version['path']
        if version_path.startswith('/data/'):
            version_path = version_path[6:]  # Remove /data/ prefix
        
        try:
            full_path = os.path.join(current_app.config["DATA_ROOT"], safe_file_path(version_path))
            if not os.path.exists(full_path):
                return False
                
            with open(full_path, 'r', encoding='utf-8') as f:
                xml_content = f.read()
            
            permissions = AccessControlParser.parse_document_permissions(xml_content)
            return AccessControlChecker.check_document_access(permissions, user, 'read')
            
        except Exception as e:
            logger.warning(f"Could not check access for {version_path}: {e}")
            # Fail-safe: allow access if we can't determine permissions
            return True

class AccessControlUpdater:
    """Updates document access control by adding new change elements."""
    
    @staticmethod
    def update_document_permissions(xml_content: str, new_status: str, 
                                  new_owner: str, user: Dict, 
                                  description: Optional[str] = None) -> str:
        """
        Update document permissions by adding a new change element.
        
        Args:
            xml_content: Current XML content
            new_status: New status string (e.g., "private protected")
            new_owner: New owner username
            user: User making the change (for audit trail)
            description: Optional description of the change
            
        Returns:
            Updated XML content with new change element
        """
        try:
            root = etree.fromstring(xml_content)
            ns = {"tei": "http://www.tei-c.org/ns/1.0"}
            
            # Find or create revisionDesc
            revision_desc = root.find('.//tei:revisionDesc', ns)
            if revision_desc is None:
                # Create revisionDesc in teiHeader
                tei_header = root.find('.//tei:teiHeader', ns)
                if tei_header is not None:
                    revision_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}revisionDesc")
            
            if revision_desc is not None:
                # Create new change element
                timestamp = datetime.now().isoformat()
                change = etree.SubElement(revision_desc, "{http://www.tei-c.org/ns/1.0}change")
                change.set('when', timestamp)
                change.set('status', new_status)
                change.set('who', new_owner)
                
                # Add description
                if description is None:
                    description = f"Access permissions updated by {user.get('username', 'unknown')}"
                desc = etree.SubElement(change, "{http://www.tei-c.org/ns/1.0}desc")
                desc.text = description
                
                # Serialize back to string
                from server.lib.tei_utils import serialize_tei_with_formatted_header
                return serialize_tei_with_formatted_header(root)
            
            return xml_content
            
        except Exception as e:
            logger.error(f"Could not update document permissions: {e}")
            return xml_content

# Convenience functions for common operations
def get_document_permissions(file_path: str) -> DocumentPermissions:
    """Get permissions for a document by file path (re-parses XML)."""
    try:
        full_path = os.path.join(current_app.config["DATA_ROOT"], safe_file_path(file_path))
        with open(full_path, 'r', encoding='utf-8') as f:
            xml_content = f.read()
        return AccessControlParser.parse_document_permissions(xml_content)
    except Exception as e:
        logger.warning(f"Could not get permissions for {file_path}: {e}")
        return DocumentPermissions('public', 'editable', None, [], None)

def get_document_permissions_from_metadata(metadata: Dict) -> DocumentPermissions:
    """Get permissions for a document from cached metadata (preferred method)."""
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

def check_file_access(file_path: str, user: Optional[Dict], required_access: str = 'read') -> bool:
    """Check if user has access to a specific file (re-parses XML)."""
    permissions = get_document_permissions(file_path)
    return AccessControlChecker.check_document_access(permissions, user, required_access)

def check_file_access_from_metadata(metadata: Dict, user: Optional[Dict], required_access: str = 'read') -> bool:
    """Check if user has access to a specific file using cached metadata (preferred method)."""
    permissions = get_document_permissions_from_metadata(metadata)
    return AccessControlChecker.check_document_access(permissions, user, required_access)
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
        Uses <label> elements within <change> elements for permissions.
        
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
            when_attr = last_change.get('when', '')
            
            # Parse label elements for access control
            visibility = 'public'  # default
            editability = 'editable'  # default
            owner = None
            
            # Find visibility label
            visibility_label = last_change.find('./tei:label[@type="visibility"]', ns)
            if visibility_label is not None and visibility_label.text:
                visibility_value = visibility_label.text.strip()
                if visibility_value in ['public', 'private']:
                    visibility = visibility_value
            
            # Find access label (maps to editability)
            access_label = last_change.find('./tei:label[@type="access"]', ns)
            if access_label is not None and access_label.text:
                access_value = access_label.text.strip()
                if access_value == 'protected':
                    editability = 'protected'
                elif access_value == 'private':
                    # Legacy: "private" in access maps to protected editability
                    editability = 'protected'
                else:
                    editability = 'editable'
            
            # Find owner label
            owner_label = last_change.find('./tei:label[@type="owner"]', ns)
            if owner_label is not None:
                # Check for ana attribute first (preferred format)
                ana_attr = owner_label.get('ana', '')
                if ana_attr and ana_attr.startswith('#'):
                    owner = ana_attr[1:]  # Remove # prefix
                elif owner_label.text:
                    # Fallback to text content for legacy format
                    owner = owner_label.text.strip()
            
            # Build status values for compatibility
            status_values = []
            if visibility == 'private':
                status_values.append('private')
            if editability == 'protected':
                status_values.append('protected')
            
            return DocumentPermissions(
                visibility=visibility,
                editability=editability,
                owner=owner,
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
            accessible_versions = []
            accessible_gold = []
            
            # Filter versions array
            if 'versions' in file_data:
                for version in file_data['versions']:
                    if DocumentAccessFilter._can_access_version_from_metadata(version, user):
                        accessible_versions.append(version)
            
            # Filter gold array
            if 'gold' in file_data:
                for gold_entry in file_data['gold']:
                    if DocumentAccessFilter._can_access_version_from_metadata(gold_entry, user):
                        accessible_gold.append(gold_entry)
            
            # Only include file if user has access to at least one version or gold entry
            if accessible_versions or accessible_gold:
                file_data_copy = file_data.copy()
                file_data_copy['versions'] = accessible_versions
                file_data_copy['gold'] = accessible_gold
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
    
class AccessControlUpdater:
    """Updates document access control by adding new change elements."""
    
    @staticmethod
    def update_document_permissions(xml_content: str, new_visibility: str, 
                                  new_editability: str, new_owner: str, user: Dict, 
                                  description: Optional[str] = None) -> str:
        """
        Update document permissions by adding a new change element with label elements.
        
        Args:
            xml_content: Current XML content
            new_visibility: 'public' or 'private'
            new_editability: 'editable' or 'protected'
            new_owner: New owner username
            user: User making the change (for audit trail)
            description: Optional description of the change
            
        Returns:
            Updated XML content with new change element
        """
        try:
            root = etree.fromstring(xml_content)
            ns = {"tei": "http://www.tei-c.org/ns/1.0"}
            
            # TEI namespace for element creation
            tei_ns = "{http://www.tei-c.org/ns/1.0}"
            
            # Find or create revisionDesc
            revision_desc = root.find('.//tei:revisionDesc', ns)
            if revision_desc is None:
                # Create revisionDesc in teiHeader
                tei_header = root.find('.//tei:teiHeader', ns)
                if tei_header is not None:
                    revision_desc = etree.SubElement(tei_header, f"{tei_ns}revisionDesc")
            
            if revision_desc is not None:
                # Create new change element
                timestamp = datetime.now().isoformat()
                change = etree.SubElement(revision_desc, f"{tei_ns}change")
                change.set('when', timestamp)
                
                # Add description
                if description is None:
                    description = f"Access permissions updated by {user.get('username', 'unknown')}"
                desc = etree.SubElement(change, f"{tei_ns}desc")
                desc.text = description
                
                # Add visibility label
                visibility_label = etree.SubElement(change, f"{tei_ns}label")
                visibility_label.set('type', 'visibility')
                visibility_label.text = new_visibility
                
                # Add access label (editability)
                access_label = etree.SubElement(change, f"{tei_ns}label")
                access_label.set('type', 'access')
                if new_editability == 'protected':
                    access_label.text = 'protected'
                else:
                    access_label.text = 'editable'
                
                # Add owner label
                if new_owner:
                    owner_label = etree.SubElement(change, f"{tei_ns}label")
                    owner_label.set('type', 'owner')
                    owner_label.text = new_owner
                
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
        # Only attempt to parse XML/TEI files - PDF files don't have XML permissions
        if not (file_path.endswith('.xml') or file_path.endswith('.tei.xml')):
            # Non-XML files default to public/editable (no access control metadata)
            logger.debug(f"Skipping XML parsing for non-XML file: {file_path}")
            return DocumentPermissions('public', 'editable', None, [], None)
            
        full_path = os.path.join(current_app.config["DATA_ROOT"], safe_file_path(file_path))
        # Use etree.parse() directly to avoid encoding declaration issues
        tree = etree.parse(full_path)
        xml_content = etree.tostring(tree, encoding='unicode')
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
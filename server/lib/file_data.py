"""
Module for handling file metadata collection, caching, and lookup generation.
This module separates the concerns of data collection from the API route handling.
"""

import os
import json
import re
from pathlib import Path
from glob import glob
from flask import current_app
from datetime import datetime
from lxml import etree
from typing import cast

from server.lib.server_utils import get_data_file_path
from server.lib.cache_manager import mark_cache_clean
from server.lib.hash_utils import generate_file_hash, create_hash_mapping

# File type mappings
FILE_TYPES = {".pdf": "pdf", ".tei.xml": "xml", ".xml": "xml", ".rng": "xml", ".xsd": "xml"}

# Metadata cache to avoid repeated XML parsing
_metadata_cache = {}

def get_tei_metadata(file_path):
    """
    Retrieves TEI metadata from the specified file.
    """
    try:
        tree = etree.parse(file_path)
    except etree.XMLSyntaxError as e:
        current_app.logger.error(f"XML Syntax Error in {file_path}: {e}")
        return None
    root = tree.getroot()
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    author = root.find("./tei:teiHeader//tei:author//tei:surname", ns)
    title = root.find("./tei:teiHeader//tei:title", ns)
    date = root.find('./tei:teiHeader//tei:date[@type="publication"]', ns)
    
    # Extract specific idno types
    doi = root.find('./tei:teiHeader//tei:idno[@type="DOI"]', ns)
    fileref = root.find('./tei:teiHeader//tei:idno[@type="fileref"]', ns)
    
    # Extract variant-id from extractor application metadata
    variant_id = None
    extractor_apps = cast(list, root.xpath('.//tei:application[@type="extractor"]', namespaces=ns))
    for app in extractor_apps:
        variant_label = app.find('./tei:label[@type="variant-id"]', ns)
        if variant_label is not None:
            variant_id = variant_label.text
            break  # Use the first variant-id found
    
    # Extract change attributes from revisionDesc/change elements
    change_attributes = {
        'last_update': None,
        'last_updated_by': None,
        'last_status': None
    }
    change_attr_mapping = {
        'last_update': 'when',
        'last_updated_by': 'who',
        'last_status': 'status'
    }
    
    # Access control attributes (parsed from last change element)
    access_control = {
        'visibility': 'public',      # default
        'editability': 'editable',   # default
        'owner': None,
        'status_values': []
    }
    
    change_elements = cast(list, root.xpath('.//tei:revisionDesc/tei:change[@when]', namespaces=ns))
    if change_elements:
        # Get the most recent change (last in document order)
        last_change = change_elements[-1]
        for result_key, attr_name in change_attr_mapping.items():
            change_attributes[result_key] = last_change.get(attr_name)
        
        # Parse access control from label elements in the last change element
        # Find visibility label
        visibility_label = last_change.find('./tei:label[@type="visibility"]', ns)
        if visibility_label is not None and visibility_label.text:
            visibility_value = visibility_label.text.strip()
            if visibility_value in ['public', 'private']:
                access_control['visibility'] = visibility_value
        
        # Find access label (maps to editability)
        access_label = last_change.find('./tei:label[@type="access"]', ns)
        if access_label is not None and access_label.text:
            access_value = access_label.text.strip()
            if access_value == 'protected':
                access_control['editability'] = 'protected'
            elif access_value == 'private':
                # Legacy: "private" in access maps to protected editability
                access_control['editability'] = 'protected'
            else:
                access_control['editability'] = 'editable'
        
        # Find owner label
        owner_label = last_change.find('./tei:label[@type="owner"]', ns)
        if owner_label is not None:
            # Check for ana attribute first (preferred format)
            ana_attr = owner_label.get('ana', '')
            if ana_attr and ana_attr.startswith('#'):
                access_control['owner'] = ana_attr[1:]  # Remove # prefix
            elif owner_label.text:
                # Fallback to text content for legacy format
                access_control['owner'] = owner_label.text.strip()
        
        # Build status values for compatibility
        status_values = []
        if access_control['visibility'] == 'private':
            status_values.append('private')
        if access_control['editability'] == 'protected':
            status_values.append('protected')
        access_control['status_values'] = status_values
    
    return {
        "author": author.text if author is not None else "",
        "title": title.text if title is not None else "",
        "date": date.text if date is not None else "",
        "doi": doi.text if doi is not None else "",
        "fileref": fileref.text if fileref is not None else "",
        "variant_id": variant_id,  # Backward compatible - None if not found
        **change_attributes,  # Include all change attributes
        "access_control": access_control  # Include access control metadata
    }

def get_version_name(file_path):
    """
    Retrieves version title from the specified file, encoded in teiHeader/fileDesc/editionStmt/edition/title
    """
    try:
        tree = etree.parse(file_path)
    except etree.XMLSyntaxError as e:
        current_app.logger.warning(f"XML Syntax Error in {file_path}: {str(e)}")
        return ""
        
    root = tree.getroot()
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    
    edition_stmts = cast(list, root.xpath("//tei:editionStmt", namespaces=ns))
    if edition_stmts:
        version_title_element = cast(list, edition_stmts[-1].xpath("./tei:edition/tei:title", namespaces=ns))
        if version_title_element:
            return version_title_element[0].text
   
    return None

def find_collection_for_file_id(file_id, data_root):
    """
    Find which collection a file_id belongs to by scanning for existing files.
    
    Args:
        file_id (str): The file ID to search for
        data_root (str): The data root directory
    
    Returns:
        str: Collection name if found, 'grobid' as default
    """
    # Look for PDF files first (most reliable)
    pdf_pattern = os.path.join(data_root, f"pdf/*/{file_id}.pdf")
    pdf_matches = glob(pdf_pattern)
    if pdf_matches:
        # Extract collection from path: data/pdf/collection/file.pdf
        collection = Path(pdf_matches[0]).parent.name
        return collection
    
    # Fallback: look for existing TEI files  
    tei_pattern = os.path.join(data_root, f"tei/*/{file_id}.tei.xml")
    tei_matches = glob(tei_pattern)
    if tei_matches:
        # Extract collection from path: data/tei/collection/file.tei.xml
        collection = Path(tei_matches[0]).parent.name
        return collection
    
    # Default fallback
    return 'grobid'

def extract_file_id_from_version_filename(filename_without_suffix, is_in_versions_dir=False):
    """
    Extracts the file_id from a version filename.
    
    For new version structure files in the versions directory, attempts to extract
    the file_id from timestamp-file_id format. For other files, returns the
    filename as the file_id.
    
    Args:
        filename_without_suffix (str): Filename without the file extension
        is_in_versions_dir (bool): Whether this file is in a versions directory
    
    Returns:
        tuple: (file_id, is_new_version_format)
    """
    if is_in_versions_dir:
        # Try to match timestamp pattern: YYYY-MM-DD_HH-MM-SS-file-id
        timestamp_pattern = r'^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(.+)$'
        match = re.match(timestamp_pattern, filename_without_suffix)
        if match:
            # Extract file_id from new format
            file_id = match.group(2)
            return file_id, True
        else:
            # Old format or non-timestamp filename
            return filename_without_suffix, False
    else:
        # Standard case: filename is the file_id
        return filename_without_suffix, False

def extract_version_label_from_path(path, file_id, is_old_version):
    """
    Extracts a display label for a version file.
    
    Args:
        path (pathlib.Path): Path object for the version file
        file_id (str): The file identifier
        is_old_version (bool): Whether this is old version structure
    
    Returns:
        str: Display label for the version
    """
    if is_old_version:
        # Old structure: versions/timestamp/file-id.xml
        return path.parent.name.replace("_", " ")
    else:
        # New structure: versions/file-id/timestamp-file-id.xml
        # Extract timestamp from filename: remove file_id and any extension suffix
        filename_no_ext = path.stem
        
        # Handle .tei.xml files where path.stem only removes .xml but leaves .tei
        if filename_no_ext.endswith('.tei'):
            filename_no_ext = filename_no_ext[:-4]  # Remove .tei suffix
        
        expected_suffix = f"-{file_id}"
        if filename_no_ext.endswith(expected_suffix):
            timestamp_part = filename_no_ext[:-len(expected_suffix)]
        else:
            # Fallback: just use the filename without extension
            timestamp_part = filename_no_ext
        return timestamp_part.replace("_", " ")

def construct_variant_filename(file_id, variant=None, extension=".tei.xml"):
    """
    Construct a filename with optional variant suffix.
    
    Args:
        file_id (str): The base file identifier
        variant (str, optional): The variant identifier
        extension (str): File extension
        
    Returns:
        str: Constructed filename (file-id.variant-id.tei.xml or file-id.tei.xml)
    """
    if variant:
        return f"{file_id}.{variant}{extension}"
    else:
        return f"{file_id}{extension}"

def collect_and_cache_file_data():
    """
    Main function to collect file data, generate lookups, and cache results.
    Returns the file data list for immediate use by the API.
    """
    data_root = current_app.config["DATA_ROOT"]
    
    # Clear metadata cache for fresh collection
    global _metadata_cache
    _metadata_cache = {}
    
    # Collect raw file data
    file_data = _collect_file_metadata(data_root)
    
    # Generate lookup tables
    lookup_table = _generate_lookup_table(file_data)
    collections_data = _generate_collections_data(file_data)
    
    # Optimize hashes by shortening them
    file_data, lookup_table = _shorten_hashes(file_data, lookup_table)
    
    # Cache everything to disk
    db_dir = current_app.config["DB_DIR"]
    _save_to_cache(db_dir / 'files.json', file_data)
    _save_to_cache(db_dir / 'lookup.json', lookup_table)
    _save_to_cache(db_dir / 'collections.json', collections_data)
    
    current_app.logger.info(f"Cached file data: {len(file_data)} files, {len(lookup_table)} lookups, {len(collections_data)} collections")
    current_app.logger.debug(f"XML metadata parsed for {len(_metadata_cache)} files")
    
    # Mark cache as clean since we just regenerated it
    mark_cache_clean()
    
    # Clear cache after use to free memory
    _metadata_cache = {}
    
    return file_data

def _get_cached_metadata(file_path):
    """
    Get metadata from cache or parse and cache it.
    Returns tuple: (tei_metadata, version_name)
    """
    global _metadata_cache
    
    if file_path in _metadata_cache:
        return _metadata_cache[file_path]
    
    # Parse metadata
    tei_metadata = None
    version_name = None
    
    try:
        tei_metadata = get_tei_metadata(file_path)
        version_name = get_version_name(file_path)
    except Exception as e:
        current_app.logger.debug(f"Failed to parse metadata for {file_path}: {e}")
    
    # Cache the result (even if None)
    result = (tei_metadata, version_name)
    _metadata_cache[file_path] = result
    return result

def _collect_file_metadata(data_root):
    """
    Collect file metadata by scanning the filesystem.
    Returns structured file data with improved organization.
    """
    file_id_data = {}
    
    # Scan all files in data directory
    for file_path in glob(f"{data_root}/**/*", recursive=True):
        if not os.path.isfile(file_path):
            continue
            
        path_obj = Path(file_path)
        rel_path = path_obj.relative_to(data_root)
        
        # Determine file type and extract file_id
        file_type, file_id = _analyze_file(file_path, rel_path)
        if not file_type or not file_id:
            continue
            
        # Initialize file_id entry
        if file_id not in file_id_data:
            file_id_data[file_id] = {}
        if file_type not in file_id_data[file_id]:
            file_id_data[file_id][file_type] = []
            
        # Add file info with metadata
        file_info = {
            'path': rel_path.as_posix(),
            'full_path': file_path,
            'hash': generate_file_hash(rel_path.as_posix()),
            'collection': _extract_collection_from_path(rel_path)
        }
        
        file_id_data[file_id][file_type].append(file_info)
    
    # Convert to final file list structure
    return _build_file_list(file_id_data)

def _analyze_file(file_path, rel_path):
    """
    Analyze a file to determine its type and extract file_id.
    Returns (file_type, file_id) or (None, None) if not a handled file.
    """
    file_type = None
    file_id = None
    
    # Check file type by extension
    for suffix, ftype in FILE_TYPES.items():
        if file_path.endswith(suffix):
            file_type = ftype
            filename_without_suffix = rel_path.name[:-len(suffix)]
            break
    
    if not file_type:
        return None, None
    
    # Extract file_id from TEI metadata for XML files
    if file_type == "xml":
        tei_metadata, _ = _get_cached_metadata(file_path)
        if tei_metadata and tei_metadata.get('fileref'):
            file_id = tei_metadata['fileref']
    
    # Fallback to filename-based extraction
    if not file_id:
        is_in_versions_dir = len(rel_path.parts) >= 3 and ("versions" in rel_path.parts)
        file_id, _ = extract_file_id_from_version_filename(
            filename_without_suffix, is_in_versions_dir
        )
    
    return file_type, file_id

def _extract_collection_from_path(rel_path):
    """
    Extract collection name from file path.
    Returns collection name or None.
    """
    parts = rel_path.parts
    if len(parts) >= 2:
        # Structure: pdf/collection/file.pdf or tei/collection/file.tei.xml
        if parts[0] in ['pdf', 'tei']:
            return parts[1]
        # Structure: versions/file_id/... 
        elif parts[0] == 'versions' and len(parts) >= 3:
            # For versions, try to determine collection from file_id
            data_root = current_app.config["DATA_ROOT"]
            return find_collection_for_file_id(parts[1], data_root)
    return None


def _build_file_list(file_id_data):
    """
    Convert raw file data into the structured format expected by the API.
    """
    file_list = []
    
    for file_id, file_type_data in file_id_data.items():
        file_dict = {
            "id": file_id,
            "versions": []
        }

        # Determine file classification based on available file types
        has_pdf = 'pdf' in file_type_data
        has_xml = 'xml' in file_type_data

        if has_pdf and has_xml:
            file_dict['file_type'] = 'pdf-xml'
        elif has_xml:
            # Check if this is a schema file by examining file extensions
            is_schema = any(
                Path(f['path']).suffix.lower() in ['.rng', '.xsd']
                for f in file_type_data['xml']
            )
            file_dict['file_type'] = 'schema' if is_schema else 'xml-only'
        else:
            file_dict['file_type'] = 'unknown'
        
        # Process each file type
        for file_type, files in file_type_data.items():
            for file_info in files:
                path_from_root = "/data/" + file_info['path']
                rel_path = Path(file_info['path'])
                
                # Determine if this is a version file
                is_version_file = (len(rel_path.parts) >= 3 and "versions" in rel_path.parts)
                
                # Add collection info
                file_dict['collection'] = file_info['collection']
                
                if is_version_file:
                    # Handle version files - defer label formatting until we have all versions
                    version_entry = _build_version_entry(file_info, path_from_root, file_id, format_label=False)
                    file_dict['versions'].append(version_entry)
                else:
                    # Handle main files (PDF and gold TEI)
                    if file_type == 'pdf':
                        file_dict['pdf'] = {
                            'path': path_from_root,  # Keep for backward compatibility during transition
                            'hash': file_info['hash']
                        }
        
        # Build gold variants array and handle backward compatibility
        gold_variants = _build_gold_variants_array(file_id, file_type_data)
        if gold_variants:
            file_dict['gold'] = gold_variants
            
        # Add top-level metadata from main XML file
        _add_top_level_metadata(file_dict)
        
        # Sort versions and add Gold entry if main XML exists
        _finalize_versions(file_dict)
        
        # Include files that have PDF and at least one XML, OR standalone XML files
        has_pdf = 'pdf' in file_dict
        has_xml = ((file_dict.get('gold') and len(file_dict['gold']) > 0) or
                  (file_dict.get('versions') and len(file_dict['versions']) > 0))

        # Allow standalone XML files (without PDF) - useful for schema generation and XML-only workflows
        if (has_pdf and has_xml) or (not has_pdf and has_xml):
            file_list.append(file_dict)
    
    # Sort by ID
    return sorted(file_list, key=lambda f: f.get("id"))

def _build_entry_with_metadata(file_info, path_from_root, file_id=None, format_label=True, is_version=True):
    """Build an entry (version or gold) with metadata and label formatting."""
    rel_path = Path(file_info['path'])
    
    # Extract base label
    if is_version and file_id:
        # For version files, use version-specific label extraction
        is_new_version = rel_path.parent.name == file_id
        is_old_version = not is_new_version
        fallback_label = extract_version_label_from_path(rel_path, file_id, is_old_version)
    else:
        # For gold files, use filename
        fallback_label = rel_path.stem
        if fallback_label.endswith('.tei'):
            fallback_label = fallback_label[:-4]
    
    entry = {
        'label': fallback_label,
        'path': path_from_root,  # Will be converted to hash later
        'hash': file_info['hash'],
        'collection': file_info['collection']
    }
    
    # Add metadata from TEI file (using cache)
    tei_metadata, version_name = _get_cached_metadata(file_info['full_path'])
    
    # Use version name if available
    if version_name:
        entry['version_name'] = version_name
        entry['label'] = version_name # default
    
    # Add TEI metadata
    if tei_metadata:
        # Add the complete metadata object for access control filtering
        entry['metadata'] = tei_metadata
        
        # Add change tracking attributes
        for attr in ['variant_id', 'last_update', 'last_updated_by', 'last_status']:
            if tei_metadata.get(attr):
                entry[attr] = tei_metadata[attr]
        
        # Format timestamp in label (only if requested)
        if format_label and tei_metadata.get('last_update'):
            formatted_time = _format_timestamp(tei_metadata['last_update'])
            if formatted_time:
                base_label = version_name or fallback_label
                label_parts = [formatted_time]
                
                # Add last_updated_by with hash sign stripped
                if tei_metadata.get('last_updated_by'):
                    updated_by = tei_metadata['last_updated_by'].lstrip('#')
                    label_parts.append(updated_by)
                
                entry['label'] = f"{base_label} ({', '.join(label_parts)})"
    
    return entry

def _build_version_entry(file_info, path_from_root, file_id, format_label=True):
    """Build a version entry with metadata."""
    return _build_entry_with_metadata(file_info, path_from_root, file_id, format_label, is_version=True)

def _build_gold_variants_array(file_id, file_type_data):
    """
    Build the gold variants array: list of file data objects like versions
    """
    gold_variants = []
    
    if 'xml' not in file_type_data:
        return gold_variants
    
    for file_info in file_type_data['xml']:
        path_from_root = "/data/" + file_info['path']
        rel_path = Path(file_info['path'])
        
        # Skip version files for gold array
        if len(rel_path.parts) >= 3 and "versions" in rel_path.parts:
            continue
        
        # Build gold entry using shared function (same label handling as versions)
        gold_entry = _build_entry_with_metadata(file_info, path_from_root, file_id, format_label=False, is_version=False)
        
        gold_variants.append(gold_entry)
    
    return gold_variants

def _add_top_level_metadata(file_dict):
    """Add top-level metadata (author, title, date, label) from main XML file."""
    # Try to get XML path from first gold variant
    xml_path = None
    if file_dict.get('gold') and len(file_dict['gold']) > 0:
        xml_path = file_dict['gold'][0].get('path')
    
    if not xml_path:
        return
    
    # Convert /data/ path to actual file path
    if xml_path.startswith('/data/'):
        rel_path = xml_path[6:]  # Remove '/data/' prefix
        data_root = current_app.config["DATA_ROOT"]
        full_path = os.path.join(data_root, rel_path)
        
        # Get metadata from XML file (using cache)
        tei_metadata, _ = _get_cached_metadata(full_path)
        if tei_metadata:
            # Add basic metadata fields
            for key in ['author', 'title', 'date', 'doi', 'fileref']:
                if tei_metadata.get(key):
                    file_dict[key] = tei_metadata[key]
            
            # Generate label
            author = tei_metadata.get('author', '')
            title = tei_metadata.get('title', '')
            date = tei_metadata.get('date', '')
            doi = tei_metadata.get('doi', '')
            fileref = tei_metadata.get('fileref', '')
            
            if author and title and date:
                label = f"{author}, {title[:25]}... ({date})"
            elif doi:
                label = doi
            elif fileref:
                label = fileref
            else:
                label = file_dict.get('id', '')
            
            file_dict['label'] = label

def _extract_variant_from_file(file_info):
    """Extract variant ID from file metadata or filename."""
    # Try metadata first (using cache)
    tei_metadata, _ = _get_cached_metadata(file_info['full_path'])
    if tei_metadata and tei_metadata.get('variant_id'):
        return tei_metadata['variant_id']
    
    # Fallback to filename analysis
    rel_path = Path(file_info['path'])
    filename = rel_path.stem
    
    # Handle .tei.xml files
    if filename.endswith('.tei'):
        filename = filename[:-4]
    
    # Look for pattern: file-id.variant-id
    parts = filename.split('.')
    if len(parts) > 1:
        return parts[-1]  # Last part is variant
    
    return None

def _get_latest_variant_fallback(file_id, file_type_data):
    """
    Get the latest version as fallback when no gold file exists.
    Note: Currently returns oldest for backward compatibility, but should be changed to latest.
    """
    if 'xml' not in file_type_data:
        return None
    
    version_files = []
    for file_info in file_type_data['xml']:
        rel_path = Path(file_info['path'])
        if len(rel_path.parts) >= 3 and "versions" in rel_path.parts:
            version_files.append("/data/" + file_info['path'])  # Will be converted to hash later
    
    # Return oldest for backward compatibility (TODO: change to latest)
    return version_files[0] if version_files else None

def _finalize_versions(file_dict):
    """Sort versions, remove duplicates with gold entries, and format labels with smart date/time."""
    # Sort versions by last_update
    file_dict['versions'].sort(key=lambda v: v.get('last_update') or '')
    
    # Remove any versions that duplicate gold entries
    if 'gold' in file_dict:
        gold_paths = {entry['path'] for entry in file_dict['gold']}
        file_dict['versions'] = [v for v in file_dict['versions'] 
                                if v.get('path') not in gold_paths]
    
    # Format version labels with smart date/time logic
    date_counts = {}  # Track which dates have multiple entries
    
    # First pass: count versions per date
    for version in file_dict['versions']:
        if version.get('last_update'):
            date_only = version['last_update'].split('T')[0]  # Get YYYY-MM-DD part
            date_counts[date_only] = date_counts.get(date_only, 0) + 1
    
    # Second pass: format labels based on date frequency
    for version in file_dict['versions']:
        if version.get('last_update'):
            timestamp_str = version['last_update']
            date_only = timestamp_str.split('T')[0]
            
            # Use date-only format if it's the only version for that date
            if date_counts.get(date_only, 0) == 1:
                formatted_time = _format_timestamp_date_only(timestamp_str)
            else:
                # Use full timestamp if multiple versions on same date
                formatted_time = _format_timestamp(timestamp_str)
            
            if formatted_time:
                # Get base label from existing label or fallback
                base_label = version.get('label', version.get('path', '').split('/')[-1])
                if '(' in base_label:
                    base_label = base_label.split('(')[0].strip()
                    
                label_parts = [formatted_time]
                
                # Add last_updated_by with hash sign stripped
                if version.get('last_updated_by'):
                    updated_by = version['last_updated_by'].lstrip('#')
                    label_parts.append(updated_by)
                
                version['label'] = f"{base_label} ({', '.join(label_parts)})"


def _format_timestamp_date_only(timestamp_str):
    """Format ISO timestamp to date only."""
    try:
        if 'T' in timestamp_str:
            # Full ISO timestamp
            dt = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
        else:
            # Date only
            dt = datetime.fromisoformat(timestamp_str)
        
        return dt.strftime('%Y-%m-%d')
    except (ValueError, TypeError):
        return None

def _format_timestamp(timestamp_str):
    """Format ISO timestamp for display."""
    try:
        if 'T' in timestamp_str:
            # Full ISO timestamp
            dt = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
        else:
            # Date only
            dt = datetime.fromisoformat(timestamp_str)
        
        # Omit time if it's midnight
        if dt.time() == dt.time().replace(hour=0, minute=0, second=0, microsecond=0):
            return dt.strftime('%Y-%m-%d')
        else:
            return dt.strftime('%Y-%m-%d %H:%M:%S')
    except (ValueError, TypeError):
        return None

def _generate_lookup_table(file_data):
    """Generate hash -> file path lookup table."""
    lookup = {}
    
    for file_entry in file_data:
        # Add PDF file
        if 'pdf' in file_entry and 'path' in file_entry['pdf']:
            path = file_entry['pdf']['path'].replace('/data/', '')
            file_hash = generate_file_hash(path)
            lookup[file_hash] = path
        
        # Add version files
        for version in file_entry.get('versions', []):
            if 'hash' in version and 'path' in version:
                path = version['path'].replace('/data/', '')
                lookup[version['hash']] = path
                
        # Add gold files  
        for gold in file_entry.get('gold', []):
            if 'hash' in gold and 'path' in gold:
                path = gold['path'].replace('/data/', '')
                lookup[gold['hash']] = path
    
    return lookup

def _generate_collections_data(file_data):
    """Generate collections metadata."""
    collections = {}
    
    for file_entry in file_data:
        collection = file_entry.get('collection')
        if collection and collection not in collections:
            collections[collection] = {}
    
    return collections

def _shorten_hashes(file_data, lookup_table):
    """Shorten hashes to the minimum length needed to avoid collisions."""
    # Collect all hashes used in the data
    all_hashes = set()
    
    # Collect hashes from file entries
    for file_entry in file_data:
        # Collect hash from pdf object
        if 'pdf' in file_entry and 'hash' in file_entry['pdf']:
            all_hashes.add(file_entry['pdf']['hash'])
        
        # Collect hashes from versions
        for version in file_entry.get('versions', []):
            if 'hash' in version:
                all_hashes.add(version['hash'])
        
        # Collect hashes from gold entries
        for gold in file_entry.get('gold', []):
            if 'hash' in gold:
                all_hashes.add(gold['hash'])
    
    # Collect hashes from lookup table keys
    all_hashes.update(lookup_table.keys())
    
    if not all_hashes:
        return file_data, lookup_table
    
    # Create mapping from long hash to short hash using utility function
    hash_mapping = create_hash_mapping(all_hashes)
    hash_length = len(next(iter(hash_mapping.values()))) if hash_mapping else 5
    
    # Apply hash shortening to file data
    for file_entry in file_data:
        # Update PDF hash
        if 'pdf' in file_entry and 'hash' in file_entry['pdf']:
            old_hash = file_entry['pdf']['hash']
            if old_hash in hash_mapping:
                file_entry['pdf']['hash'] = hash_mapping[old_hash]
        
        # Update version hashes
        for version in file_entry.get('versions', []):
            if 'hash' in version:
                version['hash'] = hash_mapping[version['hash']]
        
        # Update gold entry hashes
        for gold in file_entry.get('gold', []):
            if 'hash' in gold:
                gold['hash'] = hash_mapping[gold['hash']]
    
    # Update lookup table with shortened hashes
    shortened_lookup = {hash_mapping[k]: v for k, v in lookup_table.items() if k in hash_mapping}
    
    current_app.logger.debug(f"Shortened hashes from 32 to {hash_length} characters ({len(all_hashes)} unique hashes)")
    
    return file_data, shortened_lookup

def _save_to_cache(file_path, data):
    """Save data to cache file."""
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        current_app.logger.error(f"Failed to save cache to {file_path}: {e}")

def load_cached_file_data():
    """
    Load file data from cache if available and recent.
    Returns None if cache is missing or stale.
    """
    try:
        db_dir = current_app.config["DB_DIR"]
        cache_file = db_dir / 'files.json'
        
        if not cache_file.exists():
            return None
        
        # Check if cache is recent (less than 5 minutes old)
        cache_age = datetime.now().timestamp() - cache_file.stat().st_mtime
        if cache_age > 300:  # 5 minutes
            current_app.logger.debug("File cache is stale, will regenerate")
            return None
        
        with open(cache_file, 'r', encoding='utf-8') as f:
            return json.load(f)
            
    except Exception as e:
        current_app.logger.warning(f"Failed to load file cache: {e}")
        return None

def get_file_data(force_refresh=False):
    """
    Get file data, using cache if available or regenerating if needed.
    
    Args:
        force_refresh: If True, always regenerate from filesystem
    
    Returns:
        List of file data dictionaries
    """
    if not force_refresh:
        cached_data = load_cached_file_data()
        if cached_data:
            current_app.logger.debug("Using cached file data")
            return cached_data
    
    current_app.logger.info("Generating fresh file data")
    return collect_and_cache_file_data()

def apply_variant_filtering(files_data, variant_filter):
    """Apply variant filtering to files data."""
    if variant_filter == "":
        # Empty string means show files with no variant (gold files)
        # Check for variant_id in gold array since it's not at top level anymore
        filtered_data = []
        for f in files_data:
            # Check if any gold entry has variant_id
            has_gold_variant = any(g.get('variant_id') for g in f.get('gold', []))
            if not has_gold_variant:
                filtered_data.append(f)
    else:
        # Show files with matching variant_id (check gold and versions)
        filtered_data = []
        for f in files_data:
            # Check if any gold entry has this variant
            has_matching_gold = any(g.get('variant_id') == variant_filter for g in f.get('gold', []))
            # Check if any version has this variant
            has_matching_version = any(v.get('variant_id') == variant_filter for v in f.get('versions', []))
            
            if has_matching_gold or has_matching_version:
                filtered_data.append(f)
    
    # Filter versions array to only show relevant versions
    for file_data in filtered_data:
        if 'versions' in file_data:
            if variant_filter == "":
                filtered_gold = [v for v in file_data['gold'] if not v.get('variant_id')]
                filtered_versions = [v for v in file_data['versions'] if not v.get('variant_id')]
            else:
                filtered_gold = [v for v in file_data['gold'] if v.get('variant_id') == variant_filter]
                filtered_versions = [v for v in file_data['versions'] if v.get('variant_id') == variant_filter]
            
            file_data['versions'] = filtered_versions
            file_data['gold'] = filtered_gold
    
    return filtered_data
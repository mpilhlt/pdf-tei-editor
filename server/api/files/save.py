from flask import Blueprint, jsonify, request, current_app
import os
import re
import logging
from lxml import etree
from pathlib import Path

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import (
    ApiError, make_version_timestamp, get_data_file_path,
    safe_file_path, remove_obsolete_marker_if_exists, get_session_id,
    get_version_path, migrate_old_version_files, resolve_document_identifier,
    strip_version_timestamp_prefix
)
from server.lib.file_data import find_collection_for_file_id, construct_variant_filename
from server.lib.cache_manager import mark_cache_dirty, mark_sync_needed
from server.lib.locking import acquire_lock
from server.lib.xml_utils import encode_xml_entities
from server.lib.tei_utils import serialize_tei_with_formatted_header
from server.api.config import read_config
from server.lib.auth import get_user_by_session_id
from server.lib.access_control import check_file_access
from server.lib.hash_utils import add_path_to_lookup

logger = logging.getLogger(__name__)
bp = Blueprint("files_save", __name__, url_prefix="/api/files")


def _save_xml_content(xml_string, file_path_or_hash, save_as_new_version, session_id):
    """
    Common helper function to save XML content to file.
    Returns a dict with 'status' and 'path' keys.
    """
    # Resolve hash to path if needed
    file_path_rel = resolve_document_identifier(file_path_or_hash)
    
    # Check write access permissions
    user = get_user_by_session_id(session_id)
    if not check_file_access(file_path_rel, user, 'write'):
        raise ApiError("Insufficient permissions to modify this document", status_code=403)
    
    # encode xml entities as per configuration
    if read_config().get("xml.encode-entities.server", False) == True:
        logger.debug("Encoding XML entities")
        xml_string = encode_xml_entities(xml_string)
    
    # Extract file_id and variant from XML content and ensure file_id is stored
    try:
        # Parse XML to extract file_id and variant
        xml_root = etree.fromstring(xml_string)
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}
        
        # Always derive file_id from filename, not from existing XML
        file_path_safe = safe_file_path(file_path_rel)
        fallback_file_id = Path(file_path_safe).stem
        
        # Handle .tei.xml files where Path.stem only removes .xml but leaves .tei
        if fallback_file_id.endswith('.tei'):
            fallback_file_id = fallback_file_id[:-4]  # Remove .tei suffix
        
        # Strip timestamp from version files (format: timestamp-file-id)
        if file_path_rel.startswith('/data/versions/'):
            fallback_file_id = strip_version_timestamp_prefix(fallback_file_id)
        
        # Extract variant from extractor application metadata
        variant = None
        extractor_apps = xml_root.xpath('.//tei:application[@type="extractor"]', namespaces=ns)
        for app in extractor_apps:
            variant_label = app.find('./tei:label[@type="variant-id"]', ns)
            if variant_label is not None and variant_label.text:
                variant = variant_label.text
                break  # Use the first variant-id found
        
        # If variant exists in XML, try to strip .variant_id suffix from filename
        if variant and fallback_file_id.endswith(f'.{variant}'):
            file_id = fallback_file_id[:-len(f'.{variant}')]
        else:
            file_id = fallback_file_id
        
        # Always update fileref in XML to match derived file_id
        fileref_elem = xml_root.find('.//tei:idno[@type="fileref"]', ns)
        if fileref_elem is not None:
            # Update existing fileref
            old_fileref = fileref_elem.text
            if old_fileref != file_id:
                fileref_elem.text = file_id
                xml_string = serialize_tei_with_formatted_header(xml_root)
                logger.debug(f"Updated fileref in XML: {old_fileref} -> {file_id}")
            else:
                logger.debug(f"Fileref already correct in XML: {file_id}, variant: {variant}")
        else:
            # Add fileref to XML - find or create editionStmt
            edition_stmt = xml_root.find('.//tei:editionStmt', ns)
            if edition_stmt is None:
                # Create editionStmt in teiHeader/fileDesc
                file_desc = xml_root.find('.//tei:fileDesc', ns)
                if file_desc is not None:
                    edition_stmt = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}editionStmt")
            
            if edition_stmt is not None:
                # Find or create edition element
                edition = edition_stmt.find('./tei:edition', ns)
                if edition is None:
                    edition = etree.SubElement(edition_stmt, "{http://www.tei-c.org/ns/1.0}edition")
                
                # Add idno with fileref
                fileref_elem = etree.SubElement(edition, "{http://www.tei-c.org/ns/1.0}idno")
                fileref_elem.set("type", "fileref")
                fileref_elem.text = file_id
                
                # Update xml_string with the modified XML (formatted header only)
                xml_string = serialize_tei_with_formatted_header(xml_root)
                logger.debug(f"Added file_id to XML: {file_id}")
        
    except Exception as e:
        logger.warning(f"Could not extract metadata from XML: {e}")
        # Fallback to filename-based extraction
        file_path_safe = safe_file_path(file_path_rel)
        file_id = Path(file_path_safe).stem
        if file_id.endswith('.tei'):
            file_id = file_id[:-4]
        
        # Strip timestamp from version files (format: timestamp-file-id)
        if file_path_rel.startswith('/data/versions/'):
            file_id = strip_version_timestamp_prefix(file_id)
        
        variant = None
    
    # Check if this is a version file that should be promoted to gold
    version_to_gold_promotion = False
    if variant and file_path_rel.startswith('/data/versions/'):
        # This is a version file with a variant - check if gold variant exists
        file_path_safe = safe_file_path(file_path_rel)
        original_dir_parts = file_path_safe.split('/')
        if len(original_dir_parts) >= 3 and original_dir_parts[0] == 'versions':
            # Find which collection this file_id belongs to
            collection = find_collection_for_file_id(file_id, current_app.config["DATA_ROOT"])
            
            variant_filename = construct_variant_filename(file_id, variant)
            expected_gold_variant_path = os.path.join(current_app.config["DATA_ROOT"], 
                                                    f"tei/{collection}/{variant_filename}")
            
            # If no gold variant file exists, this version should become the new gold
            if not os.path.exists(expected_gold_variant_path):
                logger.info(f"Promoting version file to gold: {file_path_rel} -> tei/{collection}/{variant_filename}")
                version_to_gold_promotion = True
                promotion_collection = collection
                # Create deletion marker for the original version file location
                if current_app.config.get('WEBDAV_ENABLED', False):
                    original_full_path = get_data_file_path(file_path_rel)
                    Path(original_full_path + ".deleted").touch()
                    logger.info(f"Created deletion marker for {original_full_path}")
    
    # Determine the final save path
    if version_to_gold_promotion:
        # Promote version to gold
        variant_filename = construct_variant_filename(file_id, variant)
        final_file_rel = f"tei/{promotion_collection}/{variant_filename}"
        status = "promoted_to_gold"
    elif save_as_new_version:
        # Check if we have a variant and no existing gold variant file
        if variant:
            # Construct expected gold variant path
            file_path_safe = safe_file_path(file_path_rel)
            original_dir = Path(file_path_safe).parent
            variant_filename = construct_variant_filename(file_id, variant)
            expected_gold_variant_path = os.path.join(current_app.config["DATA_ROOT"], 
                                                    (original_dir / variant_filename).as_posix())
            
            # If no gold variant file exists, create it as gold instead of version
            if not os.path.exists(expected_gold_variant_path):
                logger.info(f"No existing gold variant file found at {expected_gold_variant_path}, creating as gold file")
                final_file_rel = (original_dir / variant_filename).as_posix()
                status = "new_gold_variant"
            else:
                # Gold variant exists, create as version
                timestamp = make_version_timestamp()
                final_file_rel = get_version_path(file_id, timestamp, ".xml")
                status = "new"
        else:
            # No variant, create as version
            timestamp = make_version_timestamp()
            final_file_rel = get_version_path(file_id, timestamp, ".xml")
            status = "new"
    else:
        # For regular saves, construct path based on variant
        if variant:
            # Construct variant filename: file-id.variant-id.tei.xml
            variant_filename = construct_variant_filename(file_id, variant)
            # Keep the directory structure from original path
            file_path_safe = safe_file_path(file_path_rel)
            original_dir = Path(file_path_safe).parent
            final_file_rel = (original_dir / variant_filename).as_posix()
        else:
            # No variant - use original path or construct gold path
            file_path_safe = safe_file_path(file_path_rel)
            original_dir = Path(file_path_safe).parent
            gold_filename = construct_variant_filename(file_id, None)  # file-id.tei.xml
            final_file_rel = (original_dir / gold_filename).as_posix()
        status = "saved"

    # Get a file lock for this path
    lock_file_path = '/data/' + final_file_rel
    if not acquire_lock(lock_file_path, session_id):
        # Use a specific error message for the frontend to catch
        raise ApiError("Failed to acquire lock", status_code = 423)
    logger.info(f"Acquired lock for {lock_file_path}")
    
    # get the full path and create directories if necessary
    data_root = current_app.config["DATA_ROOT"]
    full_save_path = os.path.join(data_root, final_file_rel)
    os.makedirs(os.path.dirname(full_save_path), exist_ok=True)
    
    remove_obsolete_marker_if_exists(full_save_path, current_app.logger)
    
    # Write the file
    with open(full_save_path, "w", encoding="utf-8") as f:
        f.write(xml_string)
    logger.info(f"Saved file to {full_save_path}")
    
    # Mark cache as dirty since we modified the filesystem
    mark_cache_dirty()
    # Mark sync as needed since files were changed
    mark_sync_needed()

    # Migration: For regular saves, migrate any existing old version files for this file_id
    if not save_as_new_version:
        migrated_count = migrate_old_version_files(
            file_id, 
            data_root, 
            current_app.logger, 
            current_app.config.get('WEBDAV_ENABLED', False)
        )
        if migrated_count > 0:
            logger.info(f"Migrated {migrated_count} old version files during save of {file_id}")
            status = "saved_with_migration"  # Special status to trigger frontend file data reload

    # Add the new path to the lookup table and get its hash
    file_hash = add_path_to_lookup(final_file_rel)
    
    return {'status': status, 'hash': file_hash}


@bp.route("/save", methods=["POST"])
@handle_api_errors
@session_required
def save():
    """
    Save the given xml as a file, with file locking.
    """
    data = request.get_json()
    xml_string = data.get("xml_string")
    file_path_or_hash = data.get("file_path") 
    save_as_new_version = data.get("new_version", False)
    session_id = get_session_id(request)

    if not xml_string or not file_path_or_hash:
        raise ApiError("XML content and file path are required.")
    
    result = _save_xml_content(xml_string, file_path_or_hash, save_as_new_version, session_id)
    return jsonify(result)


@bp.route("/create_version_from_upload", methods=["POST"])
@handle_api_errors
@session_required
def create_version_from_upload():
    """
    Creates a new version of a file from an uploaded file.
    """
    upload_dir = current_app.config["UPLOAD_DIR"]
    
    data = request.get_json()
    temp_filename = data.get("temp_filename")
    file_path_or_hash = data.get("file_path")

    if not temp_filename or not file_path_or_hash:
        raise ApiError("Missing temp_filename or file_path")

    temp_filepath = os.path.join(upload_dir, temp_filename)

    if not os.path.exists(temp_filepath):
        raise ApiError(f"Temporary file {temp_filename} not found")

    # Read XML content from uploaded file and strip XML declaration
    with open(temp_filepath, "r", encoding="utf-8") as f_in:
        xml_content = f_in.read()
        # Remove XML declaration
        xml_content = re.sub(r'<\?xml.*\?>', '', xml_content).strip()

    # Clean up temporary file
    os.remove(temp_filepath)
    
    # Use common save function to handle the XML content, always save as new version
    session_id = get_session_id(request)
    result = _save_xml_content(xml_content, file_path_or_hash, True, session_id)
    return jsonify(result)
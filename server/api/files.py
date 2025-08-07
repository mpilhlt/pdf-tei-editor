from flask import Blueprint, jsonify, request, current_app
import os
import re
from lxml import etree
from pathlib import Path
from glob import glob

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import (
    ApiError, make_timestamp, make_version_timestamp, get_data_file_path, 
    safe_file_path, remove_obsolete_marker_if_exists, get_session_id,
    get_version_path, find_collection_for_file_id,
    extract_file_id_from_version_filename, extract_version_label_from_path,
    migrate_old_version_files, construct_variant_filename
)
from server.lib.locking import (
    acquire_lock, release_lock, get_all_active_locks, check_lock
)
from server.lib.xml_utils import encode_xml_entities
from server.lib.tei_utils import serialize_tei_with_formatted_header
from server.api.config import read_config

bp = Blueprint("sync", __name__, url_prefix="/api/files")

file_types = {".pdf": "pdf", ".tei.xml": "xml", ".xml": "xml"}

@bp.route("/list", methods=["GET"])
@handle_api_errors
#@session_required
def file_list():
    data_root = current_app.config["DATA_ROOT"]
    active_locks = get_all_active_locks()
    webdav_enabled = current_app.config.get('WEBDAV_ENABLED', False)
    session_id = get_session_id(request)
    
    # Get variant filter from query parameters
    variant_filter = request.args.get('variant', None)

    files_data = create_file_data(data_root)
    for idx, data in enumerate(files_data):
        
        if webdav_enabled:
            # Add lock information to each file version
            if "versions" in data:
                for version in data["versions"]:
                    version['is_locked'] = version['path'] in active_locks and active_locks.get(version['path']) != session_id

        file_path = data.get("xml", None)
        if file_path is not None:
            metadata = get_tei_metadata(get_data_file_path(file_path))
            if metadata is None:
                metadata = {}
            # add label to metadata
            author = metadata.get('author', '')
            title = metadata.get('title', '')
            date = metadata.get('date', '')
            doi = metadata.get('doi', '')
            fileref = metadata.get('fileref', '')
            variant_id = metadata.get('variant_id', None)
            
            if author and title and date:
                label = f"{metadata.get('author', '')}, {metadata.get('title', '')[:25]}... ({metadata.get('date','')})"
            elif doi:
                label = doi
            elif fileref:
                label = fileref
            else:
                label = data['id']
                
            metadata['label'] = label
            if metadata:
                files_data[idx].update(metadata)
            
            # Add variant information to file data for filtering
            # If main file has no variant, check version files for variants
            variant_xml_path = None
            if not variant_id and 'versions' in data:
                for version in data['versions']:
                    if version.get('path'):
                        try:
                            version_metadata = get_tei_metadata(get_data_file_path(version['path']))
                            if version_metadata and version_metadata.get('variant_id'):
                                variant_id = version_metadata.get('variant_id')
                                variant_xml_path = version['path']  # Store the path to the variant file
                                break  # Use first variant found
                        except:
                            pass
            
            if variant_id:
                files_data[idx]['variant_id'] = variant_id
                # If we found the variant in a version file, use that as the main xml
                if variant_xml_path:
                    files_data[idx]['xml'] = variant_xml_path

    # Apply variant filtering if specified
    if variant_filter is not None:
        if variant_filter == "":
            # Empty string means show files with no variant (gold files)
            filtered_data = [f for f in files_data if f.get('variant_id') is None]
        else:
            # Show files with matching variant_id
            filtered_data = [f for f in files_data if f.get('variant_id') == variant_filter]
        files_data = filtered_data
        
        # Also filter versions array to only show relevant versions
        for file_data in files_data:
            if 'versions' in file_data:
                if variant_filter == "":
                    # For gold files, show versions with no variant or gold versions
                    filtered_versions = [v for v in file_data['versions'] 
                                       if not v.get('variant_id') or v.get('label') == 'Gold']
                else:
                    # For variant files, show matching variant versions and mark current xml as Gold
                    filtered_versions = []
                    current_xml_path = file_data.get('xml')
                    gold_added = False
                    
                    for v in file_data['versions']:
                        if v.get('variant_id') == variant_filter:
                            # Check if this is the current xml file (should be Gold)
                            if v.get('path') == current_xml_path and not gold_added:
                                gold_version = v.copy()
                                gold_version['label'] = 'Gold'
                                filtered_versions.insert(0, gold_version)  # Put Gold first
                                gold_added = True
                            else:
                                # Add other matching variant versions
                                filtered_versions.append(v)
                        elif v.get('path') == current_xml_path and not gold_added:
                            # Handle case where current xml doesn't have variant_id but is the main file
                            gold_version = v.copy()
                            gold_version['label'] = 'Gold'
                            filtered_versions.insert(0, gold_version)  # Put Gold first
                            gold_added = True
                    
                file_data['versions'] = filtered_versions

    return jsonify(files_data)


@bp.route("/save", methods=["POST"])
@handle_api_errors
@session_required
def save():
    """
    Save the given xml as a file, with file locking.
    """
    data = request.get_json()
    xml_string = data.get("xml_string")
    file_path_rel = data.get("file_path") 
    save_as_new_version = data.get("new_version", False)
    session_id = get_session_id(request)

    if not xml_string or not file_path_rel:
        raise ApiError("XML content and file path are required.")
    
    # encode xml entities as per configuration
    if read_config().get("xml.encode-entities.server", False) == True:
        current_app.logger.debug("Encoding XML entities")
        xml_string = encode_xml_entities(xml_string)
    
    # Extract file_id and variant from XML content and ensure file_id is stored
    try:
        # Parse XML to extract file_id and variant
        xml_root = etree.fromstring(xml_string)
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}
        
        # Try to get existing file_id from <idno type="fileref">
        fileref_elem = xml_root.find('.//tei:idno[@type="fileref"]', ns)
        
        # Extract variant from extractor application metadata
        variant = None
        extractor_apps = xml_root.xpath('.//tei:application[@type="extractor"]', namespaces=ns)
        for app in extractor_apps:
            variant_label = app.find('./tei:label[@type="variant-id"]', ns)
            if variant_label is not None and variant_label.text:
                variant = variant_label.text
                break  # Use the first variant-id found
        
        if fileref_elem is not None and fileref_elem.text:
            file_id = fileref_elem.text
            current_app.logger.debug(f"Found existing file_id in XML: {file_id}, variant: {variant}")
        else:
            # No fileref found - derive file_id from filename and add it to XML
            file_path_safe = safe_file_path(file_path_rel)
            fallback_file_id = Path(file_path_safe).stem
            
            # Handle .tei.xml files where Path.stem only removes .xml but leaves .tei
            if fallback_file_id.endswith('.tei'):
                fallback_file_id = fallback_file_id[:-4]  # Remove .tei suffix
            
            # If variant exists in XML, try to strip .variant_id suffix from filename
            if variant and fallback_file_id.endswith(f'.{variant}'):
                file_id = fallback_file_id[:-len(f'.{variant}')]
            else:
                file_id = fallback_file_id
            
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
                current_app.logger.debug(f"Added file_id to XML: {file_id}")
        
    except Exception as e:
        current_app.logger.warning(f"Could not extract metadata from XML: {e}")
        # Fallback to filename-based extraction
        file_path_safe = safe_file_path(file_path_rel)
        file_id = Path(file_path_safe).stem
        if file_id.endswith('.tei'):
            file_id = file_id[:-4]
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
                current_app.logger.info(f"Promoting version file to gold: {file_path_rel} -> tei/{collection}/{variant_filename}")
                version_to_gold_promotion = True
                promotion_collection = collection
                # Create deletion marker for the original version file location
                if current_app.config.get('WEBDAV_ENABLED', False):
                    original_full_path = get_data_file_path(file_path_rel)
                    Path(original_full_path + ".deleted").touch()
                    current_app.logger.info(f"Created deletion marker for {original_full_path}")
    
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
                current_app.logger.info(f"No existing gold variant file found at {expected_gold_variant_path}, creating as gold file")
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
    current_app.logger.info(f"Acquired lock for {lock_file_path}")
    
    # get the full path and create directories if necessary
    data_root = current_app.config["DATA_ROOT"]
    full_save_path = os.path.join(data_root, final_file_rel)
    os.makedirs(os.path.dirname(full_save_path), exist_ok=True)
    
    remove_obsolete_marker_if_exists(full_save_path, current_app.logger)
    
    # Write the file
    with open(full_save_path, "w", encoding="utf-8") as f:
        f.write(xml_string)
    current_app.logger.info(f"Saved file to {full_save_path}")

    # Migration: For regular saves, migrate any existing old version files for this file_id
    if not save_as_new_version:
        migrated_count = migrate_old_version_files(
            file_id, 
            data_root, 
            current_app.logger, 
            current_app.config.get('WEBDAV_ENABLED', False)
        )
        if migrated_count > 0:
            current_app.logger.info(f"Migrated {migrated_count} old version files during save of {file_id}")
            status = "saved_with_migration"  # Special status to trigger frontend file data reload

    return jsonify({'status': status, 'path': "/data/" + final_file_rel})


@bp.route("/delete", methods=["POST"])
@handle_api_errors      
@session_required
def delete():
    """
    Delete the given files
    """
    data_root = current_app.config["DATA_ROOT"]
    files = request.get_json()
    if not files or not isinstance(files, list): 
        raise ApiError("Files must be a list of paths")
    
    for file in files: 
        # get real file path
        file_path = os.path.join(data_root, safe_file_path(file))
        # delete the file 
        current_app.logger.info(f"Deleting file {file_path}")
        if os.path.exists(file_path):
            # delete file
            os.remove(file_path)
            
            if current_app.config['WEBDAV_ENABLED']: 
                # add a delete marker 
                Path(file_path + ".deleted").touch()
        else:
            raise ApiError(f"File {file_path} does not exist")
    return jsonify({"result": "ok"})


@bp.route("/create_version_from_upload", methods=["POST"])
@handle_api_errors
@session_required
def create_version_from_upload():
    """
    Creates a new version of a file from an uploaded file.
    """
    
    data_root = current_app.config["DATA_ROOT"]
    upload_dir = current_app.config["UPLOAD_DIR"]
    
    data = request.get_json()
    temp_filename = data.get("temp_filename")
    file_path = os.path.join(data_root, safe_file_path(data.get("file_path")))

    if not temp_filename or not file_path:
        raise ApiError("Missing temp_filename or file_path")

    temp_filepath = os.path.join(upload_dir, temp_filename)

    if not os.path.exists(temp_filepath):
        raise ApiError(f"Temporary file {temp_filename} not found")

    file_id = Path(file_path).stem
    
    # Handle .tei.xml files where Path.stem only removes .xml but leaves .tei
    if file_id.endswith('.tei'):
        file_id = file_id[:-4]  # Remove .tei suffix
    timestamp = make_version_timestamp()
    new_version_path = get_version_path(file_id, timestamp, ".xml")
    full_version_path = os.path.join(data_root, new_version_path)
    remove_obsolete_marker_if_exists(full_version_path, current_app.logger)
    os.makedirs(os.path.dirname(full_version_path), exist_ok=True)

    with open(temp_filepath, "r", encoding="utf-8") as f_in:
        xml_content = f_in.read()
        # Remove XML declaration
        xml_content = re.sub(r'<\?xml.*\?>', '', xml_content).strip()

    with open(full_version_path, "w", encoding="utf-8") as f_out:
        f_out.write(xml_content)

    os.remove(temp_filepath)

    # No migration needed for new versions - we're creating a new file
    return jsonify({"path": "/data/" + new_version_path})

@bp.route("/move", methods=["POST"])
@handle_api_errors
@session_required
def move_files():
    """
    Moves a pair of PDF and XML files to a different collection.
    """
    data = request.get_json()
    pdf_path_str = data.get("pdf_path")
    xml_path_str = data.get("xml_path")
    destination_collection = data.get("destination_collection")

    if not all([pdf_path_str, xml_path_str, destination_collection]):
        raise ApiError("Missing parameters")

    new_pdf_path = _move_file(pdf_path_str, "pdf", destination_collection)
    new_xml_path = _move_file(xml_path_str, "tei", destination_collection)

    return jsonify({
        "new_pdf_path": new_pdf_path,
        "new_xml_path": new_xml_path
    })


def _move_file(file_path_str, file_type, destination_collection):
    """
    Helper function to move a single file and create a .deleted marker.
    """
    data_root = current_app.config["DATA_ROOT"]
    
    original_path = Path(get_data_file_path(file_path_str))
    if not original_path.exists():
        raise ApiError(f"File {original_path} does not exist.")

    # Create destination directory
    new_dir = Path(data_root) / file_type / destination_collection
    os.makedirs(new_dir, exist_ok=True)

    # New path
    new_path = new_dir / original_path.name

    # Move file
    os.rename(original_path, new_path)
    current_app.logger.info(f"Moved {original_path} to {new_path}")

    # Create .deleted marker
    if current_app.config['WEBDAV_ENABLED']:
        remove_obsolete_marker_if_exists(new_path, current_app.logger)
        Path(str(original_path) + ".deleted").touch()
        current_app.logger.info(f"Created .deleted marker for {original_path}")

    return f"/data/{file_type}/{destination_collection}/{original_path.name}"

# helper functions

def create_file_data(data_root):
    """
    Creates a JSON file with a list of files in the data directory which have "pdf" and "tei.xml"
    extensions. Each file is identified by its ID, which is the filename without the suffix.
    Files in the "data/versions" directory are treated as  (temporary) versions created with 
    prompt modifications or different models 
    The JSON file contains the file ID and the corresponding PDF and XML files.
    NB: This has become quite convoluted and needs a rewrite
    """
    from flask import current_app
    file_id_data = {}
    for file_path in glob(f"{data_root}/**/*", recursive=True):
        path = Path(file_path).relative_to(data_root)
        file_type = None
        file_id = None
        
        for suffix, type in file_types.items():
            if file_path.endswith(suffix):
                file_type = type
                filename_without_suffix = path.name[:-len(suffix)]
                
                # For XML files, try to extract file_id from TEI metadata first
                if file_type == "xml":
                    try:
                        metadata = get_tei_metadata(file_path)
                        if metadata and metadata.get('fileref'):
                            file_id = metadata['fileref']
                        else:
                            file_id = None
                    except Exception as e:
                        file_id = None
                
                # Fallback to filename-based extraction if no TEI metadata or not XML
                if file_id is None:
                    is_in_versions_dir = len(path.parts) >= 3 and ("versions" in path.parts)
                    file_id, is_new_format = extract_file_id_from_version_filename(
                        filename_without_suffix, is_in_versions_dir
                    )
                    # Debug only if it's our target file
                    if 'grobid.training.segmentation' in path.as_posix():
                        if debug_log_path:
                            with open(debug_log_path, "a", encoding="utf-8") as debug_log:
                                debug_log.write(f"FALLBACK: {path} -> file_id='{file_id}'\n")
                
                break
        if file_type is None:
            continue
        
        # create entry in id-type-data map
        if file_id not in file_id_data:
            file_id_data[file_id] = {}
        if file_type not in file_id_data[file_id]:
            file_id_data[file_id][file_type] = []
        file_id_data[file_id][file_type].append(path.as_posix())

    # create the files list
    file_list = []
    # iterate over file ids
    for file_id, file_type_data in file_id_data.items():
        file_dict = {"id": file_id, "versions":[]}
        # iterate over file types
        for file_type, files in file_type_data.items():
            for file_path in files:
                path = Path(file_path)
                path_from_root = "/data/" + file_path
                # Check if this is a version file (either old or new structure)
                is_version_file = (len(path.parts) >= 3 and "versions" in path.parts)
                
                if is_version_file:
                    # Distinguish between old and new structure
                    is_new_version = path.parent.name == file_id  # New: versions/file-id/timestamp-file-id.xml
                    is_old_version = not is_new_version            # Old: versions/timestamp/file-id.xml
                    
                    #current_app.logger.debug(f"Processing version file: {file_path}, file_id={file_id}, parent={path.parent.name}, is_new={is_new_version}")
                    
                    # Extract version label using common utility function
                    fallback_label = extract_version_label_from_path(path, file_id, is_old_version)
                    label = get_version_name(get_data_file_path(path_from_root)) or fallback_label
                    
                    # Extract variant_id from version file if available
                    version_variant_id = None
                    try:
                        version_metadata = get_tei_metadata(get_data_file_path(path_from_root))
                        if version_metadata and version_metadata.get('variant_id'):
                            version_variant_id = version_metadata.get('variant_id')
                    except:
                        pass
                    
                    version_entry = {
                        'label': label,
                        'path': path_from_root
                    }
                    if version_variant_id:
                        version_entry['variant_id'] = version_variant_id
                    
                    file_dict['versions'].append(version_entry)
                else:     
                    file_dict[file_type] = path_from_root

        file_dict['versions'] = sorted(file_dict['versions'], key= lambda file: file.get('version', ''), reverse=True)
        # add original as first version if it exists
        if 'xml' in file_dict:
            file_dict['versions'].insert(0, {
                'path': file_dict['xml'],
                'label': "Gold"
            })
        
        # only add if we have both pdf and xml
        if 'pdf' in file_dict and 'xml' in file_dict:
            file_list.append(file_dict)

    # sort by id
    file_list = sorted(file_list, key=lambda file_dict: file_dict.get("id"))
    return file_list


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
    date = root.find("./tei:teiHeader//tei:date", ns)
    
    # Extract specific idno types
    doi = root.find('./tei:teiHeader//tei:idno[@type="DOI"]', ns)
    fileref = root.find('./tei:teiHeader//tei:idno[@type="fileref"]', ns)
    
    # Extract variant-id from extractor application metadata
    variant_id = None
    extractor_apps = root.xpath('.//tei:application[@type="extractor"]', namespaces=ns)
    for app in extractor_apps:
        variant_label = app.find('./tei:label[@type="variant-id"]', ns)
        if variant_label is not None:
            variant_id = variant_label.text
            break  # Use the first variant-id found
    
    return {
        "author": author.text if author is not None else "",
        "title": title.text if title is not None else "",
        "date": date.text if date is not None else "",
        "doi": doi.text if doi is not None else "",
        "fileref": fileref.text if fileref is not None else "",
        "variant_id": variant_id  # Backward compatible - None if not found
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
    
    edition_stmts = root.xpath("//tei:editionStmt", namespaces=ns)
    if edition_stmts:
        version_title_element = edition_stmts[-1].xpath("./tei:edition/tei:title", namespaces=ns)
        if version_title_element:
            return version_title_element[0].text
   
    return None


@bp.route("/check_lock", methods=["POST"])
@handle_api_errors
@session_required
def check_lock_route():
    """Checks if a single file is locked."""
    data = request.get_json()
    file_path = data.get("file_path")
    if not file_path:
        raise ApiError("File path is required.")
    session_id = get_session_id(request)
    return jsonify(check_lock(file_path, session_id))


@bp.route("/acquire_lock", methods=["POST"])
@handle_api_errors
@session_required
def acquire_lock_route():
    """Acquire a lock for this file."""
    data = request.get_json()
    file_path = data.get("file_path")
    if not file_path:
        raise ApiError("File path is required.")
    session_id = get_session_id(request)
    if acquire_lock(file_path, session_id):
        return jsonify("OK")
    # could not acquire lock
    raise ApiError(f'Could not acquire lock for {file_path}', 423)
    

@bp.route("/release_lock", methods=["POST"])
@handle_api_errors
@session_required
def release_lock_route():
    """Releases the lock for a given file path."""
    data = request.get_json()
    file_path = data.get("file_path")
    if not file_path:
        raise ApiError("File path is required.")
    session_id = get_session_id(request)
    if release_lock(file_path, session_id):
        return jsonify({"status": "lock_released"})
    else:
        raise ApiError("Failed to release lock. It may have been acquired by another session.", status_code=409)    


@bp.route("/heartbeat", methods=["POST"])
@handle_api_errors
@session_required
def heartbeat():
    """
    Refreshes the lock for a given file path.
    This acts as a heartbeat to prevent a lock from becoming stale.
    """
    data = request.get_json()
    file_path = data.get("file_path")
    if not file_path:
        raise ApiError("File path is required for heartbeat.")
    session_id = get_session_id(request)
    # The existing acquire_lock function already handles refreshing
    # a lock if it's owned by the same session.
    if acquire_lock(file_path, session_id):
        return jsonify({"status": "lock_refreshed"})
    else:
        # This would happen if the lock was lost or taken by another user.
        raise ApiError("Failed to refresh lock. It may have been acquired by another session.", status_code=409)
    
@bp.route("/locks", methods=["GET"])
@handle_api_errors
@session_required
def get_all_locks_route():  
    """Fetches all active locks."""
    active_locks = get_all_active_locks()
    return jsonify(active_locks)



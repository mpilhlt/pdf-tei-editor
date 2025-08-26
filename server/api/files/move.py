from flask import Blueprint, jsonify, request, current_app
import os
import logging
from pathlib import Path

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import (
    ApiError, get_data_file_path, remove_obsolete_marker_if_exists, resolve_document_identifier
)
from server.lib.cache_manager import mark_cache_dirty, mark_sync_needed

logger = logging.getLogger(__name__)
bp = Blueprint("files_move", __name__, url_prefix="/api/files")

@bp.route("/move", methods=["POST"])
@handle_api_errors
@session_required
def move_files():
    """
    Moves a pair of PDF and XML files to a different collection.
    """
    data = request.get_json()
    pdf_path_or_hash = data.get("pdf_path")
    xml_path_or_hash = data.get("xml_path")
    destination_collection = data.get("destination_collection")

    if not all([pdf_path_or_hash, xml_path_or_hash, destination_collection]):
        raise ApiError("Missing parameters")

    # Resolve hashes to paths if needed
    pdf_path_str = resolve_document_identifier(pdf_path_or_hash)
    xml_path_str = resolve_document_identifier(xml_path_or_hash)

    new_pdf_path = _move_file(pdf_path_str, "pdf", destination_collection)
    new_xml_path = _move_file(xml_path_str, "tei", destination_collection)

    # Mark cache as dirty since we moved files
    mark_cache_dirty()
    # Mark sync as needed since files were changed
    mark_sync_needed()

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
    logger.info(f"Moved {original_path} to {new_path}")

    # Create .deleted marker
    if current_app.config['WEBDAV_ENABLED']:
        remove_obsolete_marker_if_exists(new_path, logger)
        Path(str(original_path) + ".deleted").touch()
        logger.info(f"Created .deleted marker for {original_path}")

    return f"/data/{file_type}/{destination_collection}/{original_path.name}"
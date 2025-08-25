import os
import logging
from flask import Blueprint, request, jsonify, current_app
from pathlib import Path
from shutil import move

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import (
    ApiError, make_timestamp, remove_obsolete_marker_if_exists,
    get_version_full_path
)
from server.lib.cache_manager import mark_cache_dirty, mark_sync_needed
from server.extractors.discovery import list_extractors, create_extractor
from server.lib.debug_utils import log_extraction_response
from server.lib.server_utils import safe_file_path, resolve_document_identifier

logger = logging.getLogger(__name__)
bp = Blueprint("extract", __name__, url_prefix="/api/extract")

@bp.route("/list", methods=["GET"])
@handle_api_errors
@session_required
def list_available_extractors():
    """List all available extractors with their capabilities."""
    extractors = list_extractors(available_only=True)
    return jsonify(extractors)


@bp.route("", methods=["POST"])
@handle_api_errors
@session_required
def extract():
    """Perform extraction using the specified extractor."""
    data = request.get_json()
    
    # Get extractor ID 
    extractor_id = data.get("extractor", None)
    if extractor_id is None:
        raise ApiError("No extractor id given")
    options = data.get("options", {})
    pdf_path_or_hash = data.get("pdf")
    xml_content = data.get("xml")
    
    if not pdf_path_or_hash and not xml_content:
        raise ApiError("Either 'pdf' or 'xml' parameter is required")
    
    # Create extractor instance
    try:
        extractor = create_extractor(extractor_id)
    except KeyError:
        raise ApiError(f"Unknown extractor: {extractor_id}")
    except RuntimeError as e:
        raise ApiError(str(e))
    
    # Handle PDF file processing if provided
    pdf_path = None
    if pdf_path_or_hash:
        pdf_path = _process_uploaded_pdf(pdf_path_or_hash, options)
    
    # Perform extraction
    try:
        tei_xml = extractor.extract(pdf_path=pdf_path, xml_content=xml_content, options=options)
        
        # Log successful extraction result for debugging
        if pdf_path:
            log_extraction_response(extractor_id, pdf_path, tei_xml, ".result.xml")
        
    except Exception as e:
        logger.error(f"Extraction failed with {extractor_id}: {e}")
        
        # Log the error details with context
        error_context = {
            "extractor_id": extractor_id,
            "pdf_path": pdf_path,
            "options": options,
            "error": str(e)
        }
        
        if pdf_path:
            # Create error log with context
            import json
            error_content = json.dumps(error_context, indent=2)
            log_extraction_response(extractor_id, pdf_path, error_content, ".error.json")
        
        raise ApiError(f"Extraction failed: {e}")
    
    # Save the result if we processed a PDF
    if pdf_path_or_hash:
        result = _save_extraction_result(pdf_path, tei_xml, options)
        return jsonify(result)
    else:
        # For XML-only processing, return the result directly
        return jsonify({"xml": tei_xml})


def _process_uploaded_pdf(path_or_hash: str, options: dict) -> str:
    """Process uploaded PDF file and return the target path."""
    if not path_or_hash:
        raise ApiError("Missing PDF file name")
    
    UPLOAD_DIR = current_app.config["UPLOAD_DIR"]
    DATA_ROOT = current_app.config['DATA_ROOT']
        
    collection_name = options.get("collection")
    pdf_exists = False
    target_pdf_path = None

    pdf_path = resolve_document_identifier(path_or_hash)
    if pdf_path is not None:
        target_pdf_path = DATA_ROOT + pdf_path.removeprefix("/data")
        pdf_exists = os.path.exists(target_pdf_path)
    
    if not pdf_exists:
        # get file id from DOI or file name
        doi = options.get("doi", None)
        if doi:
            # if a DOI is given, use it
            file_id = safe_file_path(doi)
        else:
            # otherwise use filename of the upload
            file_id = Path(path_or_hash).stem
    
        target_dir = os.path.join(DATA_ROOT, "pdf")
        
        if collection_name:
            target_dir = os.path.join(target_dir, collection_name)
        
        upload_pdf_path = Path(os.path.join(UPLOAD_DIR, path_or_hash))
        target_pdf_path = Path(os.path.join(target_dir, file_id + ".pdf"))
        
        os.makedirs(target_dir, exist_ok=True)
        remove_obsolete_marker_if_exists(target_pdf_path, logger)
        
        # check for uploaded file
        if upload_pdf_path.exists():
            # rename and move PDF
            move(upload_pdf_path, target_pdf_path)
            # Mark cache as dirty since we added a new PDF file
            mark_cache_dirty()
            # Mark sync as needed since files were changed
            mark_sync_needed()
        elif not target_pdf_path.exists():
            raise ApiError(f"File {path_or_hash} has not been uploaded.")
    
    return str(target_pdf_path)


def _save_extraction_result(pdf_filename: str, tei_xml: str, options: dict) -> dict:
    """Save extraction result and return file paths."""
    collection_name = options.get("collection")
    file_id = Path(pdf_filename).stem
    
    DATA_ROOT = current_app.config['DATA_ROOT']
    
    # save xml file
    path_elems = filter(None, [DATA_ROOT, "tei", collection_name, f"{file_id}.tei.xml"])
    target_tei_path = os.path.join(*path_elems)
    final_tei_path = target_tei_path
    
    if os.path.exists(target_tei_path):
        # we already have a gold file, so save as a version, not as the original
        timestamp = make_timestamp().replace(" ", "_").replace(":", "-")
        final_tei_path = get_version_full_path(file_id, DATA_ROOT, timestamp, ".tei.xml")
    
    remove_obsolete_marker_if_exists(final_tei_path, logger)
    os.makedirs(os.path.dirname(final_tei_path), exist_ok=True)
    
    with open(final_tei_path, "w", encoding="utf-8") as f:
        f.write(tei_xml)
    
    # Mark cache as dirty since we created/modified files
    mark_cache_dirty()
    # Mark sync as needed since files were changed
    mark_sync_needed()
    
    # No migration needed - extraction creates new files or versions
    
    # return result paths
    target_pdf_path = os.path.join(DATA_ROOT, "pdf", collection_name or "", file_id + ".pdf")
    
    return {
        "id": file_id,
        "xml": Path("/data/" + os.path.relpath(final_tei_path, DATA_ROOT)).as_posix(),
        "pdf": Path("/data/" + os.path.relpath(target_pdf_path, DATA_ROOT)).as_posix(),
    }

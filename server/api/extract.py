import os
from flask import Blueprint, request, jsonify, current_app
from pathlib import Path
from shutil import move

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import (
    ApiError, make_timestamp, remove_obsolete_marker_if_exists,
    get_version_full_path
)
from server.extractors.discovery import list_extractors, create_extractor

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
    
    # Get extractor ID (default to llamore-gemini for backward compatibility)
    extractor_id = data.get("extractor", "llamore-gemini")
    options = data.get("options", {})
    
    # Handle legacy PDF filename parameter for backward compatibility
    pdf_filename = data.get("pdf")
    xml_content = data.get("xml")
    
    if not pdf_filename and not xml_content:
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
    if pdf_filename:
        pdf_path = _process_pdf_file(pdf_filename, options)
    
    # Perform extraction
    try:
        tei_xml = extractor.extract(pdf_path=pdf_path, xml_content=xml_content, options=options)
    except Exception as e:
        raise ApiError(f"Extraction failed: {e}")
    
    # Save the result if we processed a PDF
    if pdf_filename:
        result = _save_extraction_result(pdf_filename, tei_xml, options)
        return jsonify(result)
    else:
        # For XML-only processing, return the result directly
        return jsonify({"xml": tei_xml})


def _process_pdf_file(pdf_filename: str, options: dict) -> str:
    """Process uploaded PDF file and return the target path."""
    if not pdf_filename:
        raise ApiError("Missing PDF file name")
    
    collection_name = options.get("collection")
    
    # get file id from DOI or file name
    doi = options.get("doi", "")
    if doi:
        # if a (file-system-encoded) DOI is given, use it
        file_id = doi.replace("/", "__")
    else:
        # otherwise use filename of the upload
        file_id = Path(pdf_filename).stem
    
    # file paths
    UPLOAD_DIR = current_app.config["UPLOAD_DIR"]
    DATA_ROOT = current_app.config['DATA_ROOT']
    
    target_dir = os.path.join(DATA_ROOT, "pdf")
    
    if collection_name:
        target_dir = os.path.join(target_dir, collection_name)
    os.makedirs(target_dir, exist_ok=True)
    
    upload_pdf_path = Path(os.path.join(UPLOAD_DIR, pdf_filename))
    target_pdf_path = Path(os.path.join(target_dir, file_id + ".pdf"))
    remove_obsolete_marker_if_exists(target_pdf_path, current_app.logger)
    
    # check for uploaded file
    if upload_pdf_path.exists():
        # rename and move PDF
        move(upload_pdf_path, target_pdf_path)
    elif not target_pdf_path.exists():
        raise ApiError(f"File {pdf_filename} has not been uploaded.")
    
    return str(target_pdf_path)


def _save_extraction_result(pdf_filename: str, tei_xml: str, options: dict) -> dict:
    """Save extraction result and return file paths."""
    collection_name = options.get("collection")
    
    # get file id from DOI or file name
    doi = options.get("doi", "")
    if doi:
        file_id = doi.replace("/", "__")
    else:
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
    
    remove_obsolete_marker_if_exists(final_tei_path, current_app.logger)
    os.makedirs(os.path.dirname(final_tei_path), exist_ok=True)
    
    with open(final_tei_path, "w", encoding="utf-8") as f:
        f.write(tei_xml)
    
    # No migration needed - extraction creates new files or versions
    
    # return result paths
    target_pdf_path = os.path.join(DATA_ROOT, "pdf", collection_name or "", file_id + ".pdf")
    
    return {
        "id": file_id,
        "xml": Path("/data/" + os.path.relpath(final_tei_path, DATA_ROOT)).as_posix(),
        "pdf": Path("/data/" + os.path.relpath(target_pdf_path, DATA_ROOT)).as_posix(),
    }

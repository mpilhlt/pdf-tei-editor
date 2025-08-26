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
from server.lib.hash_utils import generate_hashes_for_saved_file
from server.lib.file_data import get_file_data, construct_variant_filename
from server.lib.doi_utils import doi_to_filename

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
        pdf_path = _process_pdf_reference(pdf_path_or_hash, options)
    
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


def _process_pdf_reference(filename_or_hash: str, options: dict) -> str:
    """Process PDF reference and return the absolute file path."""
    if not filename_or_hash:
        raise ApiError("Missing PDF file reference")
    
    DATA_ROOT = current_app.config['DATA_ROOT']
    UPLOAD_DIR = current_app.config["UPLOAD_DIR"]
    
    # First try to resolve as existing document identifier (hash/path)
    try:
        resolved_path = resolve_document_identifier(filename_or_hash)
        if resolved_path:
            # This is an existing file - convert to absolute path
            absolute_path = os.path.join(DATA_ROOT, safe_file_path(resolved_path))
            if os.path.exists(absolute_path):
                return absolute_path
    except ApiError:
        # Hash not found, continue to check for uploaded file
        pass
        
    # Otherwise, this is a new upload - move it to permanent location
    upload_path = Path(UPLOAD_DIR) / filename_or_hash
    if upload_path.exists():
        return _move_uploaded_pdf_to_permanent_location(upload_path, options)
    
    # File not found anywhere
    raise ApiError(f"PDF file not found: {filename_or_hash}")


def _move_uploaded_pdf_to_permanent_location(upload_path: str, options: dict) -> str:
    """Move uploaded PDF from temp directory to permanent location."""
    DATA_ROOT = current_app.config['DATA_ROOT']
    
    # Determine file ID from DOI or filename
    doi = options.get("doi")
    if doi:
        file_id = doi_to_filename(doi)
    else:
        file_id = Path(upload_path).stem
    
    # Determine target directory
    collection_name = options.get("collection")
    if collection_name and collection_name != "__inbox":
        target_dir = Path(DATA_ROOT) / "pdf" / collection_name
    else:
        target_dir = Path(DATA_ROOT) / "pdf"
    
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{file_id}.pdf"
    
    # Remove any existing deletion markers
    remove_obsolete_marker_if_exists(target_path, logger)
    
    # Move the file
    move(str(upload_path), str(target_path))
    logger.info(f"Moved uploaded PDF from {upload_path} to {target_path}")
    
    # Mark cache as dirty since we added a new PDF file
    mark_cache_dirty()
    mark_sync_needed()
    
    return str(target_path)


def _save_extraction_result(pdf_absolute_path: str, tei_xml: str, extraction_options: dict = None) -> dict:
    """Save extraction result and return file hashes."""
    extraction_options = extraction_options or {}
    DATA_ROOT = current_app.config['DATA_ROOT']
    
    # Extract file_id and collection from the PDF path
    pdf_path = Path(pdf_absolute_path)
    file_id = pdf_path.stem
    
    # Determine collection from PDF path structure
    pdf_relative_path = pdf_path.relative_to(Path(DATA_ROOT))
    if len(pdf_relative_path.parts) > 2 and pdf_relative_path.parts[0] == "pdf":
        collection_name = pdf_relative_path.parts[1]
    else:
        collection_name = None
    
    # Get variant from extraction options
    variant_id = extraction_options.get('variant_id')
    
    # Determine target TEI path using variant information
    if collection_name:
        tei_dir = Path(DATA_ROOT) / "tei" / collection_name
    else:
        tei_dir = Path(DATA_ROOT) / "tei"
    
    # Construct filename with variant if available
    variant_filename = construct_variant_filename(file_id, variant_id)
    target_tei_path = tei_dir / variant_filename
    
    final_tei_path = target_tei_path
    
    # If this specific variant file exists, save as version instead
    if target_tei_path.exists():
        timestamp = make_timestamp().replace(" ", "_").replace(":", "-")
        # Use variant-specific extension for version
        if variant_id:
            version_extension = f".{variant_id}.tei.xml"
        else:
            version_extension = ".tei.xml"
        final_tei_path = Path(get_version_full_path(file_id, DATA_ROOT, timestamp, version_extension))
        logger.info(f"Variant file exists, saving extraction result as version: {final_tei_path}")
    
    # Save the TEI file
    remove_obsolete_marker_if_exists(final_tei_path, logger)
    final_tei_path.parent.mkdir(parents=True, exist_ok=True)
    
    final_tei_path.write_text(tei_xml, encoding="utf-8")
    logger.info(f"Saved extraction result to {final_tei_path}")
    
    # Mark cache as dirty since we created/modified files
    mark_cache_dirty()
    mark_sync_needed()
    
    # Generate hashes for the files using centralized utility
    hashes = generate_hashes_for_saved_file(
        str(pdf_path), str(final_tei_path), DATA_ROOT
    )
    
    # Force cache refresh so the new file hash is immediately available
    logger.debug("Forcing cache refresh to make new extraction result available")
    get_file_data(force_refresh=True)
    
    return {
        "id": file_id,
        "xml": hashes['xml'],
        "pdf": hashes['pdf'],
    }

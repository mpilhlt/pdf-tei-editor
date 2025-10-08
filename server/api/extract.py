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

    DATA_ROOT = current_app.config['DATA_ROOT']

    # parameters
    data = request.get_json()
    extractor_id: str = data.get("extractor", '')
    options: dict = data.get("options", {})
    file_id: str = data.get("file_id", '')
    
    # validate parameters
    if not extractor_id:
        raise ApiError("No extractor id given")
    if not file_id:
        raise ApiError("file_id parameter is required")
    
    # Create extractor instance with fallback to mock when external dependencies are missing
    try:
        extractor = create_extractor(extractor_id)
    except KeyError:
        raise ApiError(f"Unknown extractor: {extractor_id}")
    except RuntimeError as e:
        # Check if this is a dependency/availability error and if we should fall back to mock
        if _should_use_mock_extractor(extractor_id, str(e)):
            logger.info(f"Using mock extractor for {extractor_id} due to missing dependencies: {e}")
            extractor = create_extractor("mock-extractor")
        else:
            raise ApiError(str(e))
    
    # Get extractor metadata to determine expected input type
    extractor_info = extractor.__class__.get_info()
    if not extractor_info.get('input') or len(extractor_info['input']) != 1:
        raise ApiError(f"Extractor {extractor_id} must specify exactly one input type")

    expected_input = extractor_info['input'][0]

    # Resolve the file_id to get file path for verification
    if file_id.endswith('.pdf'):
        # file is uploaded PDF
        resolved_path = _process_pdf_reference(file_id, options)
    else:
        # Hash-based reference - resolve and convert to absolute path
        docker_path = resolve_document_identifier(file_id)
        resolved_path = os.path.join(DATA_ROOT, safe_file_path(docker_path))

    # Verify file extension matches expected input type
    file_extension = Path(resolved_path).suffix.lower()
    if expected_input == "xml" and file_extension not in ['.xml', '.tei']:
        raise ApiError(f"Extractor {extractor_id} expects XML input, but file has extension: {file_extension}")
    elif expected_input == "pdf" and file_extension != '.pdf':
        raise ApiError(f"Extractor {extractor_id} expects PDF input, but file has extension: {file_extension}")

    # Process based on expected input type
    pdf_path = None
    xml_content = None

    if expected_input == "xml":
        # For XML-based extractors, load XML content
        from server.lib.server_utils import get_data_file_path
        xml_full_path = get_data_file_path(resolved_path)
        if not os.path.exists(xml_full_path):
            raise ApiError(f"XML file not found: {resolved_path}")

        with open(xml_full_path, 'r', encoding='utf-8') as f:
            xml_content = f.read()
    else:
        # For PDF-based extractors, process as PDF reference
        pdf_path = resolved_path

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
    
    # Save the result based on the input type
    if pdf_path and expected_input == "pdf":
        # For PDF-based extraction, save as usual (PDF + extracted XML)
        result = _save_extraction_result(pdf_path, tei_xml, options)
        return jsonify(result)
    else:
        # For XML-based extraction (like RNG schema), save as standalone XML file
        result = _save_xml_extraction_result(tei_xml, extractor_id, options)
        return jsonify(result)


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
        return _move_uploaded_pdf_to_permanent_location(str(upload_path), options)
    
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
    collection_name = options.get("collection") or "__inbox"
    target_dir = Path(DATA_ROOT) / "pdf" / collection_name
    
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


def _save_extraction_result(pdf_absolute_path: str, tei_xml: str, extraction_options: dict = {}) -> dict:
    """Save extraction result and return file hashes."""
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


def _save_xml_extraction_result(content: str, extractor_id: str, extraction_options: dict = {}) -> dict:
    """Save XML extraction result as standalone file in collection/variant structure."""
    DATA_ROOT = current_app.config['DATA_ROOT']

    # Determine collection from options (same as PDF extraction)
    collection_name = extraction_options.get("collection") or "__inbox"

    # For schema extraction, save with .rng extension (not as variant)
    # This makes schema files discoverable as a separate file type
    if extractor_id == "rng":
        # Generate a base file ID from content hash and timestamp
        import hashlib
        content_hash = hashlib.sha256(content.encode('utf-8')).hexdigest()[:8]
        timestamp = make_timestamp().replace(" ", "_").replace(":", "-")
        base_file_id = f"schema_{timestamp}_{content_hash}"
        filename = f"{base_file_id}.rng"
    else:
        # For other XML extractors, use the extractor name as variant
        variant_id = extractor_id.replace("-", "_")
        file_extension = ".xml"

        # Generate a base file ID from content hash and timestamp
        import hashlib
        content_hash = hashlib.sha256(content.encode('utf-8')).hexdigest()[:8]
        timestamp = make_timestamp().replace(" ", "_").replace(":", "-")
        base_file_id = f"schema_{timestamp}_{content_hash}"

        # Use the existing variant filename construction
        from server.lib.file_data import construct_variant_filename
        filename = construct_variant_filename(base_file_id, variant_id, file_extension)

    # Save in the tei directory under the collection (same structure as other XML files)
    target_dir = Path(DATA_ROOT) / "tei" / collection_name
    target_path = target_dir / filename

    # Remove any existing deletion markers
    remove_obsolete_marker_if_exists(target_path, logger)

    # Generate hash for the new XML file only (no PDF) BEFORE saving
    # so we can replace the placeholder
    from server.lib.hash_utils import generate_file_hash
    tei_relative_path = str(target_path.relative_to(Path(DATA_ROOT)))
    xml_hash = generate_file_hash(tei_relative_path)

    # Shorten the hash to match existing lookup table format
    from server.lib.hash_utils import load_hash_lookup
    lookup_table = load_hash_lookup()

    # Determine hash length from existing hashes (if any)
    if lookup_table:
        existing_hashes = list(lookup_table.keys())
        if existing_hashes:
            hash_length = len(existing_hashes[0])
            xml_hash = xml_hash[:hash_length]

    # Replace the placeholder in the content with the actual hash
    final_content = content.replace("{SCHEMA_HASH}", xml_hash)

    # Create directory and save file with the correct hash
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path.write_text(final_content, encoding="utf-8")
    logger.info(f"Saved {extractor_id} extraction result to {target_path}")

    # Mark cache as dirty since we created a new file
    mark_cache_dirty()
    mark_sync_needed()

    hashes = {'xml': xml_hash}

    # Force cache refresh so the new file hash is immediately available
    logger.debug("Forcing cache refresh to make new extraction result available")
    get_file_data(force_refresh=True)

    # Return result that loads only the XML file (no PDF)
    return {
        "pdf": None,
        "xml": hashes['xml'],
    }


def _should_use_mock_extractor(extractor_id: str, error_message: str) -> bool:
    """
    Determine if we should fall back to mock extractor for the given error.

    Args:
        extractor_id: The ID of the extractor that failed
        error_message: The error message from the failed extractor

    Returns:
        True if we should use mock extractor, False otherwise
    """
    # Use mock extractor when external dependencies are missing
    mock_conditions = [
        "GROBID_SERVER_URL" in error_message,
        "GEMINI_API_KEY" in error_message,
        "not available" in error_message.lower(),
        "dependencies" in error_message.lower()
    ]

    # Check environment variables for explicit mock mode
    use_mock_extractors = os.environ.get("USE_MOCK_EXTRACTORS", "").lower() in ["true", "1", "yes"]

    return use_mock_extractors or any(mock_conditions)

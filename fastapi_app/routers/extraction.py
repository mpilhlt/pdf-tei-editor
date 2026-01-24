"""
Metadata extraction router for FastAPI.

Provides endpoints for:
- Listing available extractors
- Performing PDF/XML metadata extraction

For FastAPI migration - Phase 5.
"""

from fastapi import APIRouter, HTTPException, Depends, Request
from pathlib import Path
import logging
from typing import Optional, List

from ..config import get_settings
from ..lib.models_extraction import (
    ListExtractorsResponse,
    ExtractorInfo,
    ExtractRequest,
    ExtractResponse
)
from ..lib.extraction import (
    list_extractors,
    create_extractor,
    should_use_mock_extractor
)
from ..lib.dependencies import (
    get_file_repository,
    get_file_storage,
    require_authenticated_user
)
from ..lib.file_repository import FileRepository
from ..lib.file_storage import FileStorage
from ..lib.hash_utils import get_storage_path
from ..lib.models import FileCreate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/extract", tags=["extraction"])


@router.get("/list", response_model=List[ExtractorInfo])
def list_available_extractors(
    current_user: dict = Depends(require_authenticated_user)
) -> List[ExtractorInfo]:
    """
    List all available extractors with their capabilities.

    Returns only extractors that are currently available (dependencies satisfied).

    Returns:
        List of extractor information including input/output types and availability
    """
    try:
        extractors_data = list_extractors(available_only=True)

        # Convert to Pydantic models - add 'available' field since list_extractors
        # filters by availability but doesn't include it in the dict
        extractors = [
            ExtractorInfo(**{**extractor_data, 'available': True})
            for extractor_data in extractors_data
        ]

        return extractors

    except Exception as e:
        logger.error(f"Error listing extractors: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list extractors: {str(e)}"
        )


@router.post("", response_model=ExtractResponse)
def extract_metadata(
    request: ExtractRequest,
    http_request: Request,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict = Depends(require_authenticated_user),
    settings=Depends(get_settings)
) -> ExtractResponse:
    """
    Perform metadata extraction using the specified extractor.

    Supports:
    - PDF-based extraction (e.g., Grobid, Gemini)
    - XML-based extraction (e.g., metadata refiners)

    The extracted content is saved as a new file with appropriate metadata.

    Args:
        request: Extraction request with extractor ID, file ID, and options
        repo: File repository (injected)
        storage: File storage (injected)
        current_user: Authenticated user (injected)
        settings: Application settings (injected)

    Returns:
        Response with PDF hash (if applicable) and extracted XML hash
    """
    try:
        # Create extractor instance with fallback to mock when dependencies are missing
        try:
            extractor = create_extractor(request.extractor)
        except KeyError:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown extractor: {request.extractor}"
            )
        except RuntimeError as e:
            # Check if this is a dependency/availability error and if we should fall back to mock
            if should_use_mock_extractor(request.extractor, str(e)):
                logger.info(f"Using mock extractor for {request.extractor} due to missing dependencies: {e}")
                extractor = create_extractor("mock-extractor")
            else:
                raise HTTPException(status_code=400, detail=str(e))

        # Get extractor metadata to determine expected input types
        extractor_info = extractor.__class__.get_info()
        if not extractor_info.get('input'):
            raise HTTPException(
                status_code=400,
                detail=f"Extractor {request.extractor} must specify at least one input type"
            )

        expected_inputs = extractor_info['input']

        # Resolve file_id to get file metadata
        try:
            file_metadata = repo.get_file_by_id_or_stable_id(request.file_id)
        except ValueError as e:
            raise HTTPException(
                status_code=404,
                detail=f"File not found: {request.file_id}"
            )

        if not file_metadata:
            raise HTTPException(
                status_code=404,
                detail=f"File not found: {request.file_id}"
            )

        # Verify file type matches one of the expected input types
        file_matches_input = False
        if "xml" in expected_inputs and file_metadata.file_type in ['tei', 'rng']:
            file_matches_input = True
        if "pdf" in expected_inputs and file_metadata.file_type == 'pdf':
            file_matches_input = True

        if not file_matches_input:
            expected_types_str = ", ".join(expected_inputs)
            raise HTTPException(
                status_code=400,
                detail=f"Extractor {request.extractor} expects {expected_types_str} input, but file has type: {file_metadata.file_type}"
            )

        # Get physical file path from hash-sharded storage
        # Note: files are stored in data_root/files subdirectory
        storage_root = settings.data_root / "files"
        file_path = get_storage_path(
            storage_root,
            file_metadata.id,
            file_metadata.file_type
        )

        if not file_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Physical file not found for: {request.file_id}"
            )

        # Perform extraction based on input type
        pdf_path = None
        xml_content = None

        if file_metadata.file_type in ['tei', 'rng']:
            # For XML-based extractors, load XML content
            with open(file_path, 'r', encoding='utf-8') as f:
                xml_content = f.read()
        elif file_metadata.file_type == 'pdf':
            # For PDF-based extractors, pass file path
            pdf_path = str(file_path)

        # Perform extraction
        # Pass doc_id and base_url through options so extractors can set the correct fileref and URLs
        extraction_options = {**(request.options or {})}
        extraction_options['doc_id'] = file_metadata.doc_id
        extraction_options['base_url'] = str(http_request.base_url).rstrip('/')

        try:
            tei_xml = extractor.extract(
                pdf_path=pdf_path,
                xml_content=xml_content,
                options=extraction_options
            )

            logger.debug(f"Extraction completed with {request.extractor}, result length: {len(tei_xml)}")

        except Exception as e:
            logger.error(f"Extraction failed with {request.extractor}: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Extraction failed: {str(e)}"
            )

        # Save the extraction result
        if pdf_path and file_metadata.file_type == 'pdf':
            # For PDF-based extraction, save as associated TEI file
            result = _save_pdf_extraction_result(
                file_metadata,
                tei_xml,
                extraction_options,
                repo,
                storage,
                current_user
            )
            return ExtractResponse(
                id=file_metadata.doc_id,
                pdf=result['pdf'],
                xml=result['xml']
            )
        else:
            # For XML-based extraction, save as standalone file
            result = _save_xml_extraction_result(
                tei_xml,
                request.extractor,
                request.options,
                repo,
                storage,
                username=current_user.get('username') if current_user else None
            )
            return ExtractResponse(
                id=None,
                pdf=None,
                xml=result['xml']
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error during extraction: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Extraction failed: {str(e)}"
        )


def _save_pdf_extraction_result(
    pdf_metadata,
    tei_xml: str,
    options: dict,
    repo: FileRepository,
    storage: FileStorage,
    current_user: dict = None
) -> dict:
    """
    Save PDF extraction result as associated TEI file.

    Args:
        pdf_metadata: Metadata of the PDF file
        tei_xml: Extracted TEI XML content
        options: Extraction options (may include variant_id)
        repo: File repository
        storage: File storage

    Returns:
        Dict with 'pdf' and 'xml' hashes
    """
    from lxml import etree
    from ..lib.tei_utils import extract_tei_metadata

    # Determine variant from options
    variant = options.get('variant_id')

    # Save TEI file to storage
    tei_bytes = tei_xml.encode('utf-8')
    tei_hash, tei_path = storage.save_file(tei_bytes, 'tei')

    # Get collection from options (user-selected in extraction dialog)
    # Default to "_inbox" if not specified
    selected_collection = options.get('collection', '_inbox')
    doc_collections = [selected_collection]

    # Parse TEI to extract metadata
    label = None
    tei_metadata = None
    try:
        tei_root = etree.fromstring(tei_bytes)
        tei_metadata = extract_tei_metadata(tei_root)
        # Use edition_title as label if available
        label = tei_metadata.get('edition_title')
    except Exception as e:
        logger.warning(f"Failed to parse TEI metadata for label: {e}")

    # Check if file with this hash already exists (e.g., re-running same extraction)
    existing_file = repo.get_file_by_id(tei_hash)
    if existing_file:
        logger.info(f"TEI file already exists with hash {tei_hash[:8]}..., returning existing stable_id: {existing_file.stable_id}")
        # Still update PDF metadata if we have new metadata
        inserted_file = existing_file
    else:
        # Create file metadata record
        file_create = FileCreate(
            id=tei_hash,
            stable_id=None,  # Will be auto-generated
            filename=f"{pdf_metadata.doc_id}-extracted.xml",
            doc_id=pdf_metadata.doc_id,
            file_type='tei',
            file_size=len(tei_bytes),
            doc_collections=doc_collections,
            doc_metadata={},  # TEI files don't store doc metadata
            variant=variant,
            version=1,  # Extractions are versioned artifacts
            is_gold_standard=False,  # Extractions are not gold standard
            label=label,
            file_metadata={'extractor': options.get('extractor', 'unknown')},
            created_by=current_user.get('username') if current_user else None
        )

        # Insert into database
        inserted_file = repo.insert_file(file_create)

    # Update PDF metadata from extracted TEI
    if tei_metadata:
        from ..lib.tei_utils import update_pdf_metadata_from_tei
        update_pdf_metadata_from_tei(
            pdf_metadata,
            tei_metadata,
            repo,
            logger,
            doc_collections=doc_collections
        )

    logger.info(f"Saved extraction result: {tei_hash[:8]}... (doc_id={pdf_metadata.doc_id}, variant={variant}, label={label})")

    return {
        'pdf': pdf_metadata.stable_id,
        'xml': inserted_file.stable_id
    }


def _save_xml_extraction_result(
    content: str,
    extractor_id: str,
    options: dict,
    repo: FileRepository,
    storage: FileStorage,
    username: str = None
) -> dict:
    """
    Save XML extraction result as standalone file.

    Args:
        content: Extracted XML content
        extractor_id: ID of the extractor used
        options: Extraction options (must include 'variant_id' for RNG)
        repo: File repository
        storage: File storage

    Returns:
        Dict with 'xml': stable_id
    """
    import hashlib
    from datetime import datetime

    # Determine file type from extractor
    file_type = 'tei'
    default_label = extractor_id

    # For XML extractions, generate doc_id from timestamp and hash
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    content_bytes = content.encode('utf-8')
    content_hash = hashlib.sha256(content_bytes).hexdigest()[:8]
    doc_id = f"{extractor_id}_{timestamp}_{content_hash}"

    # Save file to storage
    content_bytes = content.encode('utf-8')
    file_hash, _ = storage.save_file(content_bytes, file_type)

    # Get collection from options
    collection = options.get('collection', '_inbox')

    # Check if file with this hash already exists (same content)
    try:
        existing_hash_file = repo.get_file_by_id(file_hash)
        if existing_hash_file:
            logger.info(f"File with hash {file_hash[:8]}... already exists, returning stable_id: {existing_hash_file.stable_id}")
            return {'xml': existing_hash_file.stable_id}
    except ValueError:
        pass  # Hash doesn't exist, continue

    # Use file_type as variant to enable filtering
    file_variant = file_type if file_type != 'tei' else None

    file_create = FileCreate(
        id=file_hash,
        stable_id=None,  # Will be auto-generated
        filename=f"{doc_id}.{file_type}.xml",
        doc_id=doc_id,
        file_type=file_type,
        file_size=len(content_bytes),
        doc_collections=[collection],
        doc_metadata={},
        variant=file_variant,
        version=1,  # Extractions are versioned artifacts
        is_gold_standard=False,  # Extractions are not gold standard
        label=default_label,
        file_metadata={'extractor': extractor_id},
        created_by=username
    )

    # Insert into database
    inserted_file = repo.insert_file(file_create)

    logger.info(f"Saved {extractor_id} extraction result: {file_hash[:8]}... (doc_id={doc_id})")

    return {
        'xml': inserted_file.stable_id
    }

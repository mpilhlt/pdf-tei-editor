"""
Metadata extraction router for FastAPI.

Provides endpoints for:
- Listing available extractors
- Performing PDF/XML metadata extraction

For FastAPI migration - Phase 5.
"""

from fastapi import APIRouter, HTTPException, Depends
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
from ..lib.extractor_manager import (
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
    - RNG schema generation from XML

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
        try:
            tei_xml = extractor.extract(
                pdf_path=pdf_path,
                xml_content=xml_content,
                options=request.options
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
                request.options,
                repo,
                storage
            )
            return ExtractResponse(
                id=file_metadata.doc_id,
                pdf=result['pdf'],
                xml=result['xml']
            )
        else:
            # For XML-based extraction (like RNG schema), save as standalone file
            result = _save_xml_extraction_result(
                tei_xml,
                request.extractor,
                request.options,
                repo,
                storage
            )
            return ExtractResponse(
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
    storage: FileStorage
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
    # Determine variant from options
    variant = options.get('variant_id')

    # Save TEI file to storage
    tei_bytes = tei_xml.encode('utf-8')
    tei_hash, tei_path = storage.save_file(tei_bytes, 'tei')

    # Get collections from PDF metadata
    doc_collections = pdf_metadata.doc_collections or []

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
        version=1,  # First version
        is_gold_standard=False,
        label=None,
        file_metadata={'extractor': options.get('extractor', 'unknown')},
        sync_status='modified',
        sync_version=0
    )

    # Insert into database
    inserted_file = repo.insert_file(file_create)

    logger.info(f"Saved extraction result: {tei_hash[:8]}... (doc_id={pdf_metadata.doc_id}, variant={variant})")

    return {
        'pdf': pdf_metadata.id,
        'xml': tei_hash
    }


def _save_xml_extraction_result(
    content: str,
    extractor_id: str,
    options: dict,
    repo: FileRepository,
    storage: FileStorage
) -> dict:
    """
    Save XML extraction result as standalone file.

    Used for schema extraction or XML-to-XML transformations.

    Args:
        content: Extracted XML content
        extractor_id: ID of the extractor used
        options: Extraction options (may include collection)
        repo: File repository
        storage: File storage

    Returns:
        Dict with 'xml' hash
    """
    import hashlib
    from datetime import datetime

    # Determine file type from extractor
    if extractor_id == "rng":
        file_type = 'rng'
    else:
        file_type = 'tei'

    # Save file to storage
    content_bytes = content.encode('utf-8')
    file_hash, file_path = storage.save_file(content_bytes, file_type)

    # For standalone files, generate a doc_id from content hash and timestamp
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    content_hash = hashlib.sha256(content_bytes).hexdigest()[:8]
    doc_id = f"{extractor_id}_{timestamp}_{content_hash}"

    # Get collection from options
    collection = options.get('collection', '__inbox')

    # Create file metadata record
    file_create = FileCreate(
        id=file_hash,
        stable_id=None,  # Will be auto-generated
        filename=f"{doc_id}.{file_type}.xml",
        doc_id=doc_id,
        file_type=file_type,
        file_size=len(content_bytes),
        doc_collections=[collection],
        doc_metadata={},  # Must be dict, not None
        variant=None,
        version=1,
        is_gold_standard=False,
        label=extractor_id,
        file_metadata={'extractor': extractor_id}
    )

    # Insert into database
    inserted_file = repo.insert_file(file_create)

    logger.info(f"Saved {extractor_id} extraction result: {file_hash[:8]}... (doc_id={doc_id})")

    return {
        'xml': file_hash
    }

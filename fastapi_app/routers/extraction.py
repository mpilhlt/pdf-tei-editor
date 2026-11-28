"""
Metadata extraction router for FastAPI.

Provides endpoints for:
- Listing available extractors
- Checking whether an extractor can run now
- Performing PDF/XML metadata extraction, synchronously or as a job (type `extract`, see
  `fastapi_app/lib/extraction/job_types.py`); the run is in `fastapi_app/lib/extraction/run.py`

For FastAPI migration - Phase 5.
"""

from fastapi import APIRouter, HTTPException, Depends, Request
import logging
from typing import Any, List

from fastapi_jobqueue import Job, JobManager

from ..config import get_settings
from ..lib.models.models_extraction import (
    ListExtractorsResponse,
    ExtractorInfo,
    ExtractRequest,
    ExtractResponse,
    ExtractJobRequest,
    ExtractorCheckRequest,
    ExtractorCheckResponse,
)
from ..lib.extraction import (
    list_extractors,
    create_extractor,
    should_use_mock_extractor
)
from ..lib.core.dependencies import (
    get_file_repository,
    get_file_storage,
    require_authenticated_user
)
from ..lib.extraction.job_types import ExtractJobParams, check_inference_key, checked_ocr_params, submit_extract_job
from ..lib.extraction.run import _note_text_layer_provenance, _run_extraction, _validate_extraction  # noqa: F401 (_note_text_layer_provenance: imported by tests)
from ..lib.jobs import get_job_manager
from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage

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


@router.post("/check", response_model=ExtractorCheckResponse)
async def check_extractor(
    request: ExtractorCheckRequest,
    current_user: dict = Depends(require_authenticated_user),
) -> ExtractorCheckResponse:
    """
    Check whether an extractor can run now, e.g. whether the service it uses is reachable.

    Clients call this before steps that take long, such as text recognition of the PDF, so that
    an extraction that would fail is not prepared in vain. Extractors without a check (see
    `BaseExtractor.check_ready()`) are reported as ready, as are extractors that the
    extraction would replace with the mock extractor.
    """
    try:
        extractor = create_extractor(request.extractor)
    except KeyError:
        raise HTTPException(status_code=400, detail=f"Unknown extractor: {request.extractor}")
    except RuntimeError as e:
        if should_use_mock_extractor(e):
            return ExtractorCheckResponse(ready=True, message=None)
        return ExtractorCheckResponse(ready=False, message=str(e))
    try:
        message = await extractor.check_ready(request.options)
    except Exception as e:
        logger.warning(f"Readiness check of extractor {request.extractor} failed: {e}")
        message = f"The readiness check failed: {e}"
    if message:
        logger.info(f"Extractor {request.extractor} is not ready: {message}")
    return ExtractorCheckResponse(ready=not message, message=message or None)


@router.post("", response_model=ExtractResponse)
async def extract_metadata(
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

    The extracted content is saved as a new file with appropriate metadata. The UI runs
    extractions as jobs instead (`POST /api/v1/extract/job`).

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
        validated = _validate_extraction(request, repo, current_user)
        return await _run_extraction(validated, request, repo, storage, current_user, settings, None, base_url=str(http_request.base_url).rstrip('/'))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error during extraction: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Extraction failed: {str(e)}"
        )


@router.post("/job", response_model=Job, status_code=202)
async def submit_extraction_job(
    request: ExtractJobRequest,
    http_request: Request,
    repo: FileRepository = Depends(get_file_repository),
    manager: JobManager = Depends(get_job_manager),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> Job:
    """
    Submit a job (type `extract`) that runs the extraction of `POST /api/v1/extract`; its result
    is an `ExtractJobResult` (the `ExtractResponse`, with the result of text recognition if it ran).

    An extraction can take longer than a reverse proxy waits for a response, so the UI runs it as
    a job, whose status, progress and result the job API reports (`GET /api/v1/jobs/{job_id}`, the
    job events) and which it cancels (`POST /api/v1/jobs/{job_id}/cancel`). Invalid requests are
    rejected at once, with the errors of `POST /api/v1/extract` (400, 404) and, for `ocr`, those
    of `POST /api/v1/ocr`.

    With `ocr`, if the extractor extracts from the PDF, text recognition is applied to it first
    and the extraction extracts from the new PDF. Cancelling during text recognition leaves the
    PDF unchanged; cancelling later keeps the new PDF and extracts nothing (`cancelled` in the
    result).

    The job holds the lock of the source PDF, so a request for a PDF that another job (or a user)
    holds is rejected with 409. For an extractor that runs on an LLM, a provider that needs an API
    key the user has not stored is answered with 428 (`secret_required`) before the job starts; a
    key found missing during the run fails the job with status 428.
    """
    validated = _validate_extraction(request, repo, current_user)
    check_inference_key(validated, request, current_user)
    ocr = checked_ocr_params(request, validated, repo, current_user)
    params = ExtractJobParams(
        extractor=request.extractor,
        file_id=request.file_id,
        options=request.options,
        ocr=ocr,
        base_url=str(http_request.base_url).rstrip('/'),
    )
    return await submit_extract_job(manager, params, validated, current_user)


"""
OCR API router.

Endpoints:
- GET  /api/v1/ocr/engines                  - List available OCR engines
- GET  /api/v1/ocr/text-quality/{stable_id} - Assess the text layer of a PDF
- POST /api/v1/ocr                          - Start applying OCR to a PDF, replacing its content
- GET  /api/v1/ocr/jobs/{job_id}            - Status and result of an OCR run
- POST /api/v1/ocr/text-corrections/preview - What writing a TEI's text corrections into the PDF would do
- POST /api/v1/ocr/text-corrections/apply   - Write a TEI's text corrections into the PDF's OCR text layer
- POST /api/v1/ocr/llm-review/plan          - Number of page windows of the LLM review of OCR errors
- POST /api/v1/ocr/llm-review               - LLM review of one page window for OCR errors
"""

import asyncio
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Callable
from typing import Any

import pikepdf
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from lxml import etree
from pypdf.errors import PdfReadError

from ..config import get_settings
from ..lib.core.dependencies import get_file_repository, get_file_storage, get_session_manager, get_sse_service, require_authenticated_user, require_reviewer_or_admin, require_session_id
from ..lib.core.locking import check_lock
from ..lib.core.sessions import SessionManager
from ..lib.models import FileMetadata, FileUpdate
from ..lib.models.models_ocr import (
    OcrEngineInfo,
    OcrJob,
    OcrLlmCorrection,
    OcrOptionInfo,
    OcrProgress,
    OcrLlmCorrectionRequest,
    OcrRequest,
    OcrResponse,
    OcrReviewFinding,
    OcrReviewPlanRequest,
    OcrReviewPlanResponse,
    OcrReviewRequest,
    OcrReviewResponse,
    TextCorrectionItem,
    TextCorrectionsPreview,
    TextCorrectionsRequest,
    TextCorrectionsResult,
    TextQualityReport,
    UnwritableItem,
)
from ..lib.llm import LLMProvider, LLMProviderRegistry
from ..lib.llm.http_errors import llm_http_error
from ..lib.llm.model_access import check_model_access
from ..lib.ocr.base import OcrEngine, OcrOptionValue, OcrResult
from ..lib.ocr.jobs import ACTIVE_STATUSES, OcrJobConflict, OcrJobStore
from ..lib.ocr.languages import normalize_ocr_language
from ..lib.ocr import llm_correction
from ..lib.ocr.layout_check import apply_layout_check, check_text_layout
from ..lib.ocr.llm_review import DEFAULT_MIN_LETTER_SIMILARITY, MIN_LETTER_SIMILARITY_KEY, MissingLayoutError, OcrReviewSource, prepare_source, review_window
from ..lib.ocr.provenance import OCR_METADATA_KEY, TEXT_CORRECTIONS_METADATA_KEY
from ..lib.ocr.progress import OcrCancelled, ProgressCallback, progress_reporter
from ..lib.ocr.registry import OcrEngineRegistry
from ..lib.ocr.text_corrections import CorrectedPdfHandler, CorrectedPdfMismatch, CorrectionPlan, WordCorrection, derive_corrections, get_corrected_pdf_handler, tei_words
from ..lib.ocr.text_layer import PageCallback, WordPatch, patch_text_layer, read_text_layer
from ..lib.ocr.text_quality import analyze_text_layer
from ..lib.permissions.access_control import check_file_access
from ..lib.repository.file_repository import FileRepository
from ..lib.secrets import MissingSecretError, secret_required_detail
from ..lib.services.tei_versions import create_tei_version, version_collections
from ..lib.sse.sse_service import SSEService
from ..lib.sse.sse_utils import ProgressBar
from ..lib.storage.file_storage import FileStorage
from ..lib.tei.zone_lines import window_range
from ..lib.tei.layout import MISSING_LAYOUT_MESSAGE, LineLayout, get_line_layout
from ..lib.utils.config_utils import get_config
from ..lib.utils.revision_hash import stamp_revision_hashes
from ..lib.utils.tei_utils import add_revision_change, extract_processing_instructions, extract_tei_metadata, serialize_tei_with_formatted_header, update_fileref_in_xml
from ..lib.utils.xml_utils import apply_entity_encoding_from_config
from ..lib.utils.logging_utils import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/ocr", tags=["ocr"])

# OCR_METADATA_KEY: the last OCR run of a PDF; TEXT_CORRECTIONS_METADATA_KEY: the text corrections
# written into it (keys of the PDF's file_metadata, see lib/ocr/provenance.py)

PROGRESS_WRITE_INTERVAL_SECONDS = 1.0

PAGE_PROGRESS_INTERVAL_SECONDS = 0.2
"""Least time between two page reports of the text corrections to the client."""
"""Least time between two progress updates of a job within the same phase."""

_running_jobs: set["asyncio.Task[None]"] = set()
"""References to the running job tasks, which asyncio would otherwise garbage-collect."""


def get_ocr_job_store() -> OcrJobStore:
    """Return the store of OCR jobs, shared by all worker processes."""
    return OcrJobStore(get_settings().tmp_dir / "ocr-jobs")


def _engine_info(engine: OcrEngine) -> OcrEngineInfo:
    """Build the API description of an engine."""
    return OcrEngineInfo(
        id=engine.id,
        name=engine.name,
        description=engine.description,
        languages=engine.get_languages(),
        default_languages=engine.get_default_languages(),
        options={key: OcrOptionInfo.model_validate(option) for key, option in engine.get_options().items()},
    )


def _get_pdf(repo: FileRepository, stable_id: str, user: dict[str, Any], operation: str) -> FileMetadata:
    """
    Look up a PDF by stable_id and check the user's access.

    Raises:
        HTTPException: 404 if there is no such PDF, 403 if access is denied
    """
    file = repo.get_file_by_stable_id(stable_id)
    if file is None or file.file_type != "pdf":
        raise HTTPException(status_code=404, detail=f"PDF not found: {stable_id}")
    if not check_file_access(file, user, operation):
        raise HTTPException(status_code=403, detail="Access denied")
    return file


def _pdf_path(storage: FileStorage, file: FileMetadata) -> Path:
    """Return the storage path of a PDF, raising 404 if the file is missing."""
    path = storage.get_file_path(file.id, "pdf")
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail=f"PDF content not found: {file.stable_id}")
    return path


def _validate_options(engine: OcrEngine, options: dict[str, OcrOptionValue]) -> dict[str, OcrOptionValue]:
    """
    Check option values against the engine's parameter descriptions and fill in defaults.

    Raises:
        HTTPException: 400 for unknown parameters or invalid values
    """
    specs = engine.get_options()
    unknown = set(options) - set(specs)
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown OCR options: {', '.join(sorted(unknown))}")
    validated: dict[str, OcrOptionValue] = {}
    for key, spec in specs.items():
        value = options.get(key, spec.get("default"))
        if value is None:
            continue
        expected = spec["type"]
        if expected == "boolean" and not isinstance(value, bool):
            raise HTTPException(status_code=400, detail=f"OCR option '{key}' must be a boolean")
        if expected == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
            raise HTTPException(status_code=400, detail=f"OCR option '{key}' must be an integer")
        if expected == "string":
            if not isinstance(value, str):
                raise HTTPException(status_code=400, detail=f"OCR option '{key}' must be a string")
            allowed = spec.get("options")
            if allowed and value not in allowed:
                raise HTTPException(status_code=400, detail=f"OCR option '{key}' must be one of: {', '.join(allowed)}")
        validated[key] = value
    return validated


def _validate_languages(engine: OcrEngine, languages: list[str]) -> list[str]:
    """
    Normalize the requested languages and check that the engine supports them.

    Raises:
        HTTPException: 400 for invalid or unsupported languages
    """
    if not languages:
        return engine.get_default_languages()
    supported = set(engine.get_languages())
    normalized: list[str] = []
    for language in languages:
        code = normalize_ocr_language(language)
        if code is None:
            raise HTTPException(status_code=400, detail=f"Invalid language code: {language}")
        if code not in supported:
            raise HTTPException(status_code=400, detail=f"Language '{code}' is not supported by {engine.name}")
        if code not in normalized:
            normalized.append(code)
    return normalized


def _word_recognition_engine() -> OcrEngine | None:
    """Return the first available engine that can recognize words on page images."""
    for engine in OcrEngineRegistry.get_instance().list_engines():
        if engine.supports_word_recognition():
            return engine
    return None


def _analyze(path: Path, layout: bool) -> TextQualityReport:
    """
    Analyze the text layer, and if requested and the character checks found no problems,
    compare it with the words recognized on sample page images.
    """
    report = analyze_text_layer(path)
    if not layout or report.status != "good":
        return report
    engine = _word_recognition_engine()
    if engine is None:
        logger.debug("No OCR engine supports word recognition, skipping the layout check")
        return report
    supported = engine.get_languages()
    language = normalize_ocr_language(report.language) if report.language else None
    languages = [language] if language in supported else engine.get_default_languages()
    try:
        result = check_text_layout(path, lambda image: engine.recognize_words(image, languages))
    except Exception as e:
        logger.warning(f"Layout check with {engine.id} failed: {e}")
        return report
    return apply_layout_check(report, result)


def _llm_provider(provider_id: str, user: dict[str, Any]) -> LLMProvider:
    """
    The LLM provider for the user.

    Raises:
        HTTPException: 404 for an unknown provider, 428 if the provider needs a secret of the user
    """
    try:
        return LLMProviderRegistry.get_instance().get_provider_for_user(provider_id, user["username"])
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except MissingSecretError as e:
        raise HTTPException(status_code=428, detail=secret_required_detail(e)) from e


def _check_llm_model(provider: LLMProvider, provider_id: str, model_id: str, user: dict[str, Any]) -> None:
    """
    Check that the user may use the model (may list the provider's models).

    Raises:
        HTTPException: 403 if the user may not use the model, 5xx if the provider fails
    """
    try:
        check_model_access(provider, model_id, user)
    except Exception as e:
        http_error = llm_http_error(e, provider_id)
        if http_error is None:
            raise
        raise http_error from e


@router.get("/engines", response_model=list[OcrEngineInfo])
def list_ocr_engines(
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> list[OcrEngineInfo]:
    """List the available OCR engines with their languages and parameters."""
    return [_engine_info(engine) for engine in OcrEngineRegistry.get_instance().list_engines()]


@router.get("/text-quality/{stable_id}", response_model=TextQualityReport)
async def get_text_quality(
    stable_id: str,
    layout: bool = Query(False, description="Also compare the text layer with the words recognized on sample page images (takes a few seconds)"),
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> TextQualityReport:
    """
    Assess the quality of the text layer of a PDF.

    Reports whether the text layer is missing or of poor quality (garbled characters, implausible
    words, text that does not read as natural language), and the language detected in it. With
    `layout=true`, a text layer without such problems is also compared with the words an OCR
    engine recognizes on sample pages, which finds fragmented, misplaced or misordered text.
    """
    file = _get_pdf(repo, stable_id, current_user, "read")
    path = _pdf_path(storage, file)
    try:
        report = await asyncio.to_thread(_analyze, path, layout)
    except PdfReadError as e:
        raise HTTPException(status_code=422, detail=f"The PDF cannot be read: {e}")
    report.ocr_applied = file.file_metadata.get(OCR_METADATA_KEY)
    return report


@router.post("", response_model=OcrJob, status_code=202)
async def apply_ocr(
    request: OcrRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    jobs: OcrJobStore = Depends(get_ocr_job_store),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> OcrJob:
    """
    Start applying OCR to a PDF; the stored PDF is replaced with the result.

    OCR of a long document can take longer than a reverse proxy waits for a response, so the run
    happens in the background: the response is the job, and `GET /api/v1/ocr/jobs/{job_id}`
    reports its status and, when it is done, the result. Invalid requests are rejected at once.

    Only one OCR run happens at a time on the server; the job has the status 'queued' while it
    waits for other runs. A request for a PDF that already has a queued or running job is rejected
    with 409.

    The stable_id of the PDF stays the same; its content hash changes. The OCR run, including the
    method the engine used, is recorded in the PDF's file metadata under "ocr".

    With `llm_correction`, an LLM corrects OCR errors of the new text layer before the PDF is
    stored; the corrections are recorded under "text_corrections". The provider and the model are
    checked before the run: 404 for an unknown provider, 428 if the provider needs a secret of the
    user, 403 if the user may not use the model. A failure of the correction pass keeps the OCR
    result and is reported in `llm_correction_error`.
    """
    file = _get_pdf(repo, request.stable_id, current_user, "edit")
    try:
        engine = OcrEngineRegistry.get_instance().get_engine(request.engine)
    except KeyError:
        raise HTTPException(status_code=400, detail=f"Unknown OCR engine: {request.engine}")
    if not engine.is_available():
        raise HTTPException(status_code=400, detail=f"OCR engine '{engine.name}' is not available")
    languages = _validate_languages(engine, request.languages)
    options = _validate_options(engine, request.options)
    _pdf_path(storage, file)
    llm: _LlmCorrection | None = None
    if request.llm_correction and request.provider_id and request.model_id:
        provider = _llm_provider(request.provider_id, current_user)
        _check_llm_model(provider, request.provider_id, request.model_id, current_user)
        llm = _LlmCorrection(provider, request.provider_id, request.model_id)

    try:
        job = jobs.create(file.stable_id, str(current_user.get("username") or ""))
    except OcrJobConflict as e:
        raise HTTPException(status_code=409, detail=f"{e}. Please wait until it is finished.")
    task = asyncio.create_task(_run_job(job, jobs, engine, languages, options, request.rebuild, repo, storage, current_user, llm))
    _running_jobs.add(task)
    task.add_done_callback(_running_jobs.discard)
    return job


@router.post("/llm-correction", response_model=OcrJob, status_code=202)
async def correct_ocr_errors(
    request: OcrLlmCorrectionRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    jobs: OcrJobStore = Depends(get_ocr_job_store),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> OcrJob:
    """
    Start correcting the OCR errors of the text layer of a stored PDF with an LLM, e.g. after the
    correction pass of an OCR run was cancelled. This is the correction pass of `POST /api/v1/ocr`
    without the text recognition: the same pages are reviewed and the corrections are written into
    the text layer and recorded under "text_corrections".

    The run is a job like an OCR run: poll `GET /api/v1/ocr/jobs/{job_id}`, cancel it with
    `POST /api/v1/ocr/jobs/{job_id}/cancel` (the PDF then stays unchanged), and only one run happens
    at a time on the server. A PDF with a queued or running job is rejected with 409. The provider
    and the model are checked first: 404 for an unknown provider, 428 if the provider needs a secret
    of the user, 403 if the user may not use the model. A failure of the pass is reported in
    `llm_correction_error` of the result.
    """
    file = _get_pdf(repo, request.stable_id, current_user, "edit")
    _pdf_path(storage, file)
    provider = _llm_provider(request.provider_id, current_user)
    _check_llm_model(provider, request.provider_id, request.model_id, current_user)
    llm = _LlmCorrection(provider, request.provider_id, request.model_id)
    try:
        job = jobs.create(file.stable_id, str(current_user.get("username") or ""))
    except OcrJobConflict as e:
        raise HTTPException(status_code=409, detail=f"{e}. Please wait until it is finished.")
    task = asyncio.create_task(_run_correction_job(job, jobs, request.languages, repo, storage, current_user, llm))
    _running_jobs.add(task)
    task.add_done_callback(_running_jobs.discard)
    return job


@router.get("/jobs/{job_id}", response_model=OcrJob)
def get_ocr_job(
    job_id: str,
    jobs: OcrJobStore = Depends(get_ocr_job_store),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> OcrJob:
    """
    Return the status of an OCR run started with `POST /api/v1/ocr`, and its result when it is done.

    A failed run has the error message in 'error' and the corresponding HTTP status code in
    'error_status'. Jobs are kept for a day.
    """
    job = jobs.get(job_id)
    if job is None or job.username != str(current_user.get("username") or ""):
        raise HTTPException(status_code=404, detail=f"OCR job not found: {job_id}")
    return job


@router.post("/jobs/{job_id}/cancel", response_model=OcrJob)
def cancel_ocr_job(
    job_id: str,
    jobs: OcrJobStore = Depends(get_ocr_job_store),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> OcrJob:
    """
    Cancel an OCR run started with `POST /api/v1/ocr`. The stored PDF stays unchanged.

    A queued job stops at once. A running job stops at the next progress report of the engine or
    of the LLM correction pass, or, if the engine does not report progress, when the engine is
    finished; its result is then discarded. Until then, the job keeps its status: poll
    `GET /api/v1/ocr/jobs/{job_id}` until it is 'cancelled'. A finished job is returned as it is.
    """
    job = jobs.get(job_id)
    if job is None or job.username != str(current_user.get("username") or ""):
        raise HTTPException(status_code=404, detail=f"OCR job not found: {job_id}")
    if job.status in ACTIVE_STATUSES:
        logger.info(f"Cancelling OCR job {job.job_id} for {job.stable_id}")
        jobs.request_cancel(job)
    return job


@dataclass
class _LlmCorrection:
    """The checked provider and model of the LLM correction pass of an OCR run."""

    provider: LLMProvider
    provider_id: str
    model_id: str


async def _correct_with_llm(output_path: Path, llm: _LlmCorrection, languages: list[str]) -> llm_correction.CorrectionRun:
    """Run the LLM correction pass on the OCR output in place; never raises, so that OCR cannot fail because of it."""
    config = get_config()
    min_similarity = float(config.get(llm_correction.MIN_LETTER_SIMILARITY_KEY, llm_correction.DEFAULT_MIN_LETTER_SIMILARITY))
    max_pages = int(config.get(llm_correction.MAX_PAGES_KEY, llm_correction.DEFAULT_MAX_PAGES))
    try:
        return await llm_correction.correct_text_layer(output_path, llm.provider, llm.model_id, languages, min_similarity, max_pages)
    except Exception as e:  # noqa: BLE001 - the OCR result is kept
        logger.exception(f"LLM correction with {llm.provider_id}/{llm.model_id} failed")
        return llm_correction.CorrectionRun(corrections=[], pages_reviewed=[], skipped=0, error=str(e))


def _pages(count: int) -> str:
    return f"{count} {'page' if count == 1 else 'pages'}"


def _llm_correction_message(run: llm_correction.CorrectionRun, model_id: str) -> str:
    """The sentences about the LLM correction pass appended to the message of the OCR run."""
    count = len(run.corrections)
    corrected = f"Corrected {count} OCR {'error' if count == 1 else 'errors'} with {model_id}."
    if run.error:
        message = (corrected + " " if count else "") + f"The LLM correction failed: {run.error}"
    elif count:
        message = corrected
    elif not run.pages_selected:
        message = "No pages needed correction."
    elif not run.pages_reviewed:
        # every selected page was skipped, beyond the limit or not in the text layer
        skipped = len(run.pages_selected) - len(run.pages_over_limit)
        message = f"{_pages(skipped)} could not be corrected (text layer not patchable or not line-structured)." if skipped else ""
    elif not run.found:
        reviewed = len(run.pages_reviewed)
        message = f"No OCR errors found on {reviewed} reviewed {'page' if reviewed == 1 else 'pages'}."
    else:
        message = f"{run.found} {'correction' if run.found == 1 else 'corrections'} {'was' if run.found == 1 else 'were'} dropped or could not be applied."
    if run.pages_over_limit:
        over = len(run.pages_over_limit)
        note = f"{_pages(over)} {'was' if over == 1 else 'were'} not reviewed: the correction reviews at most {run.max_pages} pages per run."
        message = f"{message} {note}" if message else note
    return message


async def _run_job(
    job: OcrJob,
    jobs: OcrJobStore,
    engine: OcrEngine,
    languages: list[str],
    options: dict[str, OcrOptionValue],
    rebuild: bool,
    repo: FileRepository,
    storage: FileStorage,
    user: dict[str, Any],
    llm: _LlmCorrection | None = None,
) -> None:
    """Wait until no other OCR run happens on the server, run OCR and record the outcome in the job."""
    is_cancelled = lambda: jobs.is_cancel_requested(job.job_id)  # noqa: E731
    try:
        async with jobs.run_slot(job) as job:
            result = await _recognize(job.stable_id, engine, languages, options, rebuild, repo, storage, user, _progress_writer(jobs, job), llm, is_cancelled)
    except OcrCancelled:
        logger.info(f"OCR job {job.job_id} for {job.stable_id} was cancelled")
        jobs.cancel(job)
    except HTTPException as e:
        jobs.fail(job, str(e.detail), e.status_code)
    except asyncio.CancelledError:
        jobs.fail(job, "Text recognition was interrupted because the server is restarting. Please try again.", 503)
        raise
    except Exception as e:
        logger.exception(f"OCR job {job.job_id} for {job.stable_id} failed")
        jobs.fail(job, f"Text recognition failed: {e}", 500)
    else:
        jobs.finish(job, result)


async def _run_correction_job(
    job: OcrJob,
    jobs: OcrJobStore,
    languages: list[str],
    repo: FileRepository,
    storage: FileStorage,
    user: dict[str, Any],
    llm: _LlmCorrection,
) -> None:
    """Wait until no other OCR run happens on the server, run the LLM correction and record the outcome in the job."""
    is_cancelled = lambda: jobs.is_cancel_requested(job.job_id)  # noqa: E731
    try:
        async with jobs.run_slot(job) as job:
            result = await _correct_stored_pdf(job.stable_id, languages, repo, storage, user, llm, _progress_writer(jobs, job), is_cancelled)
    except OcrCancelled:
        logger.info(f"LLM correction job {job.job_id} for {job.stable_id} was cancelled")
        jobs.cancel(job)
    except HTTPException as e:
        jobs.fail(job, str(e.detail), e.status_code)
    except asyncio.CancelledError:
        jobs.fail(job, "The correction was interrupted because the server is restarting. Please try again.", 503)
        raise
    except Exception as e:
        logger.exception(f"LLM correction job {job.job_id} for {job.stable_id} failed")
        jobs.fail(job, f"The correction failed: {e}", 500)
    else:
        jobs.finish(job, result)


async def _correct_stored_pdf(
    stable_id: str,
    languages: list[str],
    repo: FileRepository,
    storage: FileStorage,
    user: dict[str, Any],
    llm: _LlmCorrection,
    on_progress: ProgressCallback | None = None,
    is_cancelled: Callable[[], bool] | None = None,
) -> OcrResponse:
    """
    Correct the OCR errors of the text layer of a stored PDF with an LLM and store the result as a
    new PDF of the document if anything was corrected (#944). The caller holds the run slot.

    Without `languages`, those of the last OCR run of the PDF are used.

    Raises:
        HTTPException: if the PDF is gone
        OcrCancelled: if the run was cancelled; the PDF is unchanged
    """
    report_to = on_progress or (lambda _progress: None)
    file = _get_pdf(repo, stable_id, user, "edit")
    input_path = _pdf_path(storage, file)
    ocr_record = file.file_metadata.get(OCR_METADATA_KEY)
    if not languages and isinstance(ocr_record, dict):
        recorded = ocr_record.get("languages")
        languages = [str(lang) for lang in recorded] if isinstance(recorded, list) else []
    with tempfile.TemporaryDirectory(prefix="pte-ocr-") as tmp:
        work_path = Path(tmp) / "corrected.pdf"
        work_path.write_bytes(input_path.read_bytes())
        with progress_reporter(report_to, is_cancelled) as progress:
            run = await _correct_with_llm(work_path, llm, languages)
            progress.check_cancelled()
        result_pdf = file
        if run.corrections:
            applied_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            record = _correction_record(run, llm, applied_at, str(user.get("username") or ""), "llm-correction")
            previous = file.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []
            file_metadata = {**file.file_metadata, TEXT_CORRECTIONS_METADATA_KEY: [*previous, record]}
            result_pdf = _store_pdf(repo, storage, file, work_path.read_bytes(), file_metadata, user)
            logger.info(f"Corrected {len(run.corrections)} OCR error(s) of {file.stable_id} with {llm.provider_id}/{llm.model_id}: {file.id[:8]} -> {result_pdf.stable_id} ({result_pdf.id[:8]})")
        # the result is stored: cancelling no longer applies
        with progress_reporter(report_to) as progress:
            progress.report("Checking the new text layer")
            quality = await asyncio.to_thread(analyze_text_layer, work_path)
    if isinstance(ocr_record, dict):
        quality.ocr_applied = ocr_record
    return OcrResponse(
        stable_id=result_pdf.stable_id,
        source_stable_id=file.stable_id,
        changed=result_pdf.stable_id != file.stable_id,
        message=_llm_correction_message(run, llm.model_id),
        method=None,
        fallback_reason=None,
        quality=quality,
        llm_corrections=[OcrLlmCorrection(page=c.page, old=c.old, new=c.new, rationale=c.rationale) for c in run.corrections],
        llm_correction_error=run.error,
        llm_correction_cancelled=False,
    )


def _correction_record(run: llm_correction.CorrectionRun, llm: _LlmCorrection, applied_at: str, applied_by: str, source: str) -> dict[str, str | list[dict[str, str | int]]]:
    """The record of the corrections of an LLM correction pass in the file metadata ("text_corrections")."""
    return {
        "applied_at": applied_at,
        "applied_by": applied_by,
        "source": source,
        "provider_id": llm.provider_id,
        "model_id": llm.model_id,
        "corrections": [{"page": c.page, "old": c.old, "new": c.new} for c in run.corrections],
    }


def _progress_writer(jobs: OcrJobStore, job: OcrJob) -> ProgressCallback:
    """
    Return a callback that records the progress of a job, at most once per
    PROGRESS_WRITE_INTERVAL_SECONDS unless the phase changes.
    """
    last_phase: str | None = None
    last_time = 0.0

    def write(progress: OcrProgress) -> None:
        nonlocal last_phase, last_time
        now = time.monotonic()
        if progress.phase == last_phase and now - last_time < PROGRESS_WRITE_INTERVAL_SECONDS:
            return
        last_phase, last_time = progress.phase, now
        try:
            jobs.update_progress(job, progress)
        except OSError as e:
            logger.warning(f"Could not record the progress of OCR job {job.job_id}: {e}")

    return write


async def _recognize(
    stable_id: str,
    engine: OcrEngine,
    languages: list[str],
    options: dict[str, OcrOptionValue],
    rebuild: bool,
    repo: FileRepository,
    storage: FileStorage,
    user: dict[str, Any],
    on_progress: ProgressCallback | None = None,
    llm: _LlmCorrection | None = None,
    is_cancelled: Callable[[], bool] | None = None,
) -> OcrResponse:
    """
    Apply OCR to a PDF and store the result as a new PDF of the document (#944); the versions
    attached to the PDF stay attached to it. The caller holds the run slot.

    Progress reported by the engine (see `fastapi_app.lib.ocr.progress`) is passed to on_progress.

    The OCR result is stored before the LLM correction pass (`llm`) starts, so that it is kept if
    the pass fails or is cancelled; the pass corrects the stored text layer and stores the result as
    a further PDF if it corrected anything.

    If `is_cancelled` returns True, OCR stops at the next progress report of the engine, or at the
    latest before its result is stored, and `OcrCancelled` is raised. Once the OCR result is stored,
    cancelling stops only the LLM correction pass (`llm_correction_cancelled` in the response).

    Raises:
        HTTPException: if the PDF is gone, the options are invalid or the engine fails
        OcrCancelled: if the run was cancelled before the OCR result was stored
    """
    report_to = on_progress or (lambda _progress: None)
    # look the PDF up again, since it may have changed while the job was queued
    file = _get_pdf(repo, stable_id, user, "edit")
    input_path = _pdf_path(storage, file)
    with tempfile.TemporaryDirectory(prefix="pte-ocr-") as tmp:
        output_path = Path(tmp) / "output.pdf"
        with progress_reporter(report_to, is_cancelled) as progress:
            try:
                # to_thread passes the progress reporter on to the worker thread
                outcome = await asyncio.to_thread(engine.recognize, input_path, output_path, languages, options, rebuild)
            except ValueError as e:
                # an engine may turn the cancellation raised in its progress report into its own error
                progress.check_cancelled()
                raise HTTPException(status_code=400, detail=str(e))
            except Exception as e:
                progress.check_cancelled()
                logger.error(f"OCR with {engine.id} failed for {file.stable_id}: {e}")
                raise HTTPException(status_code=500, detail=f"Text recognition failed: {e}")
            progress.check_cancelled()
        if not output_path.exists():
            raise HTTPException(status_code=500, detail="Text recognition produced no output")

        result = outcome if isinstance(outcome, OcrResult) else OcrResult(message=outcome)
        applied_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        applied_by = str(user.get("username") or "")
        record: dict[str, str | list[str]] = {
            "engine": engine.id,
            "languages": languages,
            "applied_at": applied_at,
            "applied_by": applied_by,
        }
        if result.method:
            record["method"] = result.method
        if result.fallback_reason:
            record["fallback_reason"] = result.fallback_reason
        file_metadata = {**file.file_metadata, OCR_METADATA_KEY: record}
        result_pdf = _store_pdf(repo, storage, file, output_path.read_bytes(), file_metadata, user)
        logger.info(f"Applied OCR ({engine.id}, {result.method or 'default method'}, {languages}) to {file.stable_id}: {file.id[:8]} -> {result_pdf.stable_id} ({result_pdf.id[:8]})")

        message = result.message
        run: llm_correction.CorrectionRun | None = None
        correction_cancelled = False
        if llm is not None:
            try:
                with progress_reporter(report_to, is_cancelled):
                    run = await _correct_with_llm(output_path, llm, languages)
            except OcrCancelled:
                logger.info(f"LLM correction of {file.stable_id} was cancelled; the OCR result is kept")
                correction_cancelled = True
                note = f"The correction with {llm.model_id} was cancelled."
            else:
                if run.corrections:
                    correction_record = _correction_record(run, llm, applied_at, applied_by, "llm-after-ocr")
                    previous = file.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []
                    file_metadata = {**file_metadata, TEXT_CORRECTIONS_METADATA_KEY: [*previous, correction_record]}
                    result_pdf = _store_pdf(repo, storage, result_pdf, output_path.read_bytes(), file_metadata, user)
                note = _llm_correction_message(run, llm.model_id)
            message = f"{message} {note}" if message else note

        # the result is stored: cancelling no longer applies
        with progress_reporter(report_to) as progress:
            progress.report("Checking the new text layer")
            quality = await asyncio.to_thread(analyze_text_layer, output_path)

    quality.ocr_applied = record
    return OcrResponse(
        stable_id=result_pdf.stable_id,
        source_stable_id=file.stable_id,
        changed=result_pdf.stable_id != file.stable_id,
        message=message,
        method=result.method,
        fallback_reason=result.fallback_reason,
        quality=quality,
        llm_corrections=[OcrLlmCorrection(page=c.page, old=c.old, new=c.new, rationale=c.rationale) for c in run.corrections] if run else [],
        llm_correction_error=run.error if run else None,
        llm_correction_cancelled=correction_cancelled,
    )


def _store_pdf(repo: FileRepository, storage: FileStorage, source: FileMetadata, content: bytes, file_metadata: dict[str, Any], user: dict[str, Any]) -> FileMetadata:
    """
    Store the result of changing the text layer of a PDF. PDFs are not changed (#944): new
    content becomes a new PDF of the document; if the content is the same, only the file metadata
    of the PDF is updated.

    Args:
        repo: File repository
        storage: File storage
        source: The PDF the result was made from
        content: The new content
        file_metadata: The file metadata of the result
        user: The user who made it

    Returns:
        The PDF that holds the result: a new one, or the source if the content is unchanged
    """
    new_hash, _ = storage.save_file(content, "pdf", increment_ref=False)
    if new_hash == source.id:
        updated = repo.update_file(source.id, FileUpdate(file_metadata=file_metadata), stable_id=source.stable_id)
        return updated
    return repo.create_pdf_version(source.stable_id, new_hash, len(content), file_metadata, created_by=str(user.get("username") or "") or None)


# --- Text corrections (#931) ------------------------------------------------------------------

UNSUPPORTED_DOCUMENT_MESSAGE = "Text corrections cannot be written for this kind of document."
OCR_RUNNING_MESSAGE = "Text recognition is running for the PDF of this document. Please wait until it is finished."
NO_CORRECTIONS_MESSAGE = "The document has no text corrections to write."
LOCKED_MESSAGE = "This document is being edited in another session. Text corrections can only be written by the session that edits it."
UNWRITABLE_MESSAGE = "Some differences between the document and the text layer cannot be written. Skip them to write the other corrections."


@dataclass
class _CorrectionContext:
    """A TEI document whose text corrections can be written into its PDF, with the corrections."""

    tei: FileMetadata
    xml: str
    pdf: FileMetadata
    pdf_path: Path
    handler: CorrectedPdfHandler
    plan: CorrectionPlan


def _get_tei(repo: FileRepository, stable_id: str, user: dict[str, Any]) -> FileMetadata:
    """
    Look up a TEI file by stable_id and check that the user can edit it.

    Raises:
        HTTPException: 404 if there is no such TEI file, 403 if access is denied
    """
    file = repo.get_file_by_stable_id(stable_id)
    if file is None or file.file_type != "tei":
        raise HTTPException(status_code=404, detail=f"TEI file not found: {stable_id}")
    if not check_file_access(file, user, "edit"):
        raise HTTPException(status_code=403, detail="Access denied")
    return file


class _CorrectionProgress:
    """
    Shows the steps of previewing or writing text corrections in a progress widget of the client
    (via SSE), if the request names one. The client shows and hides the widget.
    """

    def __init__(self, sse_service: SSEService, session_id: str, progress_id: str | None) -> None:
        self._bar = ProgressBar(sse_service, session_id, progress_id) if progress_id else None
        self._last_page_report = 0.0

    def step(self, label: str) -> None:
        """Show a step whose duration is unknown."""
        if self._bar is None:
            return
        self._bar.set_label(label)
        self._bar.set_value(None)

    def pages(self, label: str) -> PageCallback:
        """Return a callback that shows the pages done of a step (called from a worker thread)."""
        def report(done: int, total: int) -> None:
            if self._bar is None:
                return
            now = time.monotonic()
            if done < total and now - self._last_page_report < PAGE_PROGRESS_INTERVAL_SECONDS:
                return
            self._last_page_report = now
            self._bar.set_label(f"{label}: page {done} of {total}")
            self._bar.set_value(round(done / total * 100) if total else None)
        return report


def _derive_plan(xml: str, variant_id: str, layout: LineLayout, pdf_path: Path, progress: _CorrectionProgress) -> CorrectionPlan:
    """Compare the TEI's words with the PDF's text layer (blocking)."""
    words = tei_words(xml, variant_id, layout)
    with pikepdf.open(pdf_path) as pdf:
        layer = read_text_layer(pdf, progress.pages("Reading the text layer of the PDF"))
    return derive_corrections(words, layer, progress.pages("Comparing the document with the text layer"))


async def _correction_context(stable_id: str, repo: FileRepository, storage: FileStorage, jobs: OcrJobStore, user: dict[str, Any], session_id: str, progress: _CorrectionProgress) -> _CorrectionContext:
    """
    Check the preconditions of writing a TEI's text corrections into its PDF and derive them.

    Raises:
        HTTPException: 404/403 if the TEI or its PDF is missing or not editable, 409 if the
            corrections cannot be written (the detail says why), 423 if another session holds the
            lock of the TEI, 422 if the PDF cannot be read.
            Whether there are corrections at all is left to the caller.
    """
    tei = _get_tei(repo, stable_id, user)
    if check_lock(tei.stable_id, session_id, get_settings().db_dir, logger)["is_locked"]:
        raise HTTPException(status_code=423, detail=LOCKED_MESSAGE)
    content = storage.read_file(tei.id, "tei")
    if content is None:
        raise HTTPException(status_code=404, detail=f"TEI content not found: {stable_id}")
    xml = content.decode("utf-8")
    progress.step("Reading the lines of the document")
    layout = await asyncio.to_thread(get_line_layout, xml, tei.doc_id, tei.variant)
    if layout is None:
        raise HTTPException(status_code=409, detail=MISSING_LAYOUT_MESSAGE)
    handler = get_corrected_pdf_handler(tei.variant)
    if handler is None or tei.variant is None:
        raise HTTPException(status_code=409, detail=UNSUPPORTED_DOCUMENT_MESSAGE)
    # the corrections are derived from the PDF the version is attached to (#944)
    own_pdf = repo.get_pdf_for_file(tei)
    if own_pdf is None:
        raise HTTPException(status_code=404, detail=f"No PDF found for document {tei.doc_id}")
    pdf = _get_pdf(repo, own_pdf.stable_id, user, "edit")
    if jobs.find_active(pdf.stable_id) is not None:
        raise HTTPException(status_code=409, detail=OCR_RUNNING_MESSAGE)
    pdf_path = _pdf_path(storage, pdf)
    try:
        plan = await asyncio.to_thread(_derive_plan, xml, tei.variant, layout, pdf_path, progress)
    except ValueError as e:
        # the variant has no zone labels
        logger.debug(f"Cannot derive text corrections for {stable_id}: {e}")
        raise HTTPException(status_code=409, detail=UNSUPPORTED_DOCUMENT_MESSAGE)
    except pikepdf.PdfError as e:
        raise HTTPException(status_code=422, detail=f"The PDF cannot be read: {e}")
    return _CorrectionContext(tei, xml, pdf, pdf_path, handler, plan)


def _patch_pdf(source: Path, target: Path, corrections: list[WordCorrection]) -> None:
    """Write the corrections into the text layer of a copy of the PDF (blocking)."""
    with pikepdf.open(source) as pdf:
        patch_text_layer(pdf, [WordPatch(c.word, c.new) for c in corrections])
        pdf.save(target)


TEXT_CORRECTIONS_LABEL = "Corrected text layer"
"""Label of a version created by writing text corrections into the PDF."""


def _text_corrections_desc(count: int) -> str:
    """The description of the revision change of a version created by writing text corrections into the PDF."""
    return f"Wrote {count} text correction{'' if count == 1 else 's'} into the text layer of a new PDF and attached this version to it"


def _prepare_version_xml(xml: str, doc_id: str, reference_xml: str, user: dict[str, Any], corrections: int) -> tuple[str, dict[str, str | None]]:
    """
    Prepare the TEI returned by the corrected-PDF handler for storage as a new version: a revision
    change by the user that records the corrections and labels the version (TEXT_CORRECTIONS_LABEL),
    then, as the save route does, document identifier, entity encoding and revision hashes.

    The change keeps the status of the last change of the document ("draft" if there is none).

    Args:
        xml: The TEI returned by the handler
        doc_id: Document the version belongs to
        reference_xml: The TEI the version is made from
        user: The user who writes the corrections
        corrections: Number of corrections written into the PDF

    Returns:
        The XML and its label, status and last_revision

    Raises:
        ValueError: if the XML is not well-formed or has no teiHeader
    """
    try:
        root = etree.fromstring(xml.encode("utf-8"))
    except etree.XMLSyntaxError as e:
        raise ValueError(f"The updated document is not well-formed XML: {e}") from e
    username = str(user.get("username") or "") or "unknown"
    # the user's name is recorded in a respStmt of the fileDesc, if the document has one
    has_file_desc = root.find("tei:teiHeader/tei:fileDesc", {"tei": "http://www.tei-c.org/ns/1.0"}) is not None
    add_revision_change(
        root,
        when=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        status=str(extract_tei_metadata(root).get("status") or "draft"),
        who=username,
        desc=_text_corrections_desc(corrections),
        full_name=(str(user.get("fullname") or "") or None) if has_file_desc else None,
        label=TEXT_CORRECTIONS_LABEL,
    )
    xml = serialize_tei_with_formatted_header(root, extract_processing_instructions(xml))
    metadata = extract_tei_metadata(root)
    try:
        xml = update_fileref_in_xml(xml, doc_id)
    except ValueError as e:
        logger.warning(f"Could not update fileref in XML: {e}")
    xml = stamp_revision_hashes(apply_entity_encoding_from_config(xml), reference_xml)
    return xml, {
        "label": metadata.get("edition_title"),
        "status": metadata.get("status"),
        "last_revision": metadata.get("last_revision"),
    }


@router.post("/text-corrections/preview", response_model=TextCorrectionsPreview)
async def preview_text_corrections(
    request: TextCorrectionsRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    jobs: OcrJobStore = Depends(get_ocr_job_store),
    current_user: dict[str, Any] = Depends(require_reviewer_or_admin),
    session_id: str = Depends(require_session_id),
    sse_service: SSEService = Depends(get_sse_service),
) -> TextCorrectionsPreview:
    """
    Show what writing the text corrections of a TEI document into the OCR text layer of its PDF
    would do: the words that would be corrected and the differences that cannot be written.

    If the corrections cannot be written, `reason` says why and the lists are empty, except when
    there are no corrections: then `unwritable` is filled, since the unwritable differences explain
    why. This includes a lock of the TEI held by another session.
    A missing TEI file or missing access is reported with 404/403 as usual.

    If `progress_id` is given, the steps are shown in that progress widget of the client.
    """
    progress = _CorrectionProgress(sse_service, session_id, request.progress_id)
    try:
        context = await _correction_context(request.stable_id, repo, storage, jobs, current_user, session_id, progress)
    except HTTPException as e:
        if e.status_code not in (409, 423):
            raise
        return TextCorrectionsPreview(reason=str(e.detail))
    return TextCorrectionsPreview(
        corrections=[TextCorrectionItem(page=c.page, line=c.line, old=c.old, new=c.new) for c in context.plan.corrections],
        unwritable=[UnwritableItem(page=u.page, line=u.line, layer_text=u.layer_text, tei_text=u.tei_text, reason=u.reason) for u in context.plan.unwritable],
        # the unwritable differences explain why there is nothing to write
        reason=None if context.plan.corrections else NO_CORRECTIONS_MESSAGE,
    )


@router.post("/text-corrections/apply", response_model=TextCorrectionsResult)
async def apply_text_corrections(
    request: TextCorrectionsRequest,
    http_request: Request,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    jobs: OcrJobStore = Depends(get_ocr_job_store),
    current_user: dict[str, Any] = Depends(require_reviewer_or_admin),
    session_id: str = Depends(require_session_id),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
) -> TextCorrectionsResult:
    """
    Write the text corrections of a TEI document into the OCR text layer of a copy of its PDF,
    which becomes a new PDF of the document (`pdf_stable_id`, #944). The PDF the version is
    attached to is not changed, nor are the other versions.

    The extractor plugin of the document's variant then regenerates its data for the corrected
    PDF and returns the TEI updated for it. It is saved as a new version of the document
    (`tei_stable_id`; its content is returned as `xml`), which is attached to the corrected PDF,
    made from the given version and locked for the session. A revision change by the user records
    the corrections and gives the version the label "Corrected text layer".

    Refused with 409 if the corrections cannot be written (see the preview's `reason`) or if some
    differences cannot be written and `skip_unwritable` is false, and with 423 if another session
    holds the lock of the TEI. If the plugin finds that the corrected PDF does not match the
    document, the response is 422 with `message` and the unmatched `lines`; if its service is
    unreachable or the plugin fails, 502. Nothing is replaced in these cases.

    If `progress_id` is given, the steps are shown in that progress widget of the client.
    """
    settings = get_settings()
    progress = _CorrectionProgress(sse_service, session_id, request.progress_id)
    context = await _correction_context(request.stable_id, repo, storage, jobs, current_user, session_id, progress)
    plan, pdf, tei = context.plan, context.pdf, context.tei
    if not plan.corrections:
        raise HTTPException(status_code=409, detail=NO_CORRECTIONS_MESSAGE)
    if plan.unwritable and not request.skip_unwritable:
        raise HTTPException(status_code=409, detail=UNWRITABLE_MESSAGE)
    # refuse before anything is changed if the user cannot create the new version
    version_collections(repo, tei.doc_id, current_user, settings.db_dir, logger)

    with tempfile.TemporaryDirectory(prefix="pte-text-corrections-") as tmp:
        output_path = Path(tmp) / "corrected.pdf"
        progress.step(f"Writing {len(plan.corrections)} correction{'' if len(plan.corrections) == 1 else 's'} into the PDF")
        try:
            await asyncio.to_thread(_patch_pdf, context.pdf_path, output_path, plan.corrections)
        except (ValueError, pikepdf.PdfError) as e:
            logger.warning(f"Cannot write text corrections into {pdf.stable_id}: {e}")
            raise HTTPException(status_code=422, detail=f"The text layer of the PDF cannot be changed: {e}")
        content = output_path.read_bytes()
    new_hash, new_path = storage.save_file(content, "pdf", increment_ref=False)
    if new_hash == pdf.id:
        raise HTTPException(status_code=409, detail=NO_CORRECTIONS_MESSAGE)

    corrected_lines = frozenset(c.line for c in plan.corrections)
    progress.step("Updating the document for the corrected PDF. This can take a minute.")
    try:
        xml = await asyncio.to_thread(context.handler, context.xml, tei.doc_id, new_path, new_hash, corrected_lines)
    except CorrectedPdfMismatch as e:
        logger.warning(f"Corrected PDF of {pdf.stable_id} does not match {tei.stable_id} (lines {e.lines}): {e}")
        raise HTTPException(status_code=422, detail={"message": str(e), "lines": e.lines})
    except RuntimeError as e:
        logger.warning(f"Cannot process the corrected PDF of {pdf.stable_id}: {e}")
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.exception(f"The corrected-PDF handler failed for {pdf.stable_id}: {e}")
        raise HTTPException(status_code=502, detail=f"The corrected PDF could not be processed: {e}")
    try:
        version_xml, version_metadata = _prepare_version_xml(xml, tei.doc_id, context.xml, current_user, len(plan.corrections))
    except ValueError as e:
        logger.warning(f"The corrected-PDF handler returned an invalid document for {tei.stable_id}: {e}")
        raise HTTPException(status_code=502, detail=str(e))

    record: dict[str, str | list[dict[str, str | int]]] = {
        "applied_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "applied_by": str(current_user.get("username") or ""),
        "tei_stable_id": tei.stable_id,
        "corrections": [{"page": c.page, "old": c.old, "new": c.new} for c in plan.corrections],
    }
    previous = pdf.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []
    file_metadata = {**pdf.file_metadata, TEXT_CORRECTIONS_METADATA_KEY: [*previous, record]}
    # the corrected PDF is a new PDF of the document; the version given stays attached to its PDF
    corrected_pdf = repo.create_pdf_version(pdf.stable_id, new_hash, len(content), file_metadata, created_by=str(current_user.get("username") or "") or None)
    progress.step("Saving the new version of the document")

    # The new version is attached to the corrected PDF. It is created before the response is sent,
    # so that a lost response leaves a consistent state
    try:
        version = await create_tei_version(
            xml_string=version_xml,
            doc_id=tei.doc_id,
            variant=tei.variant,
            label=version_metadata["label"],
            status=version_metadata["status"],
            last_revision=version_metadata["last_revision"],
            parent_stable_id=tei.stable_id,
            pdf_stable_id=corrected_pdf.stable_id,
            user=current_user,
            session_id=session_id,
            base_url=f"{http_request.url.scheme}://{http_request.url.netloc}",
            db_dir=settings.db_dir,
            file_repo=repo,
            file_storage=storage,
            sse_service=sse_service,
            session_manager=session_manager,
            logger_inst=logger,
        )
    except Exception as e:
        logger.exception(f"Wrote the text corrections of {tei.stable_id} into {pdf.stable_id}, but could not create the new version: {e}")
        reason = e.detail if isinstance(e, HTTPException) else str(e)
        raise HTTPException(status_code=500, detail=f"The corrections were written to the PDF, but the new version of the document could not be created: {reason}")
    logger.info(f"Wrote {len(plan.corrections)} text correction(s) of {tei.stable_id} into a copy of {pdf.stable_id}: new PDF {corrected_pdf.stable_id} ({pdf.id[:8]} -> {new_hash[:8]}), new version {version.file.stable_id}")
    return TextCorrectionsResult(
        xml=version_xml,
        tei_stable_id=version.file.stable_id,
        pdf_stable_id=corrected_pdf.stable_id,
        source_pdf_stable_id=pdf.stable_id,
        corrections=len(plan.corrections),
    )


# ── LLM review of OCR errors ─────────────────────────────────────────


def _review_source(tei: FileMetadata, xml: str, scope: str | None) -> OcrReviewSource:
    """
    The page windows of the TEI's (unsaved) XML (blocking).

    Raises:
        HTTPException: 422 if the document is no zone document, has no line layout or the scope is invalid
    """
    if tei.variant is None:
        raise HTTPException(status_code=422, detail="The document has no variant")
    try:
        return prepare_source(xml, tei.doc_id, tei.variant, scope)
    except (MissingLayoutError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.post("/llm-review/plan", response_model=OcrReviewPlanResponse)
async def plan_ocr_llm_review(
    body: OcrReviewPlanRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> OcrReviewPlanResponse:
    """Report how many page windows `/ocr/llm-review` needs for the given document content (no LLM call)."""
    tei = _get_tei(repo, body.stable_id, current_user)
    source = await asyncio.to_thread(_review_source, tei, body.xml, body.scope)
    return OcrReviewPlanResponse(window_count=len(source.windows))


@router.post("/llm-review", response_model=OcrReviewResponse)
async def ocr_llm_review(
    body: OcrReviewRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> OcrReviewResponse:
    """
    Review one page window of the given (possibly unsaved) content of a zone document for OCR
    errors with the given provider and model. The response reports how many windows the document
    has; the client requests each `window_index` in turn. Refused with 422 if the document has no
    line layout or is no zone document, 404 for an unknown provider, 428 if the provider needs a
    secret of the user, 403 if the user may not use the model.
    """
    tei = _get_tei(repo, body.stable_id, current_user)
    provider = _llm_provider(body.provider_id, current_user)

    source = await asyncio.to_thread(_review_source, tei, body.xml, body.scope)
    if not 0 <= body.window_index < len(source.windows):
        raise HTTPException(status_code=422, detail=f"Window {body.window_index} does not exist; the document has {len(source.windows)} windows")
    min_similarity = float(get_config().get(MIN_LETTER_SIMILARITY_KEY, DEFAULT_MIN_LETTER_SIMILARITY))
    try:
        # may list the provider's models, so its connection errors are handled below
        check_model_access(provider, body.model_id, current_user)
        findings, window_count, discarded = await review_window(source, body.window_index, provider, body.model_id, min_similarity)
    except Exception as e:
        http_error = llm_http_error(e, body.provider_id)
        if http_error is None:
            raise
        raise http_error from e

    start, end = window_range(source.doc, source.xml, source.windows[body.window_index])
    return OcrReviewResponse(
        findings=[OcrReviewFinding(**f) for f in findings],
        window_count=window_count,
        discarded=discarded,
        window_start=start,
        window_end=end,
    )

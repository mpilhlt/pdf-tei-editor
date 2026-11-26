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
    AffectedFile,
    OcrEngineInfo,
    OcrJob,
    OcrLlmCorrection,
    OcrOptionInfo,
    OcrProgress,
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
from ..lib.ocr.jobs import OcrJobConflict, OcrJobStore
from ..lib.ocr.languages import normalize_ocr_language
from ..lib.ocr import llm_correction
from ..lib.ocr.layout_check import apply_layout_check, check_text_layout
from ..lib.ocr.llm_review import DEFAULT_MIN_LETTER_SIMILARITY, MIN_LETTER_SIMILARITY_KEY, MissingLayoutError, OcrReviewSource, prepare_source, review_window
from ..lib.ocr.progress import ProgressCallback, progress_reporter
from ..lib.ocr.registry import OcrEngineRegistry
from ..lib.ocr.text_corrections import CorrectedPdfHandler, CorrectedPdfMismatch, CorrectionPlan, WordCorrection, derive_corrections, get_corrected_pdf_handler, tei_words
from ..lib.ocr.text_layer import WordPatch, patch_text_layer, read_text_layer
from ..lib.ocr.text_quality import analyze_text_layer
from ..lib.permissions.access_control import check_file_access
from ..lib.repository.file_repository import FileRepository
from ..lib.secrets import MissingSecretError, secret_required_detail
from ..lib.services.tei_versions import create_tei_version, version_collections
from ..lib.sse.sse_service import SSEService
from ..lib.storage.file_storage import FileStorage
from ..lib.tei.zone_lines import window_range
from ..lib.tei.layout import MISSING_LAYOUT_MESSAGE, LineLayout, get_line_layout
from ..lib.utils.config_utils import get_config
from ..lib.utils.revision_hash import stamp_revision_hashes
from ..lib.utils.tei_utils import extract_tei_metadata, update_fileref_in_xml
from ..lib.utils.xml_utils import apply_entity_encoding_from_config
from ..lib.utils.logging_utils import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/ocr", tags=["ocr"])

OCR_METADATA_KEY = "ocr"
"""Key in the PDF's file_metadata under which the last OCR run is recorded."""

TEXT_CORRECTIONS_METADATA_KEY = "text_corrections"
"""Key in the PDF's file_metadata under which the text corrections written into it are recorded."""

PROGRESS_WRITE_INTERVAL_SECONDS = 1.0
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
    if operation == "edit" and file.superseded_by:
        raise HTTPException(status_code=400, detail=f"PDF {stable_id} is the archived original of {file.superseded_by} and cannot be changed")
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
        skipped = len(run.pages_skipped) - len(run.pages_over_limit)
        message = f"{_pages(skipped)} could not be corrected (text layer not patchable or not line-structured)." if skipped else ""
    elif not run.found:
        reviewed = len(run.pages_reviewed)
        message = f"No OCR errors found on {reviewed} reviewed {'page' if reviewed == 1 else 'pages'}."
    else:
        message = f"{run.found} {'correction' if run.found == 1 else 'corrections'} could not be applied."
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
    try:
        async with jobs.run_slot(job) as job:
            result = await _recognize(job.stable_id, engine, languages, options, rebuild, repo, storage, user, _progress_writer(jobs, job), llm)
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
) -> OcrResponse:
    """
    Apply OCR to a PDF and replace the stored PDF with the result. The caller holds the run slot.

    Progress reported by the engine (see `fastapi_app.lib.ocr.progress`) is passed to on_progress.
    With `llm`, the LLM correction pass corrects the new text layer in place before it is stored.

    Raises:
        HTTPException: if the PDF is gone, the options are invalid or the engine fails
    """
    # look the PDF up again, since it may have changed while the job was queued
    file = _get_pdf(repo, stable_id, user, "edit")
    input_path = _pdf_path(storage, file)
    with tempfile.TemporaryDirectory(prefix="pte-ocr-") as tmp, progress_reporter(on_progress or (lambda _progress: None)) as progress:
        output_path = Path(tmp) / "output.pdf"
        try:
            # to_thread passes the progress reporter on to the worker thread
            outcome = await asyncio.to_thread(engine.recognize, input_path, output_path, languages, options, rebuild)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.error(f"OCR with {engine.id} failed for {file.stable_id}: {e}")
            raise HTTPException(status_code=500, detail=f"Text recognition failed: {e}")
        if not output_path.exists():
            raise HTTPException(status_code=500, detail="Text recognition produced no output")
        run = await _correct_with_llm(output_path, llm, languages) if llm is not None else None
        content = output_path.read_bytes()
        progress.report("Checking the new text layer")
        quality = await asyncio.to_thread(analyze_text_layer, output_path)

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
    new_hash, _ = storage.save_file(content, "pdf", increment_ref=False)
    changed = new_hash != file.id
    file_metadata = {**file.file_metadata, OCR_METADATA_KEY: record}
    message = result.message
    if llm is not None and run is not None:
        if run.corrections:
            correction_record: dict[str, str | list[dict[str, str | int]]] = {
                "applied_at": applied_at,
                "applied_by": applied_by,
                "source": "llm-after-ocr",
                "provider_id": llm.provider_id,
                "model_id": llm.model_id,
                "corrections": [{"page": c.page, "old": c.old, "new": c.new} for c in run.corrections],
            }
            previous = file.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []
            file_metadata[TEXT_CORRECTIONS_METADATA_KEY] = [*previous, correction_record]
        note = _llm_correction_message(run, llm.model_id)
        message = f"{message} {note}" if message else note
    archived_stable_id: str | None = None
    if changed:
        # Moves the storage reference to the new content; the old content is kept as an archived
        # PDF if versions were made from it (#924)
        _, archived = repo.replace_pdf_content(file.stable_id, new_hash, len(content), file_metadata)
        archived_stable_id = archived.stable_id if archived else None
    else:
        repo.update_file(file.id, FileUpdate(file_metadata=file_metadata), stable_id=file.stable_id)
    logger.info(f"Applied OCR ({engine.id}, {result.method or 'default method'}, {languages}) to {file.stable_id}: {file.id[:8]} -> {new_hash[:8]}" + (f", original archived as {archived_stable_id}" if archived_stable_id else ""))
    quality.ocr_applied = record
    return OcrResponse(
        stable_id=file.stable_id,
        changed=changed,
        archived_stable_id=archived_stable_id,
        message=message,
        method=result.method,
        fallback_reason=result.fallback_reason,
        quality=quality,
        llm_corrections=[OcrLlmCorrection(page=c.page, old=c.old, new=c.new, rationale=c.rationale) for c in run.corrections] if run else [],
        llm_correction_error=run.error if run else None,
    )


# --- Text corrections (#931) ------------------------------------------------------------------

ARCHIVED_VERSION_MESSAGE = "This version was made from an earlier PDF of the document. Open a version based on the current PDF."
UNSUPPORTED_DOCUMENT_MESSAGE = "Text corrections cannot be written for this kind of document."
OCR_RUNNING_MESSAGE = "Text recognition is running for the PDF of this document. Please wait until it is finished."
NO_CORRECTIONS_MESSAGE = "The document has no text corrections to write."
LOCKED_MESSAGE = "This document is being edited in another session. Text corrections can only be written by the session that edits it."
PDF_CHANGED_MESSAGE = "The PDF was changed while the corrections were written. Please try again."
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


def _derive_plan(xml: str, variant_id: str, layout: LineLayout, pdf_path: Path) -> CorrectionPlan:
    """Compare the TEI's words with the PDF's text layer (blocking)."""
    words = tei_words(xml, variant_id, layout)
    with pikepdf.open(pdf_path) as pdf:
        layer = read_text_layer(pdf)
    return derive_corrections(words, layer)


async def _correction_context(stable_id: str, repo: FileRepository, storage: FileStorage, jobs: OcrJobStore, user: dict[str, Any], session_id: str) -> _CorrectionContext:
    """
    Check the preconditions of writing a TEI's text corrections into its PDF and derive them.

    Raises:
        HTTPException: 404/403 if the TEI or its PDF is missing or not editable, 409 if the
            corrections cannot be written (the detail says why), 423 if another session holds the
            lock of the TEI, 422 if the PDF cannot be read.
            Whether there are corrections at all is left to the caller.
    """
    tei = _get_tei(repo, stable_id, user)
    if tei.pdf_stable_id:
        raise HTTPException(status_code=409, detail=ARCHIVED_VERSION_MESSAGE)
    if check_lock(tei.stable_id, session_id, get_settings().db_dir, logger)["is_locked"]:
        raise HTTPException(status_code=423, detail=LOCKED_MESSAGE)
    content = storage.read_file(tei.id, "tei")
    if content is None:
        raise HTTPException(status_code=404, detail=f"TEI content not found: {stable_id}")
    xml = content.decode("utf-8")
    layout = await asyncio.to_thread(get_line_layout, xml, tei.doc_id, tei.variant)
    if layout is None:
        raise HTTPException(status_code=409, detail=MISSING_LAYOUT_MESSAGE)
    handler = get_corrected_pdf_handler(tei.variant)
    if handler is None or tei.variant is None:
        raise HTTPException(status_code=409, detail=UNSUPPORTED_DOCUMENT_MESSAGE)
    current_pdf = repo.get_pdf_for_document(tei.doc_id)
    if current_pdf is None:
        raise HTTPException(status_code=404, detail=f"No PDF found for document {tei.doc_id}")
    pdf = _get_pdf(repo, current_pdf.stable_id, user, "edit")
    if jobs.find_active(pdf.stable_id) is not None:
        raise HTTPException(status_code=409, detail=OCR_RUNNING_MESSAGE)
    pdf_path = _pdf_path(storage, pdf)
    try:
        plan = await asyncio.to_thread(_derive_plan, xml, tei.variant, layout, pdf_path)
    except ValueError as e:
        # the variant has no zone labels
        logger.debug(f"Cannot derive text corrections for {stable_id}: {e}")
        raise HTTPException(status_code=409, detail=UNSUPPORTED_DOCUMENT_MESSAGE)
    except pikepdf.PdfError as e:
        raise HTTPException(status_code=422, detail=f"The PDF cannot be read: {e}")
    return _CorrectionContext(tei, xml, pdf, pdf_path, handler, plan)


def _file_label(file: FileMetadata) -> str:
    """The label of a TEI file as the file list shows it, with fallbacks."""
    if file.label and file.label.lower() not in ("untitled", "unknown title"):
        return file.label
    if file.is_gold_standard:
        return f"Gold ({file.variant})" if file.variant else "Gold"
    if file.version:
        return f"Version {file.version}"
    return file.stable_id


def _patch_pdf(source: Path, target: Path, corrections: list[WordCorrection]) -> None:
    """Write the corrections into the text layer of a copy of the PDF (blocking)."""
    with pikepdf.open(source) as pdf:
        patch_text_layer(pdf, [WordPatch(c.word, c.new) for c in corrections])
        pdf.save(target)


def _prepare_version_xml(xml: str, doc_id: str, reference_xml: str) -> tuple[str, dict[str, str | None]]:
    """
    Prepare the TEI returned by the corrected-PDF handler for storage as a new version, as the
    save route does: document identifier, entity encoding and revision hashes.

    Returns:
        The XML and its label, status and last_revision

    Raises:
        ValueError: if the XML is not well-formed
    """
    try:
        root = etree.fromstring(xml.encode("utf-8"))
    except etree.XMLSyntaxError as e:
        raise ValueError(f"The updated document is not well-formed XML: {e}") from e
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
) -> TextCorrectionsPreview:
    """
    Show what writing the text corrections of a TEI document into the OCR text layer of its PDF
    would do: the words that would be corrected, the differences that cannot be written, and the
    other versions of the document that would stay linked to the old PDF.

    If the corrections cannot be written, `reason` says why and the lists are empty, except when
    there are no corrections: then `unwritable` and `affected_files` are filled, since the
    unwritable differences explain why. This includes a lock of the TEI held by another session.
    A missing TEI file or missing access is reported with 404/403 as usual.
    """
    try:
        context = await _correction_context(request.stable_id, repo, storage, jobs, current_user, session_id)
    except HTTPException as e:
        if e.status_code not in (409, 423):
            raise
        return TextCorrectionsPreview(reason=str(e.detail))
    affected = [f for f in repo.get_current_pdf_teis(context.tei.doc_id) if f.stable_id != context.tei.stable_id]
    return TextCorrectionsPreview(
        corrections=[TextCorrectionItem(page=c.page, line=c.line, old=c.old, new=c.new) for c in context.plan.corrections],
        unwritable=[UnwritableItem(page=u.page, line=u.line, layer_text=u.layer_text, tei_text=u.tei_text, reason=u.reason) for u in context.plan.unwritable],
        affected_files=[AffectedFile(stable_id=f.stable_id, label=_file_label(f)) for f in affected],
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
    Write the text corrections of a TEI document into the OCR text layer of its PDF; the stored
    PDF is replaced with the corrected one.

    The extractor plugin of the document's variant then regenerates its data for the corrected
    PDF and returns the TEI updated for it. It is saved as a new version of the document
    (`tei_stable_id`; its content is returned as `xml`), which is based on the corrected PDF, made
    from the given version and locked for the session. The TEI files based on the old PDF,
    including the one given, are linked to the archived old PDF.

    Refused with 409 if the corrections cannot be written (see the preview's `reason`) or if some
    differences cannot be written and `skip_unwritable` is false, and with 423 if another session
    holds the lock of the TEI. If the plugin finds that the corrected PDF does not match the
    document, the response is 422 with `message` and the unmatched `lines`; if its service is
    unreachable or the plugin fails, 502. Nothing is replaced in these cases.
    """
    settings = get_settings()
    context = await _correction_context(request.stable_id, repo, storage, jobs, current_user, session_id)
    plan, pdf, tei = context.plan, context.pdf, context.tei
    if not plan.corrections:
        raise HTTPException(status_code=409, detail=NO_CORRECTIONS_MESSAGE)
    if plan.unwritable and not request.skip_unwritable:
        raise HTTPException(status_code=409, detail=UNWRITABLE_MESSAGE)
    # refuse before anything is changed if the user cannot create the new version
    version_collections(repo, tei.doc_id, current_user, settings.db_dir, logger)

    with tempfile.TemporaryDirectory(prefix="pte-text-corrections-") as tmp:
        output_path = Path(tmp) / "corrected.pdf"
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
        version_xml, version_metadata = _prepare_version_xml(xml, tei.doc_id, context.xml)
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
    # the handler can take a while: do not overwrite a replacement of the PDF made meanwhile
    current = repo.get_file_by_stable_id(pdf.stable_id)
    if current is None or current.id != pdf.id or jobs.find_active(pdf.stable_id) is not None:
        raise HTTPException(status_code=409, detail=PDF_CHANGED_MESSAGE)
    try:
        _, archived = repo.replace_pdf_content(pdf.stable_id, new_hash, len(content), file_metadata)
    except ValueError as e:
        logger.warning(f"Cannot replace {pdf.stable_id} with the corrected PDF: {e}")
        raise HTTPException(status_code=409, detail=PDF_CHANGED_MESSAGE)
    archived_stable_id = archived.stable_id if archived else None

    # The new version is based on the corrected PDF (pdf_stable_id None). It is created before the
    # response is sent, so that a lost response leaves a consistent state
    try:
        version = await create_tei_version(
            xml_string=version_xml,
            doc_id=tei.doc_id,
            variant=tei.variant,
            label=version_metadata["label"],
            status=version_metadata["status"],
            last_revision=version_metadata["last_revision"],
            parent_stable_id=tei.stable_id,
            pdf_stable_id=None,
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
    logger.info(f"Wrote {len(plan.corrections)} text correction(s) of {tei.stable_id} into {pdf.stable_id}: {pdf.id[:8]} -> {new_hash[:8]}, new version {version.file.stable_id}" + (f", original archived as {archived_stable_id}" if archived_stable_id else ""))
    return TextCorrectionsResult(
        xml=version_xml,
        tei_stable_id=version.file.stable_id,
        pdf_stable_id=pdf.stable_id,
        archived_stable_id=archived_stable_id,
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

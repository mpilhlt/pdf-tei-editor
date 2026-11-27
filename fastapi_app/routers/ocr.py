"""
OCR API router.

Endpoints:
- GET  /api/v1/ocr/engines                  - List available OCR engines
- GET  /api/v1/ocr/text-quality/{stable_id} - Assess the text layer of a PDF
- POST /api/v1/ocr                          - Submit a job that applies OCR to a PDF (job type `ocr`)
- POST /api/v1/ocr/llm-correction           - Submit a job that corrects the OCR errors of a PDF with an LLM (job type `ocr.llm-correction`)
- POST /api/v1/ocr/text-corrections/preview - What writing a TEI's text corrections into the PDF would do
- POST /api/v1/ocr/text-corrections/apply   - Write a TEI's text corrections into the PDF's OCR text layer
- POST /api/v1/ocr/llm-review/plan          - Number of page windows of the LLM review of OCR errors
- POST /api/v1/ocr/llm-review               - LLM review of one page window for OCR errors

The OCR runs are jobs (`fastapi_app/lib/ocr/job_types.py`); their status, progress, result and
cancel are those of the job API under `/api/v1/jobs`.
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
from fastapi_jobqueue import Job, JobManager
from lxml import etree
from pypdf.errors import PdfReadError

from ..config import get_settings
from ..lib.core.dependencies import get_file_repository, get_file_storage, get_session_manager, get_sse_service, require_authenticated_user, require_reviewer_or_admin, require_session_id
from ..lib.core.locking import check_lock
from ..lib.core.sessions import SessionManager
from ..lib.jobs import get_job_manager
from ..lib.jobs.hooks import JOB_LOCK_HOLDER_PREFIX
from ..lib.models import FileMetadata, FileUpdate
from ..lib.models.models_ocr import (
    OcrEngineInfo,
    OcrOptionInfo,
    OcrLlmCorrectionRequest,
    OcrRequest,
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
from ..lib.llm.http_errors import llm_http_error
from ..lib.llm.model_access import check_model_access
from ..lib.ocr.base import OcrEngine
from ..lib.ocr.cancel_requests import CancelRequests
from ..lib.ocr.job_types import (
    LLM_CORRECTION_JOB_TYPE,
    OCR_JOB_TYPE,
    OcrJobParams,
    OcrLlmCorrectionJobParams,
    checked_llm_correction,
    get_engine,
    get_pdf as _get_pdf,
    llm_provider as _llm_provider,
    pdf_path as _pdf_path,
    submit_ocr_job,
    validate_languages,
    validate_options,
)
from ..lib.ocr.languages import normalize_ocr_language
from ..lib.ocr.layout_check import apply_layout_check, check_text_layout
from ..lib.ocr.llm_review import DEFAULT_MIN_LETTER_SIMILARITY, MIN_LETTER_SIMILARITY_KEY, MissingLayoutError, OcrReviewSource, prepare_source, review_window
from ..lib.ocr.provenance import OCR_METADATA_KEY, TEXT_CORRECTIONS_METADATA_KEY
from ..lib.ocr.registry import OcrEngineRegistry
from ..lib.ocr.text_corrections import CorrectedPdfHandler, CorrectedPdfMismatch, CorrectionPlan, WordCorrection, derive_corrections, get_corrected_pdf_handler, tei_words
from ..lib.ocr.text_layer import PageCallback, WordPatch, patch_text_layer, read_text_layer
from ..lib.ocr.text_quality import analyze_text_layer
from ..lib.permissions.access_control import check_file_access
from ..lib.repository.file_repository import FileRepository
from ..lib.services.tei_versions import create_tei_version, emit_document_saved, version_collections
from ..lib.sse.sse_service import SSEService
from ..lib.sse.sse_utils import ProgressBar, broadcast_to_other_sessions
from ..lib.storage.file_storage import FileStorage
from ..lib.tei.zone_lines import window_range
from ..lib.tei.layout import MISSING_LAYOUT_MESSAGE, LineLayout, get_line_layout
from ..lib.utils.config_utils import get_config
from ..lib.utils.hash_utils import generate_file_hash
from ..lib.utils.revision_hash import stamp_revision_hashes
from ..lib.utils.tei_utils import add_revision_change, extract_processing_instructions, extract_tei_metadata, serialize_tei_with_formatted_header, update_fileref_in_xml
from ..lib.utils.xml_utils import apply_entity_encoding_from_config
from ..lib.utils.logging_utils import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/ocr", tags=["ocr"])

# OCR_METADATA_KEY: the last OCR run of a PDF; TEXT_CORRECTIONS_METADATA_KEY: the text corrections
# written into it (keys of the PDF's file_metadata, see lib/ocr/provenance.py)

PAGE_PROGRESS_INTERVAL_SECONDS = 0.2
"""Least time between two page reports of the text corrections to the client."""


def get_text_corrections_cancels() -> CancelRequests:
    """Return the cancel requests of previewing or writing text corrections, shared by all worker processes."""
    return CancelRequests(get_settings().tmp_dir / "text-corrections-cancel")


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


@router.post("", response_model=Job, status_code=202)
async def apply_ocr(
    request: OcrRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    manager: JobManager = Depends(get_job_manager),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> Job:
    """
    Submit a job (type `ocr`) that applies OCR to a PDF and stores the result as a new PDF of the
    document (#944).

    OCR of a long document can take longer than a reverse proxy waits for a response, so the run
    is a job: the response is the job, whose status, progress and result (an `OcrResponse`) the job
    API reports (`GET /api/v1/jobs/{job_id}`, the job events) and which it cancels
    (`POST /api/v1/jobs/{job_id}/cancel`; the PDF then stays unchanged). Invalid requests are
    rejected at once.

    Only one OCR run happens at a time on the server; the job has the status 'queued' while it
    waits for other runs. The job holds the lock of the PDF, so a request for a PDF that another
    job (or a user) holds is rejected with 409.

    The OCR run, including the method the engine used, is recorded in the file metadata of the new
    PDF under "ocr".

    With `llm_correction`, an LLM corrects OCR errors of the new text layer after the OCR result is
    stored; the corrections are recorded under "text_corrections". The provider and the model are
    checked before the run: 404 for an unknown provider, 428 if the provider needs a secret of the
    user, 403 if the user may not use the model. A failure of the correction pass keeps the OCR
    result and is reported in `llm_correction_error`; cancelling the job during the pass keeps it
    too (`llm_correction_cancelled`, status 'done').
    """
    file = _get_pdf(repo, request.stable_id, current_user, "edit")
    engine = get_engine(request.engine)
    languages = validate_languages(engine, request.languages)
    options = validate_options(engine, request.options)
    _pdf_path(storage, file)
    if request.llm_correction and request.provider_id and request.model_id:
        checked_llm_correction(request.provider_id, request.model_id, current_user)
    params = OcrJobParams.model_validate({**request.model_dump(), "languages": languages, "options": options})
    return await submit_ocr_job(manager, OCR_JOB_TYPE, params, current_user)


@router.post("/llm-correction", response_model=Job, status_code=202)
async def correct_ocr_errors(
    request: OcrLlmCorrectionRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    manager: JobManager = Depends(get_job_manager),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> Job:
    """
    Submit a job (type `ocr.llm-correction`) that corrects the OCR errors of the text layer of a
    stored PDF with an LLM, e.g. after the correction pass of an OCR run was cancelled. This is the
    correction pass of `POST /api/v1/ocr` without the text recognition: the same pages are reviewed
    and the corrections are written into the text layer and recorded under "text_corrections".

    The run is a job like an OCR run (cancelling it leaves the PDF unchanged), which holds the lock
    of the PDF: a PDF that another job holds is rejected with 409. The provider and the model are
    checked first: 404 for an unknown provider, 428 if the provider needs a secret of the user, 403
    if the user may not use the model. A failure of the pass is reported in `llm_correction_error`
    of the result.
    """
    file = _get_pdf(repo, request.stable_id, current_user, "edit")
    _pdf_path(storage, file)
    checked_llm_correction(request.provider_id, request.model_id, current_user)
    params = OcrLlmCorrectionJobParams.model_validate(request.model_dump())
    return await submit_ocr_job(manager, LLM_CORRECTION_JOB_TYPE, params, current_user)


# --- Text corrections (#931) ------------------------------------------------------------------

UNSUPPORTED_DOCUMENT_MESSAGE = "Text corrections cannot be written for this kind of document."
OCR_RUNNING_MESSAGE = "Text recognition is running for the PDF of this document. Please wait until it is finished."
NO_CORRECTIONS_MESSAGE = "The document has no text corrections to write."
LOCKED_MESSAGE = "This document is being edited in another session. Text corrections can only be written by the session that edits it."
NO_PAGE_CORRECTIONS_MESSAGE = "There are no text corrections to write on these pages."
FROZEN_MESSAGE = "This version is superseded by a newer version and cannot be changed. Save a new version to edit it."
UNWRITABLE_MESSAGE = "Some differences between the document and the text layer cannot be written. Skip them to write the other corrections."
CANCELLED_MESSAGE = "Writing the text corrections was cancelled. The PDF and the document are unchanged."
CANCELLED_CODE = "cancelled"


@dataclass
class _CorrectionContext:
    """A TEI document whose text corrections can be written into its PDF, with the corrections."""

    tei: FileMetadata
    xml: str
    pdf: FileMetadata
    pdf_path: Path
    handler: CorrectedPdfHandler
    plan: CorrectionPlan
    update_pending: bool


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


class _CorrectionsCancelled(Exception):
    """The user cancelled previewing or writing text corrections (see cancel_text_corrections())."""


def _cancelled_error() -> HTTPException:
    """The response to a cancelled request; `code` tells the client that it was cancelled."""
    return HTTPException(status_code=409, detail={"code": CANCELLED_CODE, "message": CANCELLED_MESSAGE})


class _CorrectionProgress:
    """
    Shows the steps of previewing or writing text corrections in a progress widget of the client
    (via SSE), if the request names one. The client shows and hides the widget.

    Used as a context manager: a request that names a progress widget can then be cancelled with
    `POST /ocr/text-corrections/cancel/{progress_id}`. Each step and each page report checks
    whether it was, and raises `_CorrectionsCancelled` if so. A request therefore stops at the
    next step or page, and only reports a step before it changes the PDF or the document, never
    while it does.
    """

    def __init__(self, sse_service: SSEService, session_id: str, progress_id: str | None, cancels: CancelRequests | None = None) -> None:
        self._bar = ProgressBar(sse_service, session_id, progress_id) if progress_id else None
        self._last_page_report = 0.0
        self._session_id = session_id
        self._progress_id = progress_id
        self._cancels = cancels if progress_id else None

    def __enter__(self) -> "_CorrectionProgress":
        # a request left over from an earlier run with the same widget does not apply
        if self._cancels is not None and self._progress_id is not None:
            self._cancels.clear(self._session_id, self._progress_id)
        return self

    def __exit__(self, *_exc: object) -> None:
        if self._cancels is not None and self._progress_id is not None:
            self._cancels.clear(self._session_id, self._progress_id)

    def check_cancelled(self) -> None:
        """
        Raises:
            _CorrectionsCancelled: if the user cancelled the request
        """
        if self._cancels is not None and self._progress_id is not None and self._cancels.is_requested(self._session_id, self._progress_id):
            raise _CorrectionsCancelled()

    def step(self, label: str) -> None:
        """
        Show a step whose duration is unknown.

        Raises:
            _CorrectionsCancelled: if the user cancelled the request
        """
        self.check_cancelled()
        if self._bar is None:
            return
        self._bar.set_label(label)
        self._bar.set_value(None)

    def pages(self, label: str) -> PageCallback:
        """
        Return a callback that shows the pages done of a step (called from a worker thread). The
        callback raises `_CorrectionsCancelled` if the user cancelled the request.
        """
        def report(done: int, total: int) -> None:
            self.check_cancelled()
            if self._bar is None:
                return
            now = time.monotonic()
            if done < total and now - self._last_page_report < PAGE_PROGRESS_INTERVAL_SECONDS:
                return
            self._last_page_report = now
            self._bar.set_label(f"{label}: page {done} of {total}")
            self._bar.set_value(round(done / total * 100) if total else None)
        return report


def _derive_plan(xml: str, variant_id: str, layout: LineLayout, pdf_path: Path, progress: _CorrectionProgress, pages: list[int] | None = None) -> CorrectionPlan:
    """Compare the TEI's words with the PDF's text layer, of all pages or only of the given ones (blocking)."""
    page_set = set(pages) if pages is not None else None
    words = tei_words(xml, variant_id, layout, page_set)
    with pikepdf.open(pdf_path) as pdf:
        layer = read_text_layer(pdf, progress.pages("Reading the text layer of the PDF"), page_set)
    return derive_corrections(words, layer, progress.pages("Comparing the document with the text layer"))


def _job_holds(stable_id: str, session_id: str) -> bool:
    """Whether a job (e.g. text recognition) holds the lock of the file, see `fastapi_app/lib/jobs/hooks.py`."""
    lock = check_lock(stable_id, session_id, get_settings().db_dir, logger)
    return lock["is_locked"] and (lock["locked_by"] or "").startswith(JOB_LOCK_HOLDER_PREFIX)


def _update_pending(pdf: FileMetadata) -> bool:
    """
    True if the PDF was made by writing the text corrections of some pages (`pages` in its last
    text-corrections record), which does not update the document for the corrected PDF (the
    corrected-PDF handler is not called).
    """
    records = pdf.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []
    return bool(records) and isinstance(records[-1], dict) and records[-1].get("pages") is not None


async def _correction_context(stable_id: str, repo: FileRepository, storage: FileStorage, user: dict[str, Any], session_id: str, progress: _CorrectionProgress, pages: list[int] | None = None) -> _CorrectionContext:
    """
    Check the preconditions of writing a TEI's text corrections into its PDF and derive them, of
    all pages or only of the given ones (0-based).

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
    if _job_holds(pdf.stable_id, session_id):
        raise HTTPException(status_code=409, detail=OCR_RUNNING_MESSAGE)
    pdf_path = _pdf_path(storage, pdf)
    try:
        plan = await asyncio.to_thread(_derive_plan, xml, tei.variant, layout, pdf_path, progress, pages)
    except ValueError as e:
        # the variant has no zone labels
        logger.debug(f"Cannot derive text corrections for {stable_id}: {e}")
        raise HTTPException(status_code=409, detail=UNSUPPORTED_DOCUMENT_MESSAGE)
    except pikepdf.PdfError as e:
        raise HTTPException(status_code=422, detail=f"The PDF cannot be read: {e}")
    return _CorrectionContext(tei, xml, pdf, pdf_path, handler, plan, _update_pending(pdf))


def _corrections_record(plan: CorrectionPlan, tei: FileMetadata, user: dict[str, Any], pages: list[int] | None) -> dict[str, Any]:
    """
    The record of writing text corrections that is added to the file metadata of the corrected
    PDF (`TEXT_CORRECTIONS_METADATA_KEY`). `pages` (0-based) is set if only the corrections of
    these pages were written, without updating the document for the corrected PDF.
    """
    record: dict[str, Any] = {
        "applied_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "applied_by": str(user.get("username") or ""),
        "tei_stable_id": tei.stable_id,
        "corrections": [{"page": c.page, "line": c.line, "old": c.old, "new": c.new} for c in plan.corrections],
    }
    if pages is not None:
        record["pages"] = pages
    return record


def _pending_lines(pdf: FileMetadata) -> frozenset[int]:
    """The lines corrected by the page-scoped writes that made the PDF since the document was last updated for its PDF."""
    lines: set[int] = set()
    for record in reversed(pdf.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []):
        if not isinstance(record, dict) or record.get("pages") is None:
            break
        lines.update(c["line"] for c in record.get("corrections") or [] if isinstance(c, dict) and isinstance(c.get("line"), int))
    return frozenset(lines)


async def _apply_page_corrections(
    context: _CorrectionContext,
    request: TextCorrectionsRequest,
    repo: FileRepository,
    storage: FileStorage,
    user: dict[str, Any],
    session_id: str,
    progress: _CorrectionProgress,
    sse_service: SSEService,
    session_manager: SessionManager,
) -> TextCorrectionsResult:
    """
    Write the text corrections of the requested pages into a copy of the PDF and attach the given
    version to it, recording the write in its revision history (see apply_text_corrections()).
    """
    plan, pdf, tei = context.plan, context.pdf, context.tei
    pages = sorted(set(request.pages or []))
    if repo.is_frozen(tei.stable_id):
        raise HTTPException(status_code=409, detail=FROZEN_MESSAGE)
    if not plan.corrections:
        raise HTTPException(status_code=409, detail=NO_PAGE_CORRECTIONS_MESSAGE)
    if plan.unwritable and not request.skip_unwritable:
        raise HTTPException(status_code=409, detail=UNWRITABLE_MESSAGE)
    try:
        xml, metadata = _record_page_corrections(context.xml, user, len(plan.corrections), pages)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    with tempfile.TemporaryDirectory(prefix="pte-text-corrections-") as tmp:
        output_path = Path(tmp) / "corrected.pdf"
        progress.step(f"Writing {len(plan.corrections)} correction{'' if len(plan.corrections) == 1 else 's'} into the PDF")
        try:
            await asyncio.to_thread(_patch_pdf, context.pdf_path, output_path, plan.corrections)
        except (ValueError, pikepdf.PdfError) as e:
            logger.warning(f"Cannot write text corrections into {pdf.stable_id}: {e}")
            raise HTTPException(status_code=422, detail=f"The text layer of the PDF cannot be changed: {e}")
        content = output_path.read_bytes()
    # the last point at which the request can be cancelled: nothing has been stored yet
    progress.step("Saving the document")
    new_hash, _ = storage.save_file(content, "pdf", increment_ref=False)
    if new_hash == pdf.id:
        raise HTTPException(status_code=409, detail=NO_PAGE_CORRECTIONS_MESSAGE)

    previous = pdf.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []
    file_metadata = {**pdf.file_metadata, TEXT_CORRECTIONS_METADATA_KEY: [*previous, _corrections_record(plan, tei, user, pages)]}
    corrected_pdf = repo.create_pdf_version(pdf.stable_id, new_hash, len(content), file_metadata, created_by=str(user.get("username") or "") or None)
    xml_bytes = xml.encode("utf-8")
    tei_hash, _ = storage.save_file(xml_bytes, "tei", increment_ref=False)
    repo.update_file(
        tei.id,
        FileUpdate(
            id=tei_hash,
            file_size=len(xml_bytes),
            status=metadata["status"],
            last_revision=metadata["last_revision"],
            pdf_stable_id=corrected_pdf.stable_id,
        ),
        stable_id=tei.stable_id,
    )
    broadcast_to_other_sessions(
        sse_service=sse_service,
        session_manager=session_manager,
        current_session_id=session_id,
        event_type="fileDataChanged",
        data={"reason": "file_saved", "stable_id": tei.stable_id},
        logger=logger,
    )
    await emit_document_saved(tei.stable_id, tei.doc_id, user)
    logger.info(f"Wrote {len(plan.corrections)} text correction(s) on pages {pages} of {tei.stable_id} into a copy of {pdf.stable_id}: new PDF {corrected_pdf.stable_id} ({pdf.id[:8]} -> {new_hash[:8]}), version attached to it")
    return TextCorrectionsResult(
        xml=xml,
        tei_stable_id=tei.stable_id,
        pdf_stable_id=corrected_pdf.stable_id,
        source_pdf_stable_id=pdf.stable_id,
        corrections=len(plan.corrections),
        new_version=False,
    )


def _patch_pdf(source: Path, target: Path, corrections: list[WordCorrection]) -> None:
    """Write the corrections into the text layer of a copy of the PDF (blocking)."""
    with pikepdf.open(source) as pdf:
        patch_text_layer(pdf, [WordPatch(c.word, c.new) for c in corrections])
        pdf.save(target)


TEXT_CORRECTIONS_LABEL = "Corrected text layer"
"""Label of a version created by writing text corrections into the PDF."""


def _text_corrections_desc(count: int) -> str:
    """The description of the revision change of a version created by writing text corrections into the PDF."""
    if count == 0:
        return "Updated the document for the text corrections written into the text layer of its PDF page by page"
    return f"Wrote {count} text correction{'' if count == 1 else 's'} into the text layer of a new PDF and attached this version to it"


def _page_corrections_desc(count: int, pages: list[int]) -> str:
    """The description of the revision change that records writing the text corrections of some pages (0-based) into the PDF."""
    numbers = ", ".join(str(p + 1) for p in pages)
    return f"Wrote {count} text correction{'' if count == 1 else 's'} on page{'' if len(pages) == 1 else 's'} {numbers} into the text layer of a new PDF and attached this version to it"


def _record_page_corrections(xml: str, user: dict[str, Any], count: int, pages: list[int]) -> tuple[str, dict[str, str | None]]:
    """
    Record writing the text corrections of some pages in the revision history of a TEI document
    that stays the same version: an unlabelled change by the user with the status of the last
    change ("draft" if there is none). The entity encoding is applied as the save route does.

    Returns:
        The XML and its status and last_revision

    Raises:
        ValueError: if the XML is not well-formed or has no teiHeader
    """
    try:
        root = etree.fromstring(xml.encode("utf-8"))
    except etree.XMLSyntaxError as e:
        raise ValueError(f"The document is not well-formed XML: {e}") from e
    username = str(user.get("username") or "") or "unknown"
    has_file_desc = root.find("tei:teiHeader/tei:fileDesc", {"tei": "http://www.tei-c.org/ns/1.0"}) is not None
    add_revision_change(
        root,
        when=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        status=str(extract_tei_metadata(root).get("status") or "draft"),
        who=username,
        desc=_page_corrections_desc(count, pages),
        full_name=(str(user.get("fullname") or "") or None) if has_file_desc else None,
    )
    updated = serialize_tei_with_formatted_header(root, extract_processing_instructions(xml))
    metadata = extract_tei_metadata(root)
    updated = stamp_revision_hashes(apply_entity_encoding_from_config(updated), xml)
    return updated, {"status": metadata.get("status"), "last_revision": metadata.get("last_revision")}


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
    current_user: dict[str, Any] = Depends(require_reviewer_or_admin),
    session_id: str = Depends(require_session_id),
    sse_service: SSEService = Depends(get_sse_service),
    cancels: CancelRequests = Depends(get_text_corrections_cancels),
) -> TextCorrectionsPreview:
    """
    Show what writing the text corrections of a TEI document into the OCR text layer of its PDF
    would do: the words that would be corrected and the differences that cannot be written.

    If the corrections cannot be written, `reason` says why and the lists are empty, except when
    there are no corrections: then `unwritable` is filled, since the unwritable differences explain
    why. This includes a lock of the TEI held by another session.
    A missing TEI file or missing access is reported with 404/403 as usual.

    If `progress_id` is given, the steps are shown in that progress widget of the client, and the
    preview can be cancelled with `POST /ocr/text-corrections/cancel/{progress_id}`: it then
    stops at the next page and is answered with 409 and the detail `{"code": "cancelled", ...}`.
    """
    progress = _CorrectionProgress(sse_service, session_id, request.progress_id, cancels)
    with progress:
        try:
            context = await _correction_context(request.stable_id, repo, storage, current_user, session_id, progress, request.pages)
        except HTTPException as e:
            if e.status_code not in (409, 423):
                raise
            return TextCorrectionsPreview(reason=str(e.detail))
        except _CorrectionsCancelled:
            logger.info(f"Preview of the text corrections of {request.stable_id} was cancelled")
            raise _cancelled_error()
    # writing the whole document updates it for corrections written page by page before
    update_pending = request.pages is None and context.update_pending
    return TextCorrectionsPreview(
        corrections=[TextCorrectionItem(page=c.page, line=c.line, old=c.old, new=c.new) for c in context.plan.corrections],
        unwritable=[UnwritableItem(page=u.page, line=u.line, layer_text=u.layer_text, tei_text=u.tei_text, reason=u.reason) for u in context.plan.unwritable],
        # the unwritable differences explain why there is nothing to write
        reason=None if context.plan.corrections or update_pending else (NO_CORRECTIONS_MESSAGE if request.pages is None else NO_PAGE_CORRECTIONS_MESSAGE),
        update_pending=update_pending,
    )


@router.post("/text-corrections/apply", response_model=TextCorrectionsResult)
async def apply_text_corrections(
    request: TextCorrectionsRequest,
    http_request: Request,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict[str, Any] = Depends(require_reviewer_or_admin),
    session_id: str = Depends(require_session_id),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
    cancels: CancelRequests = Depends(get_text_corrections_cancels),
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

    With `pages`, only the corrections on these pages are written, and quickly: the version is not
    copied but attached to the corrected PDF, and its revision history records the write in an
    unlabelled change. The extractor plugin is not called, so the document keeps the data of the
    previous PDF (such as GROBID's feature file; the positions of the lines do not change). The
    corrected PDF records this (`pages` in its text-corrections record), and the next write of
    the whole document updates the document for it, also when no corrections are left: the
    preview then reports `update_pending`. Refused with 409 if the version is frozen.

    If `progress_id` is given, the steps are shown in that progress widget of the client, and the
    write can be cancelled with `POST /ocr/text-corrections/cancel/{progress_id}`. It then stops
    at the next page or step and is answered with 409 and the detail `{"code": "cancelled", ...}`;
    no PDF and no version is created. Cancelling has no effect once the corrected PDF is stored
    (whole document: after the extractor plugin is finished; pages: after the PDF is written).
    """
    progress = _CorrectionProgress(sse_service, session_id, request.progress_id, cancels)
    with progress:
        try:
            return await _apply_text_corrections(request, http_request, repo, storage, current_user, session_id, sse_service, session_manager, progress)
        except _CorrectionsCancelled:
            logger.info(f"Writing the text corrections of {request.stable_id} was cancelled")
            raise _cancelled_error()


@router.post("/text-corrections/cancel/{progress_id}")
async def cancel_text_corrections(
    progress_id: str,
    current_user: dict[str, Any] = Depends(require_reviewer_or_admin),
    session_id: str = Depends(require_session_id),
    cancels: CancelRequests = Depends(get_text_corrections_cancels),
) -> dict[str, bool]:
    """
    Cancel the preview or the write of text corrections of this session that reports its steps to
    the progress widget `progress_id`. The request stops at its next page or step and is answered
    with 409 and the detail `{"code": "cancelled", ...}`; the PDF and the document stay unchanged.
    If it is already past the point where it stores its result, it finishes as usual.
    Answered with `{"requested": true}`.
    """
    cancels.request(session_id, progress_id)
    return {"requested": True}


async def _apply_text_corrections(
    request: TextCorrectionsRequest,
    http_request: Request,
    repo: FileRepository,
    storage: FileStorage,
    current_user: dict[str, Any],
    session_id: str,
    sse_service: SSEService,
    session_manager: SessionManager,
    progress: _CorrectionProgress,
) -> TextCorrectionsResult:
    """
    Write the text corrections (see apply_text_corrections()).

    Raises:
        _CorrectionsCancelled: if the user cancelled the write before anything was stored
    """
    settings = get_settings()
    context = await _correction_context(request.stable_id, repo, storage, current_user, session_id, progress, request.pages)
    if request.pages is not None:
        return await _apply_page_corrections(context, request, repo, storage, current_user, session_id, progress, sse_service, session_manager)
    plan, pdf, tei = context.plan, context.pdf, context.tei
    # only the document is updated for the corrections written page by page before
    update_only = not plan.corrections and context.update_pending
    if not plan.corrections and not update_only:
        raise HTTPException(status_code=409, detail=NO_CORRECTIONS_MESSAGE)
    if plan.unwritable and not request.skip_unwritable:
        raise HTTPException(status_code=409, detail=UNWRITABLE_MESSAGE)
    # refuse before anything is changed if the user cannot create the new version
    version_collections(repo, tei.doc_id, current_user, settings.db_dir, logger)

    if update_only:
        new_hash, new_path = pdf.id, context.pdf_path
        content_size = pdf.file_size
        new_file = False
    else:
        with tempfile.TemporaryDirectory(prefix="pte-text-corrections-") as tmp:
            output_path = Path(tmp) / "corrected.pdf"
            progress.step(f"Writing {len(plan.corrections)} correction{'' if len(plan.corrections) == 1 else 's'} into the PDF")
            try:
                await asyncio.to_thread(_patch_pdf, context.pdf_path, output_path, plan.corrections)
            except (ValueError, pikepdf.PdfError) as e:
                logger.warning(f"Cannot write text corrections into {pdf.stable_id}: {e}")
                raise HTTPException(status_code=422, detail=f"The text layer of the PDF cannot be changed: {e}")
            content = output_path.read_bytes()
        progress.check_cancelled()
        # the extractor plugin reads the corrected PDF from the storage; if the write is
        # cancelled, a file stored only for it is removed again
        new_file = not storage.file_exists(generate_file_hash(content), "pdf")
        new_hash, new_path = storage.save_file(content, "pdf", increment_ref=False)
        content_size = len(content)
        if new_hash == pdf.id:
            raise HTTPException(status_code=409, detail=NO_CORRECTIONS_MESSAGE)

    # the lines corrected page by page since the document was last updated for its PDF
    corrected_lines = frozenset(c.line for c in plan.corrections) | _pending_lines(pdf)
    try:
        progress.step("Updating the document for the corrected PDF. This can take a minute.")
        xml = await asyncio.to_thread(context.handler, context.xml, tei.doc_id, new_path, new_hash, corrected_lines)
        # the plugin cannot be interrupted; the last point at which the write can be cancelled
        progress.step("Saving the new version of the document")
    except _CorrectionsCancelled:
        if new_file:
            storage.delete_file(new_hash, "pdf", decrement_ref=False)
        raise
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

    record = _corrections_record(plan, tei, current_user, None)
    previous = pdf.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []
    file_metadata = {**pdf.file_metadata, TEXT_CORRECTIONS_METADATA_KEY: [*previous, record]}
    if update_only:
        # the PDF is unchanged; its record is added once the new version exists
        corrected_pdf = pdf
    else:
        # the corrected PDF is a new PDF of the document; the version given stays attached to its PDF
        corrected_pdf = repo.create_pdf_version(pdf.stable_id, new_hash, content_size, file_metadata, created_by=str(current_user.get("username") or "") or None)

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
    if update_only:
        # the record says that the document was updated for the PDF
        repo.update_file(pdf.id, FileUpdate(file_metadata=file_metadata), stable_id=pdf.stable_id)
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
    """
    Report how many page windows `/ocr/llm-review` needs for the given document content and
    which pages they cover (no LLM call). With a scope, these are the pages of the node, which
    `/ocr/text-corrections/apply` takes to write the corrections of the node.
    """
    tei = _get_tei(repo, body.stable_id, current_user)
    source = await asyncio.to_thread(_review_source, tei, body.xml, body.scope)
    pages = sorted({page.number - 1 for window in source.windows for page in window})
    return OcrReviewPlanResponse(window_count=len(source.windows), pages=pages)


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

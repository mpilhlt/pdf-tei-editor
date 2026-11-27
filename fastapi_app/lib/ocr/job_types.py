"""
OCR runs as jobs (see docs/code-assistant/jobs.md): the job types `ocr` (text recognition with an
optional LLM correction pass) and `ocr.llm-correction` (the correction pass alone on a stored PDF),
and the checks that `routers/ocr.py` also makes before it submits them.

Both job types hold the lock of their PDF (resource `file:<stable_id>`), so that no second run and
no text correction (#931) changes the PDF meanwhile. Only one text recognition runs at a time on
the server (`max_concurrent=1`); further jobs wait as `queued`.

A run is cancelled through the progress reports of the engine and of the correction pass (see
`progress.py`). Cancelling during text recognition leaves the PDF unchanged. The OCR result is
stored before the LLM correction pass starts, so cancelling the pass keeps it; the job then ends
`done` with `llm_correction_cancelled`.
"""

import asyncio
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from fastapi_jobqueue import Job, JobContext, JobManager, ResourceBusy
from fastapi_jobqueue.errors import JobCancelled

from fastapi_app.lib.core.dependencies import get_db, get_file_storage
from fastapi_app.lib.jobs import job_type, job_user, register_client_type
from fastapi_app.lib.llm import LLMProvider, LLMProviderRegistry
from fastapi_app.lib.llm.http_errors import llm_http_error
from fastapi_app.lib.llm.model_access import check_model_access
from fastapi_app.lib.models import FileMetadata, FileUpdate
from fastapi_app.lib.models.models_ocr import OcrLlmCorrection, OcrLlmCorrectionRequest, OcrRequest, OcrResponse
from fastapi_app.lib.ocr import llm_correction
from fastapi_app.lib.ocr.base import OcrEngine, OcrOptionValue, OcrResult
from fastapi_app.lib.ocr.languages import normalize_ocr_language
from fastapi_app.lib.ocr.progress import ProgressReport, progress_reporter
from fastapi_app.lib.ocr.provenance import OCR_METADATA_KEY, TEXT_CORRECTIONS_METADATA_KEY
from fastapi_app.lib.ocr.registry import OcrEngineRegistry
from fastapi_app.lib.ocr.text_quality import analyze_text_layer
from fastapi_app.lib.permissions.access_control import check_file_access
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.secrets import MissingSecretError, secret_required_detail
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.config_utils import get_config
from fastapi_app.lib.utils.logging_utils import get_logger

logger = get_logger(__name__)

OCR_JOB_TYPE = "ocr"
LLM_CORRECTION_JOB_TYPE = "ocr.llm-correction"
TEXT_CORRECTIONS_JOB_TYPE = "ocr.text-corrections"

OCR_BUSY_MESSAGE = "Text recognition is already running for this PDF"
"""The response (409) to a job for a PDF whose lock another job or a user holds."""


class OcrJobParams(OcrRequest):
    """Parameters of an `ocr` job: the request of `POST /api/v1/ocr`, with the checked languages and options."""


class OcrLlmCorrectionJobParams(OcrLlmCorrectionRequest):
    """Parameters of an `ocr.llm-correction` job: the request of `POST /api/v1/ocr/llm-correction`."""


class OcrJobError(Exception):
    """A failure of an OCR job, with the HTTP-like status that the job's error reports."""

    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class LlmCorrection:
    """The checked provider and model of an LLM correction pass."""

    provider: LLMProvider
    provider_id: str
    model_id: str


def _file_repository() -> FileRepository:
    """The file repository of the handlers, which run outside of a request."""
    return FileRepository(get_db())


def _file_storage() -> FileStorage:
    """The file storage of the handlers, which run outside of a request."""
    return get_file_storage()


# --- Checks, shared with the router ----------------------------------------------------------


def get_pdf(repo: FileRepository, stable_id: str, user: dict[str, Any], operation: str) -> FileMetadata:
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


def pdf_path(storage: FileStorage, file: FileMetadata) -> Path:
    """Return the storage path of a PDF, raising 404 if the file is missing."""
    path = storage.get_file_path(file.id, "pdf")
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail=f"PDF content not found: {file.stable_id}")
    return path


def get_engine(engine_id: str) -> OcrEngine:
    """
    The available OCR engine of this id.

    Raises:
        HTTPException: 400 if the engine is unknown or not available
    """
    try:
        engine = OcrEngineRegistry.get_instance().get_engine(engine_id)
    except KeyError:
        raise HTTPException(status_code=400, detail=f"Unknown OCR engine: {engine_id}")
    if not engine.is_available():
        raise HTTPException(status_code=400, detail=f"OCR engine '{engine.name}' is not available")
    return engine


def validate_options(engine: OcrEngine, options: dict[str, OcrOptionValue]) -> dict[str, OcrOptionValue]:
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


def validate_languages(engine: OcrEngine, languages: list[str]) -> list[str]:
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


def llm_provider(provider_id: str, user: dict[str, Any]) -> LLMProvider:
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


def check_llm_model(provider: LLMProvider, provider_id: str, model_id: str, user: dict[str, Any]) -> None:
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


def checked_llm_correction(provider_id: str, model_id: str, user: dict[str, Any]) -> LlmCorrection:
    """
    The provider and model of an LLM correction pass, after checking that the user may use them.

    Raises:
        HTTPException: 404 for an unknown provider, 428 if the provider needs a secret of the
            user, 403 if the user may not use the model
    """
    provider = llm_provider(provider_id, user)
    check_llm_model(provider, provider_id, model_id, user)
    return LlmCorrection(provider, provider_id, model_id)


async def submit_ocr_job(manager: JobManager, job_type_name: str, params: OcrJobParams | OcrLlmCorrectionJobParams, user: dict[str, Any]) -> Job:
    """
    Submit an OCR job of the user that holds the lock of its PDF.

    Raises:
        HTTPException: 409 if another job or a user holds the lock of the PDF
    """
    try:
        return await manager.submit(job_type_name, params, owner=user["username"], resources=[f"file:{params.stable_id}"])
    except ResourceBusy as e:
        logger.info(f"Refused {job_type_name} job for {params.stable_id}: {e}")
        raise HTTPException(status_code=409, detail=OCR_BUSY_MESSAGE) from e


# --- The run ---------------------------------------------------------------------------------


@contextmanager
def _job_errors(failure: str) -> Iterator[None]:
    """Turn the HTTP errors of the checks into job errors with their status, and other exceptions into failures."""
    try:
        yield
    except OcrJobError:
        raise
    except HTTPException as e:
        raise OcrJobError(str(e.detail), e.status_code) from e
    except Exception as e:
        raise OcrJobError(f"{failure}: {e}", 500) from e


def _uncancellable(ctx: JobContext) -> ProgressReport:
    """A progress reporter for the steps after the result is stored, which a cancel no longer stops."""
    def report(*, phase: str, done: int | None, total: int | None, unit: str | None, eta_seconds: int | None) -> None:
        try:
            ctx.report_threadsafe(phase=phase, done=done, total=total, unit=unit, eta_seconds=eta_seconds)
        except JobCancelled:
            pass
    return report


def _check_resource(ctx: JobContext, stable_id: str) -> None:
    """
    Raises:
        OcrJobError: 400 if the job does not hold the lock of its PDF (e.g. a job submitted through the job API without it)
    """
    if f"file:{stable_id}" not in ctx.job.resources:
        raise OcrJobError(f"The job must hold the resource file:{stable_id}", 400)


async def correct_with_llm(output_path: Path, llm: LlmCorrection, languages: list[str]) -> llm_correction.CorrectionRun:
    """Run the LLM correction pass on the OCR output in place; never raises an Exception, so that OCR cannot fail because of it."""
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


def llm_correction_message(run: llm_correction.CorrectionRun, model_id: str) -> str:
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


def _correction_record(run: llm_correction.CorrectionRun, llm: LlmCorrection, applied_at: str, applied_by: str, source: str) -> dict[str, str | list[dict[str, str | int]]]:
    """The record of the corrections of an LLM correction pass in the file metadata ("text_corrections")."""
    return {
        "applied_at": applied_at,
        "applied_by": applied_by,
        "source": source,
        "provider_id": llm.provider_id,
        "model_id": llm.model_id,
        "corrections": [{"page": c.page, "old": c.old, "new": c.new} for c in run.corrections],
    }


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


async def recognize_for_job(ctx: JobContext, params: OcrJobParams, user: dict[str, Any]) -> OcrResponse:
    """
    Apply OCR to a PDF and store the result as a new PDF of the document (#944); the versions
    attached to the PDF stay attached to it. The progress of the engine is reported to the job.

    The OCR result is stored before the LLM correction pass (`params.llm_correction`) starts, so
    that it is kept if the pass fails or is cancelled; the pass corrects the stored text layer and
    stores the result as a further PDF if it corrected anything.

    If the job is cancelled, OCR stops at the next progress report of the engine, or at the latest
    before its result is stored, and `JobCancelled` is raised. Once the OCR result is stored,
    cancelling stops only the LLM correction pass (`llm_correction_cancelled` in the response).

    Args:
        ctx: The context of the job that runs OCR (also of a job type other than `ocr`)
        params: The PDF, the engine and its parameters; checked again here
        user: The user the job runs for

    Raises:
        OcrJobError: if the PDF is gone, the parameters are invalid or the engine fails
        JobCancelled: if the job was cancelled before the OCR result was stored
    """
    with _job_errors("Text recognition failed"):
        return await _recognize(ctx, params, user)


async def _recognize(ctx: JobContext, params: OcrJobParams, user: dict[str, Any]) -> OcrResponse:
    """See recognize_for_job(); raises HTTPException for the errors of the checks."""
    repo, storage = _file_repository(), _file_storage()
    # look the PDF up again, since it may have changed while the job was queued
    file = get_pdf(repo, params.stable_id, user, "edit")
    engine = get_engine(params.engine)
    languages = validate_languages(engine, params.languages)
    options = validate_options(engine, params.options)
    llm: LlmCorrection | None = None
    if params.llm_correction and params.provider_id and params.model_id:
        llm = await asyncio.to_thread(checked_llm_correction, params.provider_id, params.model_id, user)
    input_path = pdf_path(storage, file)
    with tempfile.TemporaryDirectory(prefix="pte-ocr-") as tmp:
        output_path = Path(tmp) / "output.pdf"
        with progress_reporter(ctx.report_threadsafe, ctx.check_cancelled) as progress:
            try:
                # to_thread passes the progress reporter on to the worker thread
                outcome = await asyncio.to_thread(engine.recognize, input_path, output_path, languages, options, params.rebuild)
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
                with progress_reporter(ctx.report_threadsafe, ctx.check_cancelled):
                    run = await correct_with_llm(output_path, llm, languages)
            except JobCancelled:
                logger.info(f"LLM correction of {file.stable_id} was cancelled; the OCR result is kept")
                correction_cancelled = True
                note = f"The correction with {llm.model_id} was cancelled."
            else:
                if run.corrections:
                    correction_record = _correction_record(run, llm, applied_at, applied_by, "llm-after-ocr")
                    previous = file.file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY) or []
                    file_metadata = {**file_metadata, TEXT_CORRECTIONS_METADATA_KEY: [*previous, correction_record]}
                    result_pdf = _store_pdf(repo, storage, result_pdf, output_path.read_bytes(), file_metadata, user)
                note = llm_correction_message(run, llm.model_id)
            message = f"{message} {note}" if message else note

        # the result is stored: cancelling no longer applies
        with progress_reporter(_uncancellable(ctx)) as progress:
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


async def correct_for_job(ctx: JobContext, params: OcrLlmCorrectionJobParams, user: dict[str, Any]) -> OcrResponse:
    """
    Correct the OCR errors of the text layer of a stored PDF with an LLM and store the result as a
    new PDF of the document if anything was corrected (#944).

    Without `params.languages`, those of the last OCR run of the PDF are used.

    Raises:
        OcrJobError: if the PDF is gone or the provider or the model cannot be used
        JobCancelled: if the job was cancelled; the PDF is unchanged
    """
    with _job_errors("The correction failed"):
        return await _correct_stored_pdf(ctx, params, user)


async def _correct_stored_pdf(ctx: JobContext, params: OcrLlmCorrectionJobParams, user: dict[str, Any]) -> OcrResponse:
    """See correct_for_job(); raises HTTPException for the errors of the checks."""
    repo, storage = _file_repository(), _file_storage()
    file = get_pdf(repo, params.stable_id, user, "edit")
    llm = await asyncio.to_thread(checked_llm_correction, params.provider_id, params.model_id, user)
    input_path = pdf_path(storage, file)
    languages = params.languages
    ocr_record = file.file_metadata.get(OCR_METADATA_KEY)
    if not languages and isinstance(ocr_record, dict):
        recorded = ocr_record.get("languages")
        languages = [str(lang) for lang in recorded] if isinstance(recorded, list) else []
    with tempfile.TemporaryDirectory(prefix="pte-ocr-") as tmp:
        work_path = Path(tmp) / "corrected.pdf"
        work_path.write_bytes(input_path.read_bytes())
        with progress_reporter(ctx.report_threadsafe, ctx.check_cancelled) as progress:
            run = await correct_with_llm(work_path, llm, languages)
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
        with progress_reporter(_uncancellable(ctx)) as progress:
            progress.report("Checking the new text layer")
            quality = await asyncio.to_thread(analyze_text_layer, work_path)
    if isinstance(ocr_record, dict):
        quality.ocr_applied = ocr_record
    return OcrResponse(
        stable_id=result_pdf.stable_id,
        source_stable_id=file.stable_id,
        changed=result_pdf.stable_id != file.stable_id,
        message=llm_correction_message(run, llm.model_id),
        method=None,
        fallback_reason=None,
        quality=quality,
        llm_corrections=[OcrLlmCorrection(page=c.page, old=c.old, new=c.new, rationale=c.rationale) for c in run.corrections],
        llm_correction_error=run.error,
        llm_correction_cancelled=False,
    )


# --- Job types -------------------------------------------------------------------------------


@job_type(OCR_JOB_TYPE, title="Text recognition", roles=None, params_model=OcrJobParams, max_concurrent=1, resumable=False)
async def run_ocr(ctx: JobContext, params: OcrJobParams) -> dict[str, Any]:
    """Apply OCR to the PDF (see recognize_for_job()); the result is the `OcrResponse`."""
    _check_resource(ctx, params.stable_id)
    result = await recognize_for_job(ctx, params, job_user(ctx.job))
    return result.model_dump(mode="json")


@job_type(LLM_CORRECTION_JOB_TYPE, title="OCR correction", roles=None, params_model=OcrLlmCorrectionJobParams)
async def run_llm_correction(ctx: JobContext, params: OcrLlmCorrectionJobParams) -> dict[str, Any]:
    """Correct the OCR errors of the stored PDF with an LLM (see correct_for_job()); the result is the `OcrResponse`."""
    _check_resource(ctx, params.stable_id)
    result = await correct_for_job(ctx, params, job_user(ctx.job))
    return result.model_dump(mode="json")


# The client job of previewing or writing text corrections (`routers/ocr.py`). The route needs the
# user's session, so the client submits the job (`params: {stable_id, mode: "preview" | "apply"}`, no
# resources: the user's own session holds the TEI lock) and passes its id to the route, which drives it.
register_client_type(TEXT_CORRECTIONS_JOB_TYPE, title="Writing text corrections")

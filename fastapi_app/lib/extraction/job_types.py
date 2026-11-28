"""
Extraction as a job (see docs/code-assistant/jobs.md): the job type `extract`, which the UI submits
through `POST /api/v1/extract/job` (`routers/extraction.py`). The synchronous `POST /api/v1/extract`
runs the same extraction (`run.py`) without a job.

The job holds the lock of its source file (`file:<stable_id>`) if it is a PDF. With `ocr`, text
recognition is applied to the PDF first (step `ocr`, with the code of the `ocr` job), and the
extraction (step `extract`) extracts from the new PDF.

Cancelling during text recognition leaves the PDF unchanged and ends the job `cancelled`.
Cancelling after the result of text recognition is stored (during its LLM correction pass or the
extraction) keeps the new PDF and extracts nothing; the job then ends `done` with `cancelled` and the
`ocr` result. Without text recognition, cancelling stops the extraction before its result is saved.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi import HTTPException
from fastapi_jobqueue import Job, JobContext, JobManager, ResourceBusy
from fastapi_jobqueue.errors import JobCancelled
from pydantic import JsonValue

from fastapi_app.config import Settings, get_settings
from fastapi_app.lib.core.dependencies import get_db, get_file_storage
from fastapi_app.lib.extraction.run import _run_extraction, _validate_extraction, _ValidatedExtraction
from fastapi_app.lib.jobs import job_type, job_user
from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.lib.llm.default_model import get_default_model
from fastapi_app.lib.models.models_extraction import ExtractJobRequest, ExtractJobResult, ExtractRequest
from fastapi_app.lib.models.models_ocr import OcrResponse
from fastapi_app.lib.ocr.job_types import (
    OcrJobParams,
    checked_llm_correction,
    get_engine,
    get_pdf,
    recognize_for_job,
    validate_languages,
    validate_options,
)
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.secrets import MissingSecretError, secret_required_detail
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.logging_utils import get_logger

logger = get_logger(__name__)

EXTRACT_JOB_TYPE = "extract"

EXTRACT_BUSY_MESSAGE = "The PDF is in use by another job, e.g. text recognition or another extraction"
"""The response (409) to a job for a PDF whose lock another job or a user holds."""


class ExtractJobParams(ExtractRequest):
    """Parameters of an `extract` job: the request of `POST /api/v1/extract/job`, with the checked OCR run."""

    ocr: OcrJobParams | None = None
    """Text recognition before the extraction, with the checked languages and options."""
    base_url: str = ""
    """Base URL of the server, for extractors that put URLs into the result."""


class ExtractJobError(Exception):
    """A failure of an extraction job, with the HTTP-like status that the job's error reports."""

    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


def _file_repository() -> FileRepository:
    """The file repository of the handler, which runs outside of a request."""
    return FileRepository(get_db())


def _file_storage() -> FileStorage:
    """The file storage of the handler, which runs outside of a request."""
    return get_file_storage()


def _settings() -> Settings:
    """The settings of the handler, which runs outside of a request."""
    return get_settings()


# --- Checks and submit, used by the router ----------------------------------------------------


def checked_ocr_params(request: ExtractJobRequest, validated: _ValidatedExtraction, repo: FileRepository, user: dict[str, Any]) -> OcrJobParams | None:
    """
    The parameters of the text recognition of an extraction job, after the checks of
    `POST /api/v1/ocr`; None if none is requested or the extractor does not extract from the PDF.

    Raises:
        HTTPException: 400 if the OCR run is not for the PDF of the extraction or its parameters
            are invalid, 403/404 as `get_pdf()`, 404/428/403 if the LLM correction pass cannot use
            its provider or model
    """
    ocr = request.ocr
    if ocr is None or not validated.reads_pdf:
        return None
    if ocr.stable_id != validated.file.stable_id:
        raise HTTPException(status_code=400, detail="Text recognition must be applied to the PDF that is extracted from")
    get_pdf(repo, ocr.stable_id, user, "edit")
    engine = get_engine(ocr.engine)
    languages = validate_languages(engine, ocr.languages)
    options = validate_options(engine, ocr.options)
    if ocr.llm_correction and ocr.provider_id and ocr.model_id:
        checked_llm_correction(ocr.provider_id, ocr.model_id, user)
    return OcrJobParams.model_validate({**ocr.model_dump(), "languages": languages, "options": options})


def check_inference_key(validated: _ValidatedExtraction, request: ExtractRequest, user: dict[str, Any]) -> None:
    """
    For an extractor that runs on an LLM (`uses_inference_model`), check that the provider it will
    use (`provider_id` of the options, else the default model's) has a key for the user, so that
    the client can ask for a missing key before the job starts. Other problems with the provider
    are left to the extraction, which reports them.

    Raises:
        HTTPException: 428 (`secret_required`) if the provider needs a key the user has not stored
    """
    if not validated.extractor_info.get("uses_inference_model"):
        return
    provider_id = (request.options or {}).get("provider_id")
    if not provider_id:
        default = get_default_model()
        provider_id = default[0] if default else None
    if not provider_id:
        return
    try:
        LLMProviderRegistry.get_instance().get_provider_for_user(str(provider_id), user.get("username"))
    except MissingSecretError as e:
        raise HTTPException(status_code=428, detail=secret_required_detail(e)) from e
    except KeyError:
        pass  # reported by the extraction


async def submit_extract_job(manager: JobManager, params: ExtractJobParams, source: _ValidatedExtraction, user: dict[str, Any]) -> Job:
    """
    Submit an extraction job of the user. It holds the lock of its source file if that is a PDF;
    a TEI source is not locked, since the user who extracts from it usually edits it.

    Raises:
        HTTPException: 409 if another job or a user holds the lock of the PDF
    """
    resources = [f"file:{source.file.stable_id}"] if source.reads_pdf else []
    try:
        return await manager.submit(EXTRACT_JOB_TYPE, params, owner=user["username"], resources=resources)
    except ResourceBusy as e:
        logger.info(f"Refused extraction job for {source.file.stable_id}: {e}")
        raise HTTPException(status_code=409, detail=EXTRACT_BUSY_MESSAGE) from e


# --- The run ---------------------------------------------------------------------------------


@contextmanager
def _job_errors() -> Iterator[None]:
    """Turn the HTTP errors of the checks and the run into job errors with their status."""
    try:
        yield
    except HTTPException as e:
        detail = e.detail
        message = detail.get("message") if isinstance(detail, dict) else detail
        raise ExtractJobError(str(message), e.status_code) from e


async def _recognize(ctx: JobContext, params: OcrJobParams, user: dict[str, Any]) -> OcrResponse:
    """
    Step `ocr`: apply text recognition to the PDF, or return the saved result of the step.

    Raises:
        OcrJobError: if text recognition fails
        JobCancelled: if the job was cancelled before the result of text recognition was stored
    """
    if ctx.has_step("ocr"):
        return OcrResponse.model_validate(ctx.step("ocr"))
    # runs under the lock of the PDF that this job holds; recognize_for_job() does not lock
    result = await recognize_for_job(ctx, params, user)
    try:
        await ctx.save_step("ocr", result.model_dump(mode="json"))
    except JobCancelled:
        # the new PDF is stored: the caller notices the cancel when it goes on
        logger.info(f"Job {ctx.job_id} was cancelled after text recognition; the new PDF {result.stable_id} is kept")
    return result


@job_type(EXTRACT_JOB_TYPE, title="Extraction", roles=None, params_model=ExtractJobParams)
async def run_extract(ctx: JobContext, params: ExtractJobParams) -> dict[str, JsonValue]:
    """Run the extraction (with text recognition first if `params.ocr`); the result is the `ExtractJobResult`."""
    user = job_user(ctx.job)
    repo, storage, settings = _file_repository(), _file_storage(), _settings()
    request = ExtractRequest(extractor=params.extractor, file_id=params.file_id, options=params.options)
    ocr_result: OcrResponse | None = None
    with _job_errors():
        if params.ocr is not None:
            # look the source up again, since it may have changed while the job was queued
            source = _validate_extraction(request, repo, user)
            if source.reads_pdf:
                if f"file:{source.file.stable_id}" not in ctx.job.resources:
                    # e.g. a job submitted through the job API without the lock of its PDF
                    raise ExtractJobError(f"The job must hold the resource file:{source.file.stable_id}", 400)
                ocr_result = await _recognize(ctx, params.ocr, user)
                if ocr_result.llm_correction_cancelled:
                    return _ocr_only(ocr_result).model_dump(mode="json")
                # extract from the new PDF, which the new version is attached to
                request = request.model_copy(update={"file_id": ocr_result.stable_id})
        if ctx.has_step("extract"):
            return ExtractJobResult.model_validate({**_as_dict(ctx.step("extract")), "ocr": ocr_result}).model_dump(mode="json")
        try:
            ctx.check_cancelled()
            validated = _validate_extraction(request, repo, user)
            response = await _run_extraction(validated, request, repo, storage, user, settings, ctx.report, base_url=params.base_url)
        except JobCancelled:
            if ocr_result is None:
                raise
            logger.info(f"Extraction job {ctx.job_id} was cancelled after text recognition; nothing was extracted")
            return _ocr_only(ocr_result).model_dump(mode="json")
    try:
        await ctx.save_step("extract", response.model_dump(mode="json"))
    except JobCancelled:
        pass  # the result is saved: a cancel no longer applies
    return ExtractJobResult(id=response.id, pdf=response.pdf, xml=response.xml, language_conflict=response.language_conflict, ocr=ocr_result).model_dump(mode="json")


def _ocr_only(ocr_result: OcrResponse) -> ExtractJobResult:
    """The result of a job that was cancelled after the result of text recognition was stored: nothing was extracted."""
    return ExtractJobResult(id=None, pdf=None, xml=None, language_conflict=None, ocr=ocr_result, cancelled=True)


def _as_dict(value: JsonValue) -> dict[str, JsonValue]:
    """A saved step result, which is a JSON object."""
    if not isinstance(value, dict):
        raise ExtractJobError("The saved extraction step is invalid", 500)
    return value

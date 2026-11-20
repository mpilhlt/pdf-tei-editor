"""
OCR API router.

Endpoints:
- GET  /api/v1/ocr/engines                  - List available OCR engines
- GET  /api/v1/ocr/text-quality/{stable_id} - Assess the text layer of a PDF
- POST /api/v1/ocr                          - Apply OCR to a PDF, replacing its content
"""

import asyncio
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pypdf.errors import PdfReadError

from ..lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
from ..lib.models import FileMetadata, FileUpdate
from ..lib.models.models_ocr import OcrEngineInfo, OcrOptionInfo, OcrRequest, OcrResponse, TextQualityReport
from ..lib.ocr.base import OcrEngine, OcrOptionValue, OcrResult
from ..lib.ocr.languages import normalize_ocr_language
from ..lib.ocr.layout_check import apply_layout_check, check_text_layout
from ..lib.ocr.registry import OcrEngineRegistry
from ..lib.ocr.text_quality import analyze_text_layer
from ..lib.permissions.access_control import check_file_access
from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage
from ..lib.utils.logging_utils import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/ocr", tags=["ocr"])

OCR_METADATA_KEY = "ocr"
"""Key in the PDF's file_metadata under which the last OCR run is recorded."""

_ocr_semaphore = asyncio.Semaphore(1)
"""OCR is CPU-bound and uses all cores, so runs are serialized."""


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


@router.post("", response_model=OcrResponse)
async def apply_ocr(
    request: OcrRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> OcrResponse:
    """
    Apply OCR to a PDF and replace the stored PDF with the result.

    The stable_id of the PDF stays the same; its content hash changes. The OCR run, including the
    method the engine used, is recorded in the PDF's file metadata under "ocr".
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
    input_path = _pdf_path(storage, file)

    async with _ocr_semaphore:
        with tempfile.TemporaryDirectory(prefix="pte-ocr-") as tmp:
            output_path = Path(tmp) / "output.pdf"
            try:
                outcome = await asyncio.to_thread(engine.recognize, input_path, output_path, languages, options, request.rebuild)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            except Exception as e:
                logger.error(f"OCR with {engine.id} failed for {file.stable_id}: {e}")
                raise HTTPException(status_code=500, detail=f"Text recognition failed: {e}")
            if not output_path.exists():
                raise HTTPException(status_code=500, detail="Text recognition produced no output")
            content = output_path.read_bytes()
            quality = await asyncio.to_thread(analyze_text_layer, output_path)

    result = outcome if isinstance(outcome, OcrResult) else OcrResult(message=outcome)
    record: dict[str, str | list[str]] = {
        "engine": engine.id,
        "languages": languages,
        "applied_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "applied_by": str(current_user.get("username") or ""),
    }
    if result.method:
        record["method"] = result.method
    if result.fallback_reason:
        record["fallback_reason"] = result.fallback_reason
    new_hash, _ = storage.save_file(content, "pdf", increment_ref=False)
    changed = new_hash != file.id
    update = FileUpdate(file_size=len(content), file_metadata={**file.file_metadata, OCR_METADATA_KEY: record})
    if changed:
        # FileRepository moves the storage reference from the old to the new content hash
        update.id = new_hash
    repo.update_file(file.id, update)
    logger.info(f"Applied OCR ({engine.id}, {result.method or 'default method'}, {languages}) to {file.stable_id}: {file.id[:8]} -> {new_hash[:8]}")
    quality.ocr_applied = record
    return OcrResponse(
        stable_id=file.stable_id,
        changed=changed,
        message=result.message,
        method=result.method,
        fallback_reason=result.fallback_reason,
        quality=quality,
    )

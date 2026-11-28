"""
The run of an extraction, shared by the synchronous route `POST /api/v1/extract`
(`fastapi_app/routers/extraction.py`) and the job type `extract` (`job_types.py`).

`_validate_extraction()` makes the checks that reject a request at once (400, 404);
`_run_extraction()` runs the extractor and saves the result as a new file.
"""

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException
from lxml import etree

from fastapi_app.config import Settings
from fastapi_app.lib.extraction.base import BaseExtractor
from fastapi_app.lib.extraction.manager import create_extractor, should_use_mock_extractor
from fastapi_app.lib.models import FileCreate, FileMetadata, FileUpdate
from fastapi_app.lib.models.models_extraction import ExtractRequest, ExtractResponse, LanguageConflict
from fastapi_app.lib.ocr.provenance import text_layer_provenance
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.secrets import MissingSecretError, secret_required_detail
from fastapi_app.lib.services.language_detection import add_document_language, extract_pdf_text, find_language_conflict
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.hash_utils import get_storage_path
from fastapi_app.lib.utils.logging_utils import get_logger
from fastapi_app.lib.utils.tei_utils import amend_last_revision_change, extract_tei_metadata, serialize_tei_like_source, update_pdf_metadata_from_tei
from fastapi_app.lib.utils.xml_utils import parse_untrusted_xml

logger = get_logger(__name__)

ProgressReport = Callable[..., Awaitable[None]]
"""Reports the progress of a job (`JobContext.report`); raises `JobCancelled` after a cancel."""

CANCEL_CHECK_INTERVAL = 0.5
"""Seconds between the checks for a cancel while the extractor runs."""


@dataclass
class _ValidatedExtraction:
    """An extraction request that passed the checks: the extractor and the source file."""

    extractor: BaseExtractor
    extractor_info: dict[str, Any]
    file: FileMetadata

    @property
    def name(self) -> str:
        """The name of the extractor, for the user."""
        return str(self.extractor_info.get("name") or self.extractor_info.get("id") or "the extractor")

    @property
    def reads_pdf(self) -> bool:
        """Whether the extractor extracts from the PDF (the source is a PDF)."""
        return self.file.file_type == "pdf"


def _validate_extraction(request: ExtractRequest, repo: FileRepository, user: dict[str, Any]) -> _ValidatedExtraction:
    """
    Check an extraction request: the extractor exists (an extractor whose dependencies are
    missing is replaced with the mock extractor if that is allowed), the file exists and the
    extractor accepts its type.

    Raises:
        HTTPException: 400 for an unknown extractor or a file type the extractor does not accept,
            404 if the file does not exist
    """
    try:
        extractor = create_extractor(request.extractor)
    except KeyError:
        raise HTTPException(status_code=400, detail=f"Unknown extractor: {request.extractor}")
    except RuntimeError as e:
        # Check if this is a dependency/availability error and if we should fall back to mock
        if not should_use_mock_extractor(e):
            raise HTTPException(status_code=400, detail=str(e))
        logger.info(f"Using mock extractor for {request.extractor} due to missing dependencies: {e}")
        try:
            extractor = create_extractor("mock-extractor")
        except (KeyError, RuntimeError):
            raise HTTPException(status_code=400, detail=str(e))

    # Get extractor metadata to determine expected input types
    extractor_info = extractor.__class__.get_info()
    if not extractor_info.get('input'):
        raise HTTPException(status_code=400, detail=f"Extractor {request.extractor} must specify at least one input type")
    expected_inputs = extractor_info['input']

    # Resolve file_id to get file metadata
    try:
        file_metadata = repo.get_file_by_id_or_stable_id(request.file_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_id}")
    if not file_metadata:
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_id}")

    # Verify file type matches one of the expected input types
    file_matches_input = False
    if "xml" in expected_inputs and file_metadata.file_type in ['tei', 'rng']:
        file_matches_input = True
    if "pdf" in expected_inputs and file_metadata.file_type == 'pdf':
        file_matches_input = True
    if not file_matches_input:
        expected_types_str = ", ".join(expected_inputs)
        raise HTTPException(status_code=400, detail=f"Extractor {request.extractor} expects {expected_types_str} input, but file has type: {file_metadata.file_type}")

    return _ValidatedExtraction(extractor=extractor, extractor_info=extractor_info, file=file_metadata)


async def _run_extraction(
    validated: _ValidatedExtraction,
    request: ExtractRequest,
    repo: FileRepository,
    storage: FileStorage,
    user: dict[str, Any],
    settings: Settings,
    report: ProgressReport | None,
    *,
    base_url: str = "",
) -> ExtractResponse:
    """
    Run a validated extraction and save its result as a new file.

    With `report` (a job's `ctx.report`), the phases are reported, and a cancel stops the
    extraction while the extractor runs and at the latest before the result is saved (by the
    `JobCancelled` that `report` raises); nothing is saved then. Once saving starts, a cancel no
    longer applies.

    Args:
        validated: The checked request (see `_validate_extraction()`)
        request: The request
        repo: File repository
        storage: File storage
        user: The user the extraction runs for
        settings: Application settings
        report: Reports the progress of a job; None outside of a job
        base_url: Base URL of the server, for extractors that put URLs into the result

    Raises:
        HTTPException: 404 if the file content is missing, 428 if the extractor needs an API key
            of the user, 500 if the extractor or saving fails
        JobCancelled: (from `report`) if the job was cancelled
    """
    file_metadata = validated.file
    extractor = validated.extractor
    if report is not None:
        # a cancel before this point changes nothing
        await report(phase=f"Extracting with {validated.name}")

    # Move the PDF into the user-selected collection before attempting extraction,
    # so that a failed extraction (e.g. Grobid down) doesn't leave the file stuck in
    # the upload-time default collection with no way to move or delete it (#477)
    if file_metadata.file_type == 'pdf':
        selected_collection = (request.options or {}).get('collection')
        if selected_collection and selected_collection not in (file_metadata.doc_collections or []):
            moved = repo.update_file(file_metadata.id, FileUpdate(doc_collections=[selected_collection]))
            file_metadata = moved or file_metadata

    # Get physical file path from hash-sharded storage
    # Note: files are stored in data_root/files subdirectory
    storage_root = settings.data_root / "files"
    file_path = get_storage_path(storage_root, file_metadata.id, file_metadata.file_type)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Physical file not found for: {request.file_id}")

    pdf_path: Optional[str] = None
    xml_content: Optional[str] = None
    if file_metadata.file_type in ['tei', 'rng']:
        # For XML-based extractors, load XML content
        xml_content = file_path.read_text(encoding='utf-8')
    elif file_metadata.file_type == 'pdf':
        # For PDF-based extractors, pass file path
        pdf_path = str(file_path)

    # Pass doc_id, stable_id, and base_url through options so extractors can set the correct fileref and URLs
    extraction_options: dict[str, Any] = {**(request.options or {})}
    extraction_options['doc_id'] = file_metadata.doc_id
    extraction_options['stable_id'] = file_metadata.stable_id
    extraction_options['base_url'] = base_url
    extraction_options['username'] = user.get('username') if user else None

    try:
        tei_xml = await _cancellable(extractor.extract(pdf_path=pdf_path, xml_content=xml_content, options=extraction_options), report)
        logger.debug(f"Extraction completed with {request.extractor}, result length: {len(tei_xml)}")
    except MissingSecretError as e:
        # The frontend prompts the user for the key and repeats the request
        raise HTTPException(status_code=428, detail=secret_required_detail(e))
    except Exception as e:
        logger.error(f"Extraction failed with {request.extractor}: {e}")
        raise HTTPException(status_code=500, detail=f"Extraction failed: {str(e)}")

    # Declare the document language in the TEI header, independent of the extractor, and
    # report a declared language (e.g. from CrossRef) that the text contradicts
    language_conflict: Optional[LanguageConflict] = None
    try:
        language_pdf_path = pdf_path or _find_pdf_path(repo, storage_root, file_metadata.doc_id)
        pdf_text = await asyncio.to_thread(extract_pdf_text, language_pdf_path) if language_pdf_path else None
        tei_xml = await asyncio.to_thread(add_document_language, tei_xml, pdf_text=pdf_text)
        conflict = await asyncio.to_thread(find_language_conflict, tei_xml, pdf_text)
        if conflict:
            language_conflict = LanguageConflict(declared=conflict[0], detected=conflict[1])
            logger.info(f"Declared language '{conflict[0]}' of the extraction result contradicts the detected language '{conflict[1]}'")
    except Exception as e:
        logger.warning(f"Could not add document language: {e}")

    # the last point at which a cancel stops the extraction: nothing is saved yet
    if report is not None:
        await report(phase="Saving the extraction result")

    if pdf_path and file_metadata.file_type == 'pdf':
        # An extraction from a text layer made by text recognition says so in its label and change
        tei_xml = _note_text_layer_provenance(tei_xml, file_metadata.file_metadata or {})
        # For PDF-based extraction, save as associated TEI file
        result = _save_pdf_extraction_result(file_metadata, tei_xml, extraction_options, repo, storage, user)
        return ExtractResponse(id=file_metadata.doc_id, pdf=result['pdf'], xml=result['xml'], language_conflict=language_conflict)
    # For XML-based extraction, save as associated file (reusing source doc_id when available)
    result = _save_xml_extraction_result(tei_xml, request.extractor, extraction_options, repo, storage, username=user.get('username') if user else None)
    return ExtractResponse(
        id=result.get('pdf') and file_metadata.doc_id or None,
        pdf=result.get('pdf'),
        xml=result['xml'] or "",
        language_conflict=language_conflict,
    )


async def _cancellable(extraction: Awaitable[str], report: ProgressReport | None) -> str:
    """
    Await the extractor; with `report`, check for a cancel of the job every
    `CANCEL_CHECK_INTERVAL` seconds and stop the extractor if the job was cancelled.

    Raises:
        JobCancelled: (from `report`) if the job was cancelled
    """
    if report is None:
        return await extraction
    task: asyncio.Future[str] = asyncio.ensure_future(extraction)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=CANCEL_CHECK_INTERVAL)
            if done:
                return task.result()
            # raises JobCancelled after a cancel; the fields of the progress stay unchanged
            await report()
    finally:
        if not task.done():
            task.cancel()


def _note_text_layer_provenance(tei_xml: str, pdf_file_metadata: dict[str, Any]) -> str:
    """
    If the text layer of the PDF was made by text recognition, add this to the label and the
    description of the extraction's revision change (see `text_layer_provenance()`), e.g.
    "Extraction after OCR".

    Args:
        tei_xml: The extracted TEI
        pdf_file_metadata: The file metadata of the PDF it was extracted from

    Returns:
        The TEI, unchanged if the text layer is not from text recognition or the TEI has no change
    """
    provenance = text_layer_provenance(pdf_file_metadata)
    if provenance is None:
        return tei_xml
    try:
        root = parse_untrusted_xml(tei_xml)
    except etree.XMLSyntaxError as e:
        logger.warning(f"Could not record the text recognition in the extraction result: {e}")
        return tei_xml
    if not amend_last_revision_change(root, provenance.label_suffix, provenance.description):
        logger.warning("The extraction result has no revision change to record the text recognition in")
        return tei_xml
    return serialize_tei_like_source(root, tei_xml)


def _save_pdf_extraction_result(
    pdf_metadata: FileMetadata,
    tei_xml: str,
    options: dict[str, Any],
    repo: FileRepository,
    storage: FileStorage,
    current_user: Optional[dict[str, Any]] = None
) -> dict[str, str]:
    """
    Save PDF extraction result as associated TEI file.

    Args:
        pdf_metadata: Metadata of the PDF file
        tei_xml: Extracted TEI XML content
        options: Extraction options (may include variant_id)
        repo: File repository
        storage: File storage
        current_user: The user who extracted

    Returns:
        Dict with the stable ids under 'pdf' and 'xml'
    """
    # Determine variant from options
    variant = options.get('variant_id')

    # Save TEI file to storage
    tei_bytes = tei_xml.encode('utf-8')
    tei_hash, _ = storage.save_file(tei_bytes, 'tei')

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

    # Fall back to the extractor name, then append the extraction timestamp so
    # that repeated extractions of the same document are distinguishable (#418)
    label = label or options.get('extractor', 'unknown')
    label = f"{label} ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})"

    # Check if file with this hash already exists (e.g., re-running same extraction)
    existing_file = repo.get_file_by_id(tei_hash)
    if existing_file:
        logger.info(f"TEI file already exists with hash {tei_hash[:8]}..., returning existing stable_id: {existing_file.stable_id}")
        # Still update PDF metadata if we have new metadata
        inserted_file = existing_file
    else:
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
            created_by=current_user.get('username') if current_user else None,
            pdf_stable_id=pdf_metadata.stable_id,  # the PDF it was extracted from (#944)
        )
        inserted_file = repo.insert_file(file_create)

    # Update PDF metadata from extracted TEI
    if tei_metadata:
        update_pdf_metadata_from_tei(pdf_metadata, tei_metadata, repo, logger, doc_collections=doc_collections)

    logger.info(f"Saved extraction result: {tei_hash[:8]}... (doc_id={pdf_metadata.doc_id}, variant={variant}, label={label})")

    return {
        'pdf': pdf_metadata.stable_id,
        'xml': inserted_file.stable_id
    }


def _save_xml_extraction_result(
    content: str,
    extractor_id: str,
    options: dict[str, Any],
    repo: FileRepository,
    storage: FileStorage,
    username: Optional[str] = None
) -> dict[str, Optional[str]]:
    """
    Save XML extraction result.

    When the source file has a doc_id in options (i.e. it was extracted from a known
    document), the result inherits that doc_id so it stays associated with the original
    PDF/document family.  Otherwise a fresh doc_id is generated.

    Args:
        content: Extracted XML content
        extractor_id: ID of the extractor used
        options: Extraction options; may contain doc_id, stable_id, variant_id
        repo: File repository
        storage: File storage
        username: Authenticated username

    Returns:
        Dict with 'xml': stable_id and optionally 'pdf': stable_id of the associated PDF
    """
    file_type = 'tei'

    # Reuse the source file's doc_id when available so the result stays linked to the
    # original document family (PDF + all its TEI variants share the same doc_id).
    source_doc_id = options.get('doc_id')
    if source_doc_id:
        doc_id = source_doc_id
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        content_hash = hashlib.sha256(content.encode('utf-8')).hexdigest()[:8]
        doc_id = f"{extractor_id}_{timestamp}_{content_hash}"

    variant = options.get('variant_id')
    collection = options.get('collection', '_inbox')

    content_bytes = content.encode('utf-8')
    file_hash, _ = storage.save_file(content_bytes, file_type)

    # Check if file with this hash already exists (same content)
    try:
        existing_hash_file = repo.get_file_by_id(file_hash)
        if existing_hash_file:
            logger.info(f"File with hash {file_hash[:8]}... already exists, returning stable_id: {existing_hash_file.stable_id}")
            pdf_stable_id = _find_pdf_stable_id(repo, doc_id)
            return {'xml': existing_hash_file.stable_id, 'pdf': pdf_stable_id}
    except ValueError:
        pass  # Hash doesn't exist, continue

    # Parse label from TEI header if possible
    label = extractor_id
    try:
        tei_root = etree.fromstring(content_bytes)
        tei_meta = extract_tei_metadata(tei_root)
        label = tei_meta.get('edition_title') or extractor_id
    except Exception:
        pass

    # Append the extraction timestamp so that repeated extractions of the same
    # document are distinguishable (#418)
    label = f"{label} ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})"

    file_create = FileCreate(
        id=file_hash,
        stable_id=None,  # Will be auto-generated
        filename=f"{doc_id}-{extractor_id}.xml",
        doc_id=doc_id,
        file_type=file_type,
        file_size=len(content_bytes),
        doc_collections=[collection],
        doc_metadata={},
        variant=variant,
        version=1,
        is_gold_standard=False,
        label=label,
        file_metadata={'extractor': extractor_id},
        created_by=username
    )

    inserted_file = repo.insert_file(file_create)
    pdf_stable_id = _find_pdf_stable_id(repo, doc_id)

    logger.info(f"Saved {extractor_id} extraction result: {file_hash[:8]}... (doc_id={doc_id}, variant={variant})")

    return {
        'xml': inserted_file.stable_id,
        'pdf': pdf_stable_id,
    }


def _find_pdf_stable_id(repo: FileRepository, doc_id: str) -> Optional[str]:
    """Return the stable_id of the canonical PDF of the document, or None."""
    pdf = repo.get_pdf_for_document(doc_id)
    return pdf.stable_id if pdf else None


def _find_pdf_path(repo: FileRepository, storage_root: Path, doc_id: Optional[str]) -> Optional[str]:
    """Return the storage path of the PDF file with the given doc_id, or None."""
    if not doc_id:
        return None
    pdf = repo.get_pdf_for_document(doc_id)
    if pdf is None:
        return None
    path = get_storage_path(storage_root, pdf.id, 'pdf')
    return str(path) if path.exists() else None

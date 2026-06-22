"""
Document ID resolution utilities.

Provides resolve_doc_id() which derives a stable doc_id for a newly uploaded file
according to the configured strategy.
"""
import os
import re
import uuid as _uuid
import logging
from typing import Optional, TYPE_CHECKING

from fastapi_app.lib.utils.doi_utils import extract_doi_from_pdf, validate_doi

if TYPE_CHECKING:
    from fastapi_app.lib.repository.file_repository import FileRepository

logger = logging.getLogger(__name__)


def resolve_doc_id(
    mode: str,
    filename: str,
    content: bytes,
    file_type: str,
    collection_id: Optional[str] = None,
    repo: Optional['FileRepository'] = None,
) -> str:
    """
    Resolve a doc_id for a newly uploaded file according to the configured strategy.

    Args:
        mode: One of 'filename', 'doi', 'collection', 'uuid'.
        filename: Original upload filename (with extension).
        content: Raw file bytes (used for DOI extraction from PDFs).
        file_type: 'pdf' or 'xml'.
        collection_id: Target collection ID (required for 'collection' mode).
        repo: FileRepository instance (required for 'collection' mode).

    Returns:
        Resolved doc_id string.
    """
    if mode == 'filename':
        return _derive_from_filename(filename)
    if mode == 'doi':
        return _resolve_doi(filename, content, file_type)
    if mode == 'collection':
        return _resolve_collection(filename, content, file_type, collection_id, repo)
    if mode == 'uuid':
        return str(_uuid.uuid4())
    logger.warning(f"Unknown document.id.mode '{mode}', falling back to 'doi'")
    return _resolve_doi(filename, content, file_type)


def _derive_from_filename(filename: str) -> str:
    """Strip extension and decode filesystem-safe DOI encoding from a filename."""
    name = os.path.splitext(filename)[0]
    label = name.replace("__", "/")
    label = re.sub(r'^(10\.\d{4,9})_(?!_)', r'\1/', label)
    return re.sub(r'\s+', '_', label)


def _resolve_doi(filename: str, content: bytes, file_type: str) -> str:
    """Return filename-derived doc_id, overridden by a DOI extracted from PDF content."""
    base = _derive_from_filename(filename)
    if file_type == 'pdf' and not validate_doi(base):
        extracted = extract_doi_from_pdf(content)
        if extracted:
            return extracted
    return base


def _resolve_collection(
    filename: str,
    content: bytes,
    file_type: str,
    collection_id: Optional[str],
    repo: Optional['FileRepository'],
) -> str:
    """Return '{collection_id}-{NNNN}'; falls back to doi mode if no collection context."""
    if not collection_id or not repo:
        logger.debug("'collection' mode: no collection_id or repo, falling back to 'doi'")
        return _resolve_doi(filename, content, file_type)
    try:
        current_max = repo.get_max_collection_counter(collection_id)
    except Exception as e:
        logger.warning(f"'collection' mode: counter query failed ({e}), using counter 1")
        current_max = 0
    return f"{collection_id}-{current_max + 1:04d}"

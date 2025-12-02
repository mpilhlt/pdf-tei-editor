"""
File serving API router for FastAPI.

Implements GET /api/files/{document_id} - Serve file content by hash.

Key features:
- Accept stable_id or full hash
- Look up in database
- Serve from hash-sharded storage
- Access control enforcement
- Proper MIME types
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Optional

from ..lib.file_repository import FileRepository
from ..lib.file_storage import FileStorage
from ..lib.dependencies import (
    get_file_repository,
    get_file_storage,
    get_current_user
)
from ..lib.access_control import check_file_access
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.get("/{document_id}")
def serve_file_by_id(
    document_id: str,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: Optional[dict] = Depends(get_current_user)
):
    """
    Serve file content by document identifier (stable_id or full hash).

    Returns the actual file content with appropriate MIME type.
    Access control is enforced.

    Args:
        document_id: stable_id or full hash (64 chars)
        repo: File repository (injected)
        storage: File storage (injected)
        current_user: Current user dict (injected)

    Returns:
        FileResponse with file content

    Raises:
        HTTPException: 404 if file not found, 403 if access denied
    """
    # Special case for empty.pdf
    if document_id == "empty.pdf":
        empty_pdf_path = Path("app/web/empty.pdf")
        if empty_pdf_path.exists():
            return FileResponse(empty_pdf_path, media_type="application/pdf")
        raise HTTPException(status_code=404, detail="empty.pdf not found")

    logger.debug(f"Serving file: {document_id}")

    # Look up file by ID, stable_id, or doc_id (for schemas)
    file_metadata = repo.get_file_by_id_or_stable_id(document_id)

    # If not found and looks like a schema doc_id, try gold standard lookup
    if not file_metadata and document_id.startswith("schema-"):
        file_metadata = repo.get_gold_standard(document_id)
        if file_metadata:
            logger.debug(f"Found schema by doc_id: {document_id}")

    if not file_metadata:
        logger.warning(f"File not in database: {document_id}")
        raise HTTPException(status_code=404, detail=f"File not found: {document_id}")

    # Check read access
    if not check_file_access(file_metadata, current_user, 'read'):
        logger.warning(
            f"Access denied for user {current_user.get('username') if current_user else 'anonymous'} "
            f"to file {document_id}"
        )
        raise HTTPException(
            status_code=403,
            detail="Access denied: You don't have permission to view this document"
        )

    # Get file from storage
    file_path = storage.get_file_path(file_metadata.id, file_metadata.file_type)
    if not file_path or not file_path.exists():
        logger.error(f"File in database but not in storage: {document_id}")
        raise HTTPException(
            status_code=404,
            detail=f"File content not found: {document_id}"
        )

    # Determine MIME type
    mime_type_map = {
        'pdf': 'application/pdf',
        'tei': 'application/xml',
        'rng': 'application/xml',
        'xml': 'application/xml'
    }
    mime_type = mime_type_map.get(file_metadata.file_type, 'application/octet-stream')

    logger.info(f"Serving file {document_id[:8]}... ({file_metadata.file_type})")

    return FileResponse(file_path, media_type=mime_type)

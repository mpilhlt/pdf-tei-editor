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

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Optional

from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage
from ..lib.core.dependencies import (
    get_file_repository,
    get_file_storage,
    get_current_user
)
from ..lib.permissions.access_control import check_file_access
from ..lib.utils.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


def is_initial_request(range_header: str | None) -> bool:
    """
    Returns whether a request fetches a file from its beginning, i.e. has no `Range` header or a range that starts at byte 0. PDF.js loads a PDF in range requests (chunks of `rangeChunkSize`, see `app/src/modules/pdfviewer.js`), of which only the first is logged at info level.

    Args:
        range_header: Value of the `Range` request header, if any

    Returns:
        True if the request has no range or the range starts at the first byte
    """
    if not range_header:
        return True
    spec = range_header.strip().lower()
    if not spec.startswith("bytes="):
        return True
    return spec[len("bytes="):].lstrip().startswith("0-")


@router.get("/{document_id}")
def serve_file_by_id(
    document_id: str,
    request: Request,
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
        request: The request, whose `Range` header decides the log level
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
            return FileResponse(
                empty_pdf_path,
                media_type="application/pdf",
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0"
                }
            )
        raise HTTPException(status_code=404, detail="empty.pdf not found")

    logger.debug(f"Serving file: {document_id}")

    # Look up file by ID, stable_id, or doc_id (for schemas)
    # (by stable_id first: rows of different documents can share a content hash)
    file_metadata = repo.get_file_by_stable_id(document_id) or repo.get_file_by_id_or_stable_id(document_id)

    # If not found and looks like a schema doc_id, try gold standard lookup
    if not file_metadata and document_id.startswith("schema-"):
        file_metadata = repo.get_gold_standard(document_id)
        if file_metadata:
            logger.debug(f"Found schema by doc_id: {document_id}")

    if not file_metadata:
        logger.warning(f"File not in database: {document_id}")
        raise HTTPException(status_code=404, detail=f"File not found: {document_id}")

    # Check read access. An archived PDF (replaced by text recognition) is readable by whoever can
    # read the document's current PDF; its own document fields are a snapshot of the time it was archived
    access_target = file_metadata
    if file_metadata.superseded_by:
        access_target = repo.get_file_by_stable_id(file_metadata.superseded_by) or file_metadata
    if not check_file_access(access_target, current_user, 'read'):
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

    range_header = request.headers.get("range")
    if is_initial_request(range_header):
        logger.info(f"Serving file {document_id[:8]}... ({file_metadata.file_type})")
    else:
        logger.debug(f"Serving file {document_id[:8]}... ({file_metadata.file_type}), range {range_header}")

    # Set cache control headers to prevent browser caching of mutable content
    # This ensures users always get the latest version after saving changes
    return FileResponse(
        file_path,
        media_type=mime_type,
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        }
    )

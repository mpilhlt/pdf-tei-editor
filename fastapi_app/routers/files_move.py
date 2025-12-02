"""
File move API router for FastAPI.

Implements POST /api/files/move - Move files between collections.

Key changes from Flask:
- Updates doc_collections array (multi-collection support)
- No physical file move (hash-sharded storage is collection-agnostic)
- Only updates PDF file metadata (TEI files inherit collection)
"""

from fastapi import APIRouter, Depends, HTTPException, Request

from ..lib.file_repository import FileRepository
from ..lib.models_files import MoveFilesRequest, MoveFilesResponse
from ..lib.models import FileUpdate
from ..lib.dependencies import (
    get_file_repository,
    require_authenticated_user
)
from ..lib.access_control import check_file_access
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.post("/move", response_model=MoveFilesResponse)
def move_files(
    body: MoveFilesRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict = Depends(require_authenticated_user)
):
    """
    Move files to a different collection.

    In the multi-collection system, this adds the destination collection
    to the document's doc_collections array in the PDF file.

    No physical file move occurs - hash-sharded storage is collection-agnostic.
    TEI files inherit collections from their associated PDF.

    Args:
        request: MoveFilesRequest with pdf_path, xml_path, and destination_collection
        repo: File repository (injected)
        current_user: Current user dict (injected)

    Returns:
        MoveFilesResponse with new paths (same as input in hash-based system)

    Raises:
        HTTPException: 403 if insufficient permissions, 404 if file not found
    """
    logger.debug(f"Moving files to collection {body.destination_collection}, user={current_user}")

    # Look up PDF file by ID or stable_id
    pdf_file = repo.get_file_by_id_or_stable_id(body.pdf_id)
    if not pdf_file:
        raise HTTPException(status_code=404, detail=f"PDF file not found: {body.pdf_id}")

    if pdf_file.file_type != 'pdf':
        raise HTTPException(status_code=400, detail=f"Expected PDF file, got {pdf_file.file_type}")

    # Check write permissions
    if not check_file_access(pdf_file, current_user, 'write'):
        raise HTTPException(
            status_code=403,
            detail="Insufficient permissions to move this document"
        )

    # Update collections (replace with destination collection for move operation)
    current_collections = pdf_file.doc_collections or []
    updated_collections = [body.destination_collection]

    if updated_collections != current_collections:
        logger.info(
            f"Moving document {pdf_file.doc_id} to collection {body.destination_collection}: "
            f"{current_collections} -> {updated_collections}"
        )

        repo.update_file(
            pdf_file.id,
            FileUpdate(
                doc_collections=updated_collections,
                sync_status='modified'
            )
        )
    else:
        logger.info(
            f"Document {pdf_file.doc_id} already in collection {body.destination_collection}"
        )

    # Return IDs (stable_id, unchanged)
    return MoveFilesResponse(
        new_pdf_id=pdf_file.stable_id,
        new_xml_id=body.xml_id  # XML ID unchanged
    )

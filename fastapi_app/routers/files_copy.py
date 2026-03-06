"""
File copy API router for FastAPI.

Implements POST /api/files/copy - Copy files to additional collections.

Key differences from move:
- Adds destination collection while keeping original collection(s)
- Move replaces the collection array, copy appends to it
- No physical file copy (hash-sharded storage handles deduplication)
- Only updates PDF file metadata (TEI files inherit collection)
"""

from fastapi import APIRouter, Depends, HTTPException

from ..lib.repository.file_repository import FileRepository
from ..lib.models.models_files import CopyFilesRequest, CopyFilesResponse
from ..lib.models import FileUpdate
from ..lib.core.dependencies import (
    get_file_repository,
    require_authenticated_user
)
from ..lib.permissions.access_control import check_file_access
from ..lib.utils.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.post("/copy", response_model=CopyFilesResponse)
def copy_files(
    body: CopyFilesRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict = Depends(require_authenticated_user)
):
    """
    Copy files to an additional collection.

    In the multi-collection system, this adds the destination collection
    to the document's doc_collections array while keeping existing collections.

    No physical file copy occurs - hash-sharded storage is collection-agnostic.
    TEI files inherit collections from their associated PDF.

    Args:
        body: CopyFilesRequest with pdf_path, xml_path, and destination_collection
        repo: File repository (injected)
        current_user: Current user dict (injected)

    Returns:
        CopyFilesResponse with paths (same as input in hash-based system)

    Raises:
        HTTPException: 403 if insufficient permissions, 404 if file not found
    """
    logger.debug(f"Copying files to collection {body.destination_collection}, user={current_user}")

    # Resolve PDF ID using repository (handles both full hash and stable_id)
    try:
        pdf_file = repo.get_file_by_id_or_stable_id(body.pdf_id)
    except ValueError:
        pdf_file = None

    if not pdf_file:
        raise HTTPException(status_code=404, detail=f"PDF file not found: {body.pdf_id}")

    if pdf_file.file_type != 'pdf':
        raise HTTPException(status_code=400, detail=f"Expected PDF file, got {pdf_file.file_type}")

    # Check write permissions
    if not check_file_access(pdf_file, current_user, 'write'):
        raise HTTPException(
            status_code=403,
            detail="Insufficient permissions to copy this document"
        )

    # Update collections (add destination if not already present)
    current_collections = pdf_file.doc_collections or []

    if body.destination_collection not in current_collections:
        updated_collections = current_collections + [body.destination_collection]

        logger.info(
            f"Copying document {pdf_file.doc_id} to collection {body.destination_collection}: "
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

    # Return stable_id (short, permanent ID) for client use
    return CopyFilesResponse(
        new_pdf_id=pdf_file.stable_id,
        new_xml_id=body.xml_id  # XML ID unchanged
    )

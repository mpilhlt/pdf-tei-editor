"""
File move API router for FastAPI.

Implements POST /api/files/move - Move files between collections.

Key changes from Flask:
- Updates doc_collections array (multi-collection support)
- No physical file move (hash-sharded storage is collection-agnostic)
- Only updates PDF file metadata (TEI files inherit collection)
"""

from fastapi import APIRouter, Depends, HTTPException

from ..lib.file_repository import FileRepository
from ..lib.models_files import MoveFilesRequest, MoveFilesResponse
from ..lib.models import FileUpdate
from ..lib.dependencies import (
    get_file_repository,
    get_current_user,
    require_session,
    get_hash_abbreviator
)
from ..lib.access_control import check_file_access
from ..lib.hash_abbreviation import HashAbbreviator
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.post("/move", response_model=MoveFilesResponse)
@require_session
def move_files(
    request: MoveFilesRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict = Depends(get_current_user),
    abbreviator: HashAbbreviator = Depends(get_hash_abbreviator)
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
        abbreviator: Hash abbreviator (injected)

    Returns:
        MoveFilesResponse with new paths (same as input in hash-based system)

    Raises:
        HTTPException: 403 if insufficient permissions, 404 if file not found
    """
    logger.debug(f"Moving files to collection {request.destination_collection}, user={current_user}")

    # Resolve PDF path/hash
    try:
        pdf_full_hash = abbreviator.resolve(request.pdf_path)
    except KeyError:
        pdf_full_hash = request.pdf_path

    # Look up PDF file
    pdf_file = repo.get_file_by_id(pdf_full_hash)
    if not pdf_file:
        raise HTTPException(status_code=404, detail=f"PDF file not found: {request.pdf_path}")

    if pdf_file.file_type != 'pdf':
        raise HTTPException(status_code=400, detail=f"Expected PDF file, got {pdf_file.file_type}")

    # Check write permissions
    if not check_file_access(pdf_file, current_user, 'write'):
        raise HTTPException(
            status_code=403,
            detail="Insufficient permissions to move this document"
        )

    # Update collections (add destination if not already present)
    current_collections = pdf_file.doc_collections or []

    if request.destination_collection not in current_collections:
        updated_collections = current_collections + [request.destination_collection]

        logger.info(
            f"Adding collection {request.destination_collection} to document {pdf_file.doc_id}: "
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
            f"Document {pdf_file.doc_id} already in collection {request.destination_collection}"
        )

    # Return paths (abbreviated hashes, unchanged)
    # In hash-based system, "paths" are just the hashes
    return MoveFilesResponse(
        new_pdf_path=abbreviator.abbreviate(pdf_file.id),
        new_xml_path=request.xml_path  # XML path unchanged
    )

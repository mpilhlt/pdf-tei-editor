"""
File list API router for FastAPI.

Implements GET /api/files/list - Returns document-centric file listing.

Key features:
- Database queries instead of filesystem scan
- Document-centric grouping (PDF + TEI files)
- Stable IDs in response
- Lock status integration
- Access control filtering
- Optional variant filtering
"""

from fastapi import APIRouter, Depends, Query, Request
from typing import Optional, Dict, List
from collections import defaultdict

from ..lib.database import DatabaseManager
from ..lib.file_repository import FileRepository
from ..lib.models_files import (
    FileListResponseModel,
    DocumentGroupModel,
    FileItemModel,
    ArtifactModel
)
from ..lib.dependencies import (
    get_db,
    get_file_repository,
    get_current_user,
    get_session_id
)
from ..lib.locking import get_all_active_locks
from ..lib.access_control import DocumentAccessFilter
from ..config import get_settings
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.get("/list", response_model=FileListResponseModel)
def list_files(
    request: Request,
    variant: Optional[str] = Query(None, description="Filter by variant"),
    refresh: bool = Query(False, description="Force refresh (deprecated in FastAPI)"),
    repo: FileRepository = Depends(get_file_repository),
    session_id: Optional[str] = Depends(get_session_id),
    current_user: Optional[dict] = Depends(get_current_user)
) -> FileListResponseModel:
    """
    List all files grouped by document.

    Returns files in simplified document-centric structure:
    - One entry per document (doc_id)
    - Source file (PDF or primary XML) + flattened artifacts array
    - Lock information for each file
    - Access control filtering applied
    - Stable IDs throughout

    Note: 'refresh' parameter ignored - database is always current.

    Args:
        variant: Optional variant filter (e.g., "grobid")
        refresh: Deprecated parameter (ignored)
        repo: File repository (injected)
        session_id: Current session ID (injected)
        current_user: Current user dict (injected)

    Returns:
        FileListResponseModel with files property containing List of DocumentGroupModel objects
    """
    logger.debug(f"Listing files - variant={variant}, user={current_user}")

    # Get all non-deleted files from database
    all_files = repo.list_files(include_deleted=False)

    logger.debug(f"Found {len(all_files)} total files")

    # Group files by doc_id
    documents_map: Dict[str, DocumentGroupModel] = {}

    for file_metadata in all_files:
        doc_id = file_metadata.doc_id

        # Initialize document group if not exists
        if doc_id not in documents_map:
            # Get PDF file for this document to get collections/metadata
            pdf_file = repo.get_pdf_for_document(doc_id)

            if not pdf_file:
                logger.warning(f"No PDF found for document {doc_id}, skipping")
                continue

            # Build source file item
            source_item = _build_file_item(pdf_file)

            documents_map[doc_id] = DocumentGroupModel(
                doc_id=doc_id,
                collections=pdf_file.doc_collections or [],
                doc_metadata=pdf_file.doc_metadata or {},
                source=source_item,
                artifacts=[]
            )

        doc_group = documents_map[doc_id]

        # Skip PDF files (already added as source above)
        if file_metadata.file_type == 'pdf':
            continue

        # Build artifact for TEI files
        if file_metadata.file_type == 'tei':
            artifact = _build_artifact(file_metadata)
            doc_group.artifacts.append(artifact)

    logger.debug(f"Grouped into {len(documents_map)} documents")

    # Apply variant filtering if specified
    if variant is not None:
        documents_map = _apply_variant_filtering(documents_map, variant)
        logger.debug(f"After variant filter: {len(documents_map)} documents")

    # Add lock information
    settings = get_settings()
    try:
        active_locks = get_all_active_locks(settings.db_dir, logger)
        _add_lock_info(documents_map, active_locks, session_id)
    except Exception as e:
        logger.error(f"Error getting lock info: {e}")
        # Continue without lock info

    # Apply access control filtering
    files_data = list(documents_map.values())
    files_data = DocumentAccessFilter.filter_files_by_access(files_data, current_user)

    logger.debug(f"After access control: {len(files_data)} documents")

    return FileListResponseModel(files=files_data)


def _build_file_item(file_metadata) -> FileItemModel:
    """
    Build FileItemModel from FileMetadata (for source files).

    Args:
        file_metadata: FileMetadata model

    Returns:
        FileItemModel with stable_id as id, label from doc_metadata.title
    """
    # Extract label from doc_metadata if available
    label = "Untitled"
    if file_metadata.doc_metadata and isinstance(file_metadata.doc_metadata, dict):
        label = file_metadata.doc_metadata.get('title', 'Untitled')

    return FileItemModel(
        id=file_metadata.stable_id,
        filename=file_metadata.filename,
        file_type=file_metadata.file_type,
        label=label,
        file_size=file_metadata.file_size or 0,
        created_at=file_metadata.created_at,
        updated_at=file_metadata.updated_at
    )


def _build_artifact(file_metadata) -> ArtifactModel:
    """
    Build ArtifactModel from FileMetadata (for TEI artifacts).

    Args:
        file_metadata: FileMetadata model

    Returns:
        ArtifactModel with all required fields, content hash stored as private attribute
    """
    # Extract label - use a descriptive name for artifacts
    label = "Annotator" if file_metadata.is_gold_standard else f"Version {file_metadata.version or 'N/A'}"

    artifact = ArtifactModel(
        id=file_metadata.stable_id,
        filename=file_metadata.filename,
        file_type=file_metadata.file_type,
        label=label,
        file_size=file_metadata.file_size or 0,
        created_at=file_metadata.created_at,
        updated_at=file_metadata.updated_at,
        variant=file_metadata.variant,
        version=file_metadata.version,
        is_gold_standard=file_metadata.is_gold_standard,
        is_locked=False,  # Will be updated later
        access_control=None  # Will be updated later if needed
    )

    # Store content hash as private attribute for internal use (e.g., locking)
    artifact._content_hash = file_metadata.id  # type: ignore

    return artifact


def _apply_variant_filtering(
    documents: Dict[str, DocumentGroupModel],
    variant: str
) -> Dict[str, DocumentGroupModel]:
    """
    Filter documents to only those with artifacts matching the specified variant.

    Args:
        documents: Dict of doc_id -> DocumentGroupModel
        variant: Variant name to filter by

    Returns:
        Filtered dict with only matching documents
    """
    filtered = {}
    for doc_id, doc_group in documents.items():
        # Check if any artifact has the matching variant
        has_variant = any(
            artifact.variant == variant
            for artifact in doc_group.artifacts
        )
        if has_variant:
            filtered[doc_id] = doc_group
    return filtered


def _add_lock_info(
    documents: Dict[str, DocumentGroupModel],
    active_locks: Dict[str, str],
    session_id: Optional[str]
) -> None:
    """
    Add lock status to artifacts in document groups (modifies in place).

    Args:
        documents: Dict of doc_id -> DocumentGroupModel
        active_locks: Dict of content_hash -> session_id
        session_id: Current session ID
    """
    for doc_group in documents.values():
        # Check all artifacts
        for artifact in doc_group.artifacts:
            # Use content hash stored as private attribute for lock lookup
            content_hash = getattr(artifact, '_content_hash', None)
            if content_hash and content_hash in active_locks and active_locks[content_hash] != session_id:
                artifact.is_locked = True

"""
File list API router for FastAPI.

Implements GET /api/files/list - Returns document-centric file listing.

Key features:
- Database queries instead of filesystem scan
- Document-centric grouping (PDF + TEI files)
- Abbreviated hashes in response
- Lock status integration
- Access control filtering
- Optional variant filtering
"""

from fastapi import APIRouter, Depends, Query, Request
from typing import Optional, Dict, List
from collections import defaultdict

from ..lib.database import DatabaseManager
from ..lib.file_repository import FileRepository
from ..lib.models_files import FileListResponse, DocumentGroup, FileListItem
from ..lib.dependencies import (
    get_db,
    get_file_repository,
    get_current_user,
    get_session_id,
    get_hash_abbreviator
)
from ..lib.locking import get_all_active_locks
from ..lib.access_control import DocumentAccessFilter
from ..lib.hash_abbreviation import HashAbbreviator
from ..config import get_settings
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.get("/list", response_model=FileListResponse)
def list_files(
    request: Request,
    variant: Optional[str] = Query(None, description="Filter by variant"),
    refresh: bool = Query(False, description="Force refresh (deprecated in FastAPI)"),
    repo: FileRepository = Depends(get_file_repository),
    session_id: Optional[str] = Depends(get_session_id),
    current_user: Optional[dict] = Depends(get_current_user),
    abbreviator: HashAbbreviator = Depends(get_hash_abbreviator)
):
    """
    List all files grouped by document.

    Returns files in document-centric structure:
    - One entry per document (doc_id)
    - PDF file + TEI versions + gold standards + variants
    - Lock information for each file
    - Access control filtering applied
    - Abbreviated hashes (5+ chars) in all IDs

    Note: 'refresh' parameter ignored - database is always current.

    Args:
        variant: Optional variant filter (e.g., "grobid")
        refresh: Deprecated parameter (ignored)
        repo: File repository (injected)
        session_id: Current session ID (injected)
        current_user: Current user dict (injected)
        abbreviator: Hash abbreviator (injected)

    Returns:
        FileListResponse with list of DocumentGroup objects
    """
    logger.debug(f"Listing files - variant={variant}, user={current_user}")

    # Get all non-deleted files from database
    all_files = repo.list_files(include_deleted=False)

    logger.debug(f"Found {len(all_files)} total files")

    # Group files by doc_id
    documents_map: Dict[str, DocumentGroup] = {}

    for file_metadata in all_files:
        doc_id = file_metadata.doc_id

        # Initialize document group if not exists
        if doc_id not in documents_map:
            # Get PDF file for this document to get collections/metadata
            pdf_file = repo.get_pdf_for_document(doc_id)

            if not pdf_file:
                logger.warning(f"No PDF found for document {doc_id}, skipping")
                continue

            # Convert PDF file to FileListItem with abbreviated hash
            pdf_item = _file_metadata_to_list_item(pdf_file, abbreviator)

            documents_map[doc_id] = DocumentGroup(
                doc_id=doc_id,
                doc_collections=pdf_file.doc_collections or [],
                doc_metadata=pdf_file.doc_metadata or {},
                pdf=pdf_item,
                versions=[],
                gold=[],
                variants={}
            )

        doc_group = documents_map[doc_id]

        # Skip PDF files (already added above)
        if file_metadata.file_type == 'pdf':
            continue

        # Convert TEI file to FileListItem with abbreviated hash
        file_item = _file_metadata_to_list_item(file_metadata, abbreviator)

        # Inherit doc_collections and doc_metadata for TEI files
        file_item.doc_collections = doc_group.doc_collections
        file_item.doc_metadata = doc_group.doc_metadata

        # Categorize TEI files
        if file_metadata.file_type == 'tei':
            if file_metadata.is_gold_standard:
                doc_group.gold.append(file_item)
            elif file_metadata.variant:
                if file_metadata.variant not in doc_group.variants:
                    doc_group.variants[file_metadata.variant] = []
                doc_group.variants[file_metadata.variant].append(file_item)
            else:
                doc_group.versions.append(file_item)

    logger.debug(f"Grouped into {len(documents_map)} documents")

    # Apply variant filtering if specified
    if variant is not None:
        documents_map = _apply_variant_filtering(documents_map, variant)
        logger.debug(f"After variant filter: {len(documents_map)} documents")

    # Add lock information
    settings = get_settings()
    try:
        active_locks = get_all_active_locks(settings.db_dir, logger)
        _add_lock_info(documents_map, active_locks, session_id, abbreviator)
    except Exception as e:
        logger.error(f"Error getting lock info: {e}")
        # Continue without lock info

    # Apply access control filtering
    files_data = list(documents_map.values())
    files_data = DocumentAccessFilter.filter_files_by_access(files_data, current_user)

    logger.debug(f"After access control: {len(files_data)} documents")

    return FileListResponse(files=files_data)


def _file_metadata_to_list_item(file_metadata, abbreviator: HashAbbreviator) -> FileListItem:
    """
    Convert FileMetadata to FileListItem with stable ID.

    Args:
        file_metadata: FileMetadata model
        abbreviator: Hash abbreviator instance (unused, kept for compatibility)

    Returns:
        FileListItem with stable_id as id field
    """
    # Use stable_id for the API response
    # The FileMetadata has both 'id' (content hash) and 'stable_id'
    # We expose stable_id as 'id' to the client for URL stability

    # Convert to FileListItem
    item_dict = file_metadata.model_dump()
    item_dict['id'] = file_metadata.stable_id  # Use stable_id as client-facing ID

    return FileListItem(**item_dict)


def _apply_variant_filtering(
    documents: Dict[str, DocumentGroup],
    variant: str
) -> Dict[str, DocumentGroup]:
    """
    Filter documents to only those with the specified variant.

    Args:
        documents: Dict of doc_id -> DocumentGroup
        variant: Variant name to filter by

    Returns:
        Filtered dict with only matching documents
    """
    filtered = {}
    for doc_id, doc_group in documents.items():
        if variant in doc_group.variants:
            filtered[doc_id] = doc_group
    return filtered


def _add_lock_info(
    documents: Dict[str, DocumentGroup],
    active_locks: Dict[str, str],
    session_id: Optional[str],
    abbreviator: HashAbbreviator
) -> None:
    """
    Add lock status to files in document groups (modifies in place).

    Args:
        documents: Dict of doc_id -> DocumentGroup
        active_locks: Dict of full_hash -> session_id
        session_id: Current session ID
        abbreviator: Hash abbreviator instance
    """
    for doc_group in documents.values():
        # Check all file lists
        for file_list in [
            doc_group.versions,
            doc_group.gold,
            *doc_group.variants.values()
        ]:
            for file_item in file_list:
                # Resolve abbreviated hash to full hash for lock lookup
                try:
                    full_hash = abbreviator.resolve(file_item.id)
                    if full_hash in active_locks and active_locks[full_hash] != session_id:
                        file_item.is_locked = True
                except KeyError:
                    # Can't resolve hash - skip lock check
                    pass

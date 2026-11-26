"""
Creating new versions of TEI documents.

Shared by the save route (`POST /api/v1/files/save` with `new_version`) and by routes that create a
version on the server, such as writing text corrections into the PDF (#931).
"""

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from ..core.locking import acquire_lock
from ..core.sessions import SessionManager
from ..models import FileCreate, FileMetadata
from ..permissions.acl_utils import set_default_permissions_for_new_file
from ..permissions.user_utils import user_has_collection_access
from ..repository.file_repository import FileRepository
from ..sse.sse_service import SSEService
from ..sse.sse_utils import broadcast_to_other_sessions
from ..storage.file_storage import FileStorage


def validate_collection_access(user: dict[str, Any], doc_collections: list[str], db_dir: Path, logger_inst: logging.Logger) -> list[str]:
    """Validate that user has access to at least one of the document's collections.

    Args:
        user: User dictionary
        doc_collections: List of collection IDs the document belongs to
        db_dir: Path to db directory
        logger_inst: Logger instance

    Returns:
        List of collection IDs (may be modified to include "_inbox" if empty)

    Raises:
        HTTPException: If user doesn't have access to any of the document's collections
    """
    # If document has no collections, assign to "_inbox" by default
    if not doc_collections:
        logger_inst.info("Document has no collections, assigning to '_inbox' by default")
        doc_collections = ["_inbox"]

    # Check if user has access to any of the document's collections
    has_access = any(
        user_has_collection_access(user, col_id, db_dir)
        for col_id in doc_collections
    )

    if not has_access:
        logger_inst.warning(
            f"User {user.get('username')} denied access to collections {doc_collections}"
        )
        raise HTTPException(
            status_code=403,
            detail=f"You do not have access to any of this document's collections: {', '.join(doc_collections)}"
        )

    return doc_collections


def version_collections(file_repo: FileRepository, doc_id: str, user: dict[str, Any], db_dir: Path, logger_inst: logging.Logger) -> list[str]:
    """
    The collections of a new version of a document: those of its PDF, checked against the user's
    access (see `validate_collection_access`).

    Raises:
        HTTPException: 403 if the user has no access to any of the collections
    """
    pdf_file = file_repo.get_pdf_for_document(doc_id)
    doc_collections = pdf_file.doc_collections if pdf_file else []
    return validate_collection_access(user, doc_collections, db_dir, logger_inst)


@dataclass
class TeiVersionResult:
    """A version created by `create_tei_version`."""

    file: FileMetadata
    created: bool
    """False if a file with the same content existed already and was returned instead."""


async def create_tei_version(
    *,
    xml_string: str,
    doc_id: str,
    variant: Optional[str],
    label: Optional[str],
    status: Optional[str],
    last_revision: Optional[str],
    parent_stable_id: Optional[str],
    pdf_stable_id: Optional[str],
    user: dict[str, Any],
    session_id: str,
    base_url: str,
    db_dir: Path,
    file_repo: FileRepository,
    file_storage: FileStorage,
    sse_service: SSEService,
    session_manager: SessionManager,
    logger_inst: logging.Logger,
) -> TeiVersionResult:
    """
    Create a new version of a TEI document owned by the user, with the next version number of the
    document's variant, and lock it for the session.

    The version inherits the collections of the document's PDF, gets the default permissions of a
    new file and is announced to the other sessions (`fileDataChanged`) and to plugins
    (`document.save` before, `document.saved` after). If a file with the same content exists, it is
    locked and returned instead. The caller checks the user's role.

    Args:
        xml_string: Content of the version, ready to be stored (fileref, entity encoding and
            revision hashes applied)
        doc_id: Document the version belongs to
        variant: Variant of the version
        label: Label (edition title)
        status: Status of the last revision
        last_revision: Timestamp of the last revision
        parent_stable_id: stable_id of the version it was copied from (lineage), if any
        pdf_stable_id: stable_id of the PDF it is attached to; None for the canonical PDF of the document
        user: The user creating the version
        session_id: Session that gets the lock of the version
        base_url: Base URL of the server, for the `document.save` event
        db_dir: Directory of the databases (locks, collections)
        file_repo: File repository
        file_storage: File storage
        sse_service: SSE service
        session_manager: Session manager
        logger_inst: Logger

    Returns:
        The created (or existing) file

    Raises:
        HTTPException: 403 if the user has no access to the collections, 423 if the lock cannot be acquired
    """
    from ..sse.event_bus import get_event_bus

    # Get next version number
    latest_version = file_repo.get_latest_tei_version(doc_id, variant)
    next_version = ((latest_version.version or 0) + 1) if latest_version else 1

    logger_inst.info(f"Creating version {next_version} for doc_id={doc_id}, variant={variant}")

    # Get PDF file to inherit collections
    pdf_file = file_repo.get_pdf_for_document(doc_id)

    # Validate collection access before creating new version (may assign "_inbox" if empty)
    doc_collections = validate_collection_access(user, pdf_file.doc_collections if pdf_file else [], db_dir, logger_inst)

    # Emit document.save event before saving
    await get_event_bus().emit("document.save",
        file_id=None,  # Will be set after creation
        doc_id=doc_id,
        pdf_stable_id=pdf_stable_id or (pdf_file.stable_id if pdf_file else ""),
        xml_content=xml_string,
        label=label,
        status=status,
        collections=doc_collections,
        is_gold=False,
        version=next_version,
        variant=variant,
        base_url=base_url
    )

    # Save to storage
    xml_bytes = xml_string.encode('utf-8')
    saved_hash, _ = file_storage.save_file(xml_bytes, 'tei', increment_ref=False)
    file_size = len(xml_bytes)

    # Check if this hash already exists (content-addressed storage means same content = same hash)
    try:
        existing_hash_file = file_repo.get_file_by_id(saved_hash)
        if existing_hash_file:
            # File with this content already exists - return it instead of creating duplicate
            logger_inst.info(f"File with hash {saved_hash[:8]} already exists, returning existing file")
            # Acquire lock if we don't have it (using stable_id)
            if not acquire_lock(existing_hash_file.stable_id, session_id, db_dir, logger_inst):
                raise HTTPException(status_code=423, detail="Failed to acquire lock")
            await emit_document_saved(existing_hash_file.stable_id, doc_id, user)
            return TeiVersionResult(file=existing_hash_file, created=False)
    except ValueError:
        pass  # Hash doesn't exist, continue with creation

    # Create file first to get stable_id, then acquire lock
    created_file = file_repo.insert_file(FileCreate(
        id=saved_hash,
        filename=f"{doc_id}.{variant}.v{next_version}.tei.xml" if variant else f"{doc_id}.v{next_version}.tei.xml",
        doc_id=doc_id,
        file_type='tei',
        label=label,  # Use extracted edition title
        status=status,  # Status from last revision
        last_revision=last_revision,  # Timestamp from last revision
        variant=variant,
        version=next_version,
        is_gold_standard=False,
        doc_collections=doc_collections,
        doc_metadata={},
        file_metadata={},
        file_size=file_size,
        created_by=user.get('username'),  # Track file creator for access control
        parent_stable_id=parent_stable_id,
        pdf_stable_id=pdf_stable_id,
    ))

    # Now acquire lock using stable_id
    if not acquire_lock(created_file.stable_id, session_id, db_dir, logger_inst):
        raise HTTPException(status_code=423, detail="Failed to acquire lock")

    # Set default permissions for new file (granular mode only)
    set_default_permissions_for_new_file(created_file.stable_id, user.get('username') or '')

    # Notify other sessions about new version
    broadcast_to_other_sessions(
        sse_service=sse_service,
        session_manager=session_manager,
        current_session_id=session_id,
        event_type="fileDataChanged",
        data={
            "reason": "file_created",
            "stable_id": created_file.stable_id
        },
        logger=logger_inst
    )

    await emit_document_saved(created_file.stable_id, doc_id, user)
    return TeiVersionResult(file=created_file, created=True)


async def emit_document_saved(stable_id: str, doc_id: str, user: dict[str, Any]) -> None:
    """Emit the `document.saved` event after a TEI file has been saved successfully.

    Unlike `document.save`, which fires before the file is written (and has no stable_id
    for new versions), this event carries the saved file's stable_id and the saving user.
    """
    from ..sse.event_bus import get_event_bus
    await get_event_bus().emit("document.saved", stable_id=stable_id, doc_id=doc_id, username=user.get('username'))

"""
File save API endpoint.

Simplified from Flask implementation thanks to database-backed storage:
- No filesystem path manipulation
- No JSON cache updates
- Direct database queries for version determination
- Automatic version numbering
- Hash-based storage (no directories to manage)

Key differences from Flask:
- Variant and file_id extracted from XML only (not from filesystem)
- Version numbers managed by database, not filename timestamps
- Gold standard flag is database field, not directory structure
- Collections stored as JSON array in database
"""

import logging
import base64
from typing import Optional
from lxml import etree
from fastapi import APIRouter, Depends, Request, HTTPException
from pathlib import Path

from ..lib.dependencies import (
    get_file_repository,
    get_file_storage,
    require_authenticated_user,
    get_session_id
)
from ..lib.file_repository import FileRepository
from ..lib.file_storage import FileStorage
from ..lib.locking import acquire_lock, release_lock, transfer_lock
from ..lib.logging_utils import get_logger
from ..lib.user_utils import user_has_collection_access
from ..config import get_settings
from ..lib.models import FileCreate, FileUpdate
from ..lib.models_files import SaveFileRequest, SaveFileResponse
from ..lib.tei_utils import serialize_tei_with_formatted_header
from ..lib.xml_utils import encode_xml_entities

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


def _user_has_role(user: dict, role: str) -> bool:
    """Check if user has a specific role.

    Handles wildcard role ('*') which grants all permissions.
    """
    if not user or 'roles' not in user:
        logger.debug(f"_user_has_role: user={user}, role={role} -> False (no user or roles)")
        return False

    user_roles = user.get('roles', [])
    # Check for wildcard role or specific role
    result = '*' in user_roles or role in user_roles
    logger.debug(f"_user_has_role: user={user.get('username')}, roles={user_roles}, checking role={role} -> {result}")
    return result


def _validate_collection_access(user: dict, doc_collections: list, db_dir, logger_inst) -> list:
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
        logger_inst.info(f"Document has no collections, assigning to '_inbox' by default")
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


def _extract_metadata_from_xml(xml_string: str, file_id_hint: Optional[str], logger) -> tuple[str, Optional[str]]:
    """
    Extract file_id and variant from TEI XML.

    Args:
        xml_string: TEI XML content
        file_id_hint: Optional file_id from request (used as fallback if fileref missing)

    Returns:
        (file_id, variant): file_id from fileref or hint, variant from extractor metadata
    """
    try:
        xml_root = etree.fromstring(xml_string.encode('utf-8'))
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}

        # Extract file_id from fileref
        fileref_elem = xml_root.find('.//tei:idno[@type="fileref"]', ns)
        file_id = fileref_elem.text if fileref_elem is not None else None

        # Extract variant from extractor application metadata
        variant_xpath = 'string((.//tei:application[@type="extractor"]/tei:label[@type="variant-id"])[1])'
        variant = xml_root.xpath(variant_xpath, namespaces=ns) or None
        variant = str(variant) if variant else None

        # Fallback: use file_id_hint if no fileref found
        if not file_id and file_id_hint:
            # If hint looks like a path, extract filename without extension
            if '/' in file_id_hint:
                filename = Path(file_id_hint).stem
                # Remove .tei suffix if present
                if filename.endswith('.tei'):
                    filename = filename[:-4]
                file_id = filename
            else:
                file_id = file_id_hint
            logger.debug(f"Using file_id from hint: {file_id}")

        if not file_id:
            raise ValueError("No fileref found in XML and no file_id hint provided")

        logger.debug(f"Extracted from XML: file_id={file_id}, variant={variant}")
        return file_id, variant

    except Exception as e:
        logger.error(f"Failed to extract metadata from XML: {e}")
        raise HTTPException(
            status_code=400,
            detail=f"Cannot extract file_id from XML: {e}"
        )


def _extract_processing_instructions(xml_string: str) -> list[str]:
    """
    Extract processing instructions (e.g., <?xml-model ...?>) from XML string.

    Returns:
        List of processing instruction strings
    """
    import re
    # Match processing instructions (excluding xml declaration)
    pi_pattern = r'<\?(?!xml\s+version)[^\?]+\?>'
    matches = re.findall(pi_pattern, xml_string)
    return matches


def _update_fileref_in_xml(xml_string: str, file_id: str, logger) -> str:
    """
    Ensure fileref in XML matches the file_id.
    Creates fileref element if missing.
    Preserves processing instructions from the original XML.

    Returns:
        Updated XML string
    """
    try:
        # Extract processing instructions before parsing
        processing_instructions = _extract_processing_instructions(xml_string)

        xml_root = etree.fromstring(xml_string.encode('utf-8'))
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}

        # Find or create fileref element
        fileref_elem = xml_root.find('.//tei:idno[@type="fileref"]', ns)

        if fileref_elem is not None:
            # Update existing fileref
            if fileref_elem.text != file_id:
                old_fileref = fileref_elem.text
                fileref_elem.text = file_id
                logger.debug(f"Updated fileref: {old_fileref} -> {file_id}")
                return serialize_tei_with_formatted_header(xml_root, processing_instructions)
            return xml_string

        # Create fileref element
        edition_stmt = xml_root.find('.//tei:editionStmt', ns)
        if edition_stmt is None:
            # Create editionStmt in teiHeader/fileDesc
            file_desc = xml_root.find('.//tei:fileDesc', ns)
            if file_desc is not None:
                edition_stmt = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}editionStmt")

        if edition_stmt is not None:
            # Find or create edition element
            edition = edition_stmt.find('./tei:edition', ns)
            if edition is None:
                edition = etree.SubElement(edition_stmt, "{http://www.tei-c.org/ns/1.0}edition")

            # Add idno with fileref
            fileref_elem = etree.SubElement(edition, "{http://www.tei-c.org/ns/1.0}idno")
            fileref_elem.set("type", "fileref")
            fileref_elem.text = file_id

            logger.debug(f"Added fileref to XML: {file_id}")
            return serialize_tei_with_formatted_header(xml_root, processing_instructions)

        return xml_string

    except Exception as e:
        logger.warning(f"Could not update fileref in XML: {e}")
        return xml_string


@router.post("/save", response_model=SaveFileResponse)
async def save_file(
    request: SaveFileRequest,
    user: dict = Depends(require_authenticated_user),
    session_id: str = Depends(get_session_id),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage)
):
    """
    Save TEI XML file with version management.

    Simplified logic compared to Flask:
    1. Extract file_id and variant from XML
    2. Query database for existing file
    3. Determine save strategy (update, new version, new gold)
    4. Save to hash-sharded storage
    5. Update database with metadata

    Role-based access:
    - Reviewers can edit gold files
    - Annotators can create versions
    - Reviewers can promote versions to gold
    """
    logger_inst = get_logger(__name__)
    settings = get_settings()

    try:
        # Decode base64 if needed
        xml_string = request.xml_string
        if request.encoding == "base64":
            xml_string = base64.b64decode(xml_string).decode('utf-8')

        # Validate XML is well-formed
        try:
            etree.fromstring(xml_string.encode('utf-8'))
        except etree.XMLSyntaxError as e:
            raise HTTPException(status_code=400, detail=f"Invalid XML: {str(e)}")

        # Extract metadata from XML
        file_id, variant = _extract_metadata_from_xml(xml_string, request.file_id, logger_inst)

        # Extract full TEI metadata including label
        from ..lib.tei_utils import extract_tei_metadata
        xml_root = etree.fromstring(xml_string.encode('utf-8'))
        tei_metadata = extract_tei_metadata(xml_root)
        label = tei_metadata.get('edition_title')  # Extract edition title for label

        # For new saves, file_id becomes the doc_id (PDF and TEI share same doc_id)
        doc_id = file_id

        # Determine save strategy based on existing files in database
        existing_gold = file_repo.get_gold_standard(doc_id)

        # Resolve file context based on save operation:
        # - For updates (new_version=False): Find the existing file to update
        # - For new versions (new_version=True): Find the source file to extract doc_id
        #   (the source file_id is needed to determine which document this version belongs to)
        existing_file = None

        if not request.new_version and len(request.file_id) >= 5:
            # UPDATE operation: Resolve file_id to find the file to update
            try:
                resolved_file_id = file_repo.resolve_file_id(request.file_id)
                existing_file = file_repo.get_file_by_id(resolved_file_id)

                if existing_file:
                    # Use the file's doc_id for this operation
                    doc_id = existing_file.doc_id
                    file_id = existing_file.doc_id
                    logger_inst.info(f"Updating existing file: {existing_file.stable_id}")
            except ValueError:
                pass  # Not a valid file_id, treat as new file

        elif request.new_version and len(request.file_id) >= 5:
            # NEW VERSION operation: Resolve source file_id to extract doc_id
            # The source file_id tells us which document this new version belongs to
            try:
                source_file_id = file_repo.resolve_file_id(request.file_id)
                source_file = file_repo.get_file_by_id(source_file_id)

                if source_file:
                    # Extract doc_id from source - new version will share this doc_id
                    doc_id = source_file.doc_id
                    file_id = source_file.doc_id
                    logger_inst.info(f"Creating new version from source: {source_file_id[:8]}, doc_id: {doc_id[:16]}")
            except ValueError:
                # Source file_id not found - use file_id as doc_id for new document
                pass

        # Update fileref in XML to ensure consistency with resolved doc_id
        # This must happen AFTER resolving the correct doc_id from source file
        xml_string = _update_fileref_in_xml(xml_string, file_id, logger_inst)

        # Encode XML entities if configured
        from ..lib.config_utils import load_full_config
        from ..lib.xml_utils import EncodeOptions
        config = load_full_config(settings.db_dir)
        if config.get("xml.encode-entities.server", False):
            logger_inst.debug("Encoding XML entities")
            encode_options: EncodeOptions = {
                'encode_quotes': config.get("xml.encode-quotes", False)
            }
            xml_string = encode_xml_entities(xml_string, encode_options)

        # Refresh existing_gold after resolving doc_id
        if existing_file:
            existing_gold = file_repo.get_gold_standard(doc_id)
        elif request.new_version:
            # For new versions, refresh gold based on resolved doc_id
            existing_gold = file_repo.get_gold_standard(doc_id)

        # Determine save operation
        status = "saved"
        is_gold_standard = False
        version = None

        if existing_file and not request.new_version:
        # Update existing file
        # Validate collection access (may assign "_inbox" if empty)
            doc_collections = _validate_collection_access(user, existing_file.doc_collections or [], settings.db_dir, logger_inst)

            # Update file collections if they were modified
            if doc_collections != existing_file.doc_collections:
                existing_file.doc_collections = doc_collections

        # Check permissions based on file type
            logger_inst.debug(f"Permission check: user={user.get('username')}, roles={user.get('roles')}, file.is_gold={existing_file.is_gold_standard}, file.version={existing_file.version}")

            if existing_file.is_gold_standard and not _user_has_role(user, 'reviewer'):
                raise HTTPException(
                    status_code=403,
                    detail="Only reviewers can edit gold standard files"
                )

            has_annotator = _user_has_role(user, 'annotator')
            has_reviewer = _user_has_role(user, 'reviewer')
            logger_inst.debug(f"Version file permission check: has_annotator={has_annotator}, has_reviewer={has_reviewer}")

            if existing_file.version is not None and not has_annotator and not has_reviewer:
                raise HTTPException(
                    status_code=403,
                    detail="Only annotators or reviewers can edit version files"
                )

        # Acquire lock for existing file
            if not acquire_lock(existing_file.id, session_id, settings.db_dir, logger_inst):
                raise HTTPException(status_code=423, detail="Failed to acquire lock")

        # Save to storage (hash might change if content changed)
            xml_bytes = xml_string.encode('utf-8')
            saved_hash, storage_path = file_storage.save_file(xml_bytes, existing_file.file_type, increment_ref=False)
            file_size = len(xml_bytes)

            # Only update if hash actually changed
            if saved_hash != existing_file.id:
                logger_inst.debug(f"Content changed: {existing_file.id[:8]} -> {saved_hash[:8]}")

                # Transfer lock from old hash to new hash
                transfer_lock(existing_file.id, saved_hash, session_id, settings.db_dir, logger_inst)

                # Update database (FileRepository handles reference counting automatically)
                file_repo.update_file(
                    existing_file.id,
                    FileUpdate(
                        id=saved_hash,  # Update hash if content changed
                        label=label,  # Update label from edition title
                        file_size=file_size,
                        file_metadata={}  # Could extract more metadata from XML
                    )
                )
            else:
                logger_inst.debug(f"Content unchanged: {existing_file.id[:8]}")
                # Just update metadata without changing ID
                file_repo.update_file(
                    existing_file.id,
                    FileUpdate(
                        label=label,  # Still update label even if content unchanged
                        file_size=file_size,
                        file_metadata={}
                    )
                )

            return SaveFileResponse(status="saved", file_id=existing_file.stable_id)

        elif request.new_version or (not existing_file and existing_gold and existing_gold.variant == variant):
        # Create new version
            if not _user_has_role(user, 'annotator') and not _user_has_role(user, 'reviewer'):
                raise HTTPException(
                    status_code=403,
                    detail="Only annotators or reviewers can create version files"
                )

        # Get next version number
            latest_version = file_repo.get_latest_tei_version(doc_id, variant)
            next_version = (latest_version.version + 1) if latest_version else 1

            logger_inst.info(f"Creating version {next_version} for doc_id={doc_id}, variant={variant}")

        # Get PDF file to inherit collections
            pdf_file = file_repo.get_pdf_for_document(doc_id)
            doc_collections = pdf_file.doc_collections if pdf_file else []

        # Validate collection access before creating new version (may assign "_inbox" if empty)
            doc_collections = _validate_collection_access(user, doc_collections, settings.db_dir, logger_inst)

        # Save to storage
            xml_bytes = xml_string.encode('utf-8')
            saved_hash, storage_path = file_storage.save_file(xml_bytes, 'tei', increment_ref=False)
            file_size = len(xml_bytes)

        # Check if this hash already exists (content-addressed storage means same content = same hash)
            try:
                existing_hash_file = file_repo.get_file_by_id(saved_hash)
                if existing_hash_file:
                    # File with this content already exists - return it instead of creating duplicate
                    logger_inst.info(f"File with hash {saved_hash[:8]} already exists, returning existing file")
                    # Acquire lock if we don't have it
                    if not acquire_lock(saved_hash, session_id, settings.db_dir, logger_inst):
                        raise HTTPException(status_code=423, detail="Failed to acquire lock")
                    return SaveFileResponse(status="saved", file_id=existing_hash_file.stable_id)
            except ValueError:
                pass  # Hash doesn't exist, continue with creation

        # Acquire lock
            if not acquire_lock(saved_hash, session_id, settings.db_dir, logger_inst):
                raise HTTPException(status_code=423, detail="Failed to acquire lock")

        # Insert new version
            created_file = file_repo.insert_file(FileCreate(
                id=saved_hash,
                filename=f"{file_id}.{variant}.v{next_version}.tei.xml" if variant else f"{file_id}.v{next_version}.tei.xml",
                doc_id=doc_id,
                file_type='tei',
                label=label,  # Use extracted edition title
                variant=variant,
                version=next_version,
                is_gold_standard=False,
                doc_collections=doc_collections,
                doc_metadata={},
                file_metadata={},
                file_size=file_size
            ))

            status = "new"
            return SaveFileResponse(status=status, file_id=created_file.stable_id)

        else:
        # Create new gold standard file
            if not _user_has_role(user, 'reviewer'):
                raise HTTPException(
                    status_code=403,
                    detail="Only reviewers can create new gold standard files"
                )

            logger_inst.info(f"Creating new gold standard for doc_id={doc_id}, variant={variant}")

        # Get PDF file to inherit collections
            pdf_file = file_repo.get_pdf_for_document(doc_id)
            doc_collections = pdf_file.doc_collections if pdf_file else []

        # Validate collection access before creating new gold standard (may assign "_inbox" if empty)
            doc_collections = _validate_collection_access(user, doc_collections, settings.db_dir, logger_inst)

        # Save to storage
            xml_bytes = xml_string.encode('utf-8')
            saved_hash, storage_path = file_storage.save_file(xml_bytes, 'tei', increment_ref=False)
            file_size = len(xml_bytes)

        # Acquire lock
            if not acquire_lock(saved_hash, session_id, settings.db_dir, logger_inst):
                raise HTTPException(status_code=423, detail="Failed to acquire lock")

        # Insert new gold standard
            filename = f"{file_id}.{variant}.tei.xml" if variant else f"{file_id}.tei.xml"
            created_file = file_repo.insert_file(FileCreate(
                id=saved_hash,
                # stable_id will be auto-generated by insert_file (short, permanent ID)
                filename=filename,
                doc_id=doc_id,
                file_type='tei',
                label=label,  # Use extracted edition title
                variant=variant,
                version=None,  # Gold files have no version
                is_gold_standard=True,
                doc_collections=doc_collections,
                doc_metadata={},
                file_metadata={},
                file_size=file_size
            ))

            status = "new_gold"
            return SaveFileResponse(status=status, file_id=created_file.stable_id)

    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        # Log and convert other exceptions
        logger_inst.error(f"Save API error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Save failed: {str(e)}")


@router.post("/create_version_from_upload", response_model=SaveFileResponse)
async def create_version_from_upload(
    request_data: dict,
    user: dict = Depends(require_authenticated_user),
    session_id: str = Depends(get_session_id),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage)
):
    """
    Create a new version from an uploaded temp file.

    Note: This endpoint requires temp file upload mechanism to be implemented.
    Currently deferred as upload handling needs to be designed.
    """
    import os
    import re

    temp_filename = request_data.get("temp_filename")
    file_id_or_hash = request_data.get("file_id")

    if not temp_filename or not file_id_or_hash:
        raise HTTPException(status_code=400, detail="Missing temp_filename or file_id")

    # Read uploaded file from temp storage
    settings = get_settings()
    upload_dir = settings.upload_dir
    temp_filepath = upload_dir / temp_filename

    if not temp_filepath.exists():
        raise HTTPException(status_code=404, detail=f"Temporary file {temp_filename} not found")

    # Read XML content and strip XML declaration
    with open(temp_filepath, "r", encoding="utf-8") as f:
        xml_content = f.read()
        xml_content = re.sub(r'<\?xml.*\?>', '', xml_content).strip()

    # Clean up temp file
    temp_filepath.unlink()

    # Use save endpoint with new_version=True
    save_request = SaveFileRequest(
        xml_string=xml_content,
        file_id=file_id_or_hash,
        new_version=True
    )

    return await save_file(save_request, user, session_id, file_repo, file_storage)

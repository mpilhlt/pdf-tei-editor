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
from ..lib.locking import acquire_lock, release_lock
from ..lib.logging_utils import get_logger
from ..config import get_settings
from ..lib.models import FileCreate, FileUpdate
from ..lib.models_files import SaveFileRequest, SaveFileResponse
from ..lib.tei_utils import serialize_tei_with_formatted_header
from ..lib.xml_utils import encode_xml_entities

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


def _user_has_role(user: dict, role: str) -> bool:
    """Check if user has a specific role."""
    if not user or 'roles' not in user:
        return False
    return role in user.get('roles', [])


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


def _update_fileref_in_xml(xml_string: str, file_id: str, logger) -> str:
    """
    Ensure fileref in XML matches the file_id.
    Creates fileref element if missing.

    Returns:
        Updated XML string
    """
    try:
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
                return serialize_tei_with_formatted_header(xml_root)
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
            return serialize_tei_with_formatted_header(xml_root)

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

        # Update fileref in XML to ensure consistency
        xml_string = _update_fileref_in_xml(xml_string, file_id, logger_inst)

        # Encode XML entities if configured
        from ..lib.config_utils import load_full_config
        config = load_full_config(settings.db_dir)
        if config.get("xml.encode-entities.server", False):
            logger_inst.debug("Encoding XML entities")
            xml_string = encode_xml_entities(xml_string)

        # For new saves, file_id becomes the doc_id (PDF and TEI share same doc_id)
        doc_id = file_id

        # Determine save strategy based on existing files in database
        existing_gold = file_repo.get_gold_standard(doc_id)

        # Check if we're updating an existing file (provided file_id is a hash)
        existing_file = None
        if len(request.file_id) >= 5:  # Could be abbreviated hash or stable_id
            try:
                full_hash = file_repo.resolve_file_id(request.file_id)
                existing_file = file_repo.get_file_by_id(full_hash)

                # If found, override doc_id with the existing file's doc_id
                if existing_file:
                    doc_id = existing_file.doc_id
                    file_id = existing_file.doc_id  # Use doc_id as file_id
                    logger_inst.info(f"Updating existing file: {full_hash[:8]}")
            except ValueError:
                pass  # Not a hash, treat as new file

        # Refresh existing_gold after resolving doc_id
        if existing_file:
            existing_gold = file_repo.get_gold_standard(doc_id)

        # Determine save operation
        status = "saved"
        is_gold_standard = False
        version = None

        if existing_file and not request.new_version:
        # Update existing file
            logger_inst.info(f"Updating existing file: {existing_file.id[:8]}")

        # Check permissions based on file type
            if existing_file.is_gold_standard and not _user_has_role(user, 'reviewer'):
                raise HTTPException(
                    status_code=403,
                    detail="Only reviewers can edit gold standard files"
                )

            if existing_file.version is not None and not _user_has_role(user, 'annotator') and not _user_has_role(user, 'reviewer'):
                raise HTTPException(
                    status_code=403,
                    detail="Only annotators or reviewers can edit version files"
                )

        # Acquire lock for existing file
            if not acquire_lock(existing_file.id, session_id, settings.db_dir, logger_inst):
                raise HTTPException(status_code=423, detail="Failed to acquire lock")

        # Save to storage (hash might change if content changed)
            xml_bytes = xml_string.encode('utf-8')
            saved_hash, storage_path = file_storage.save_file(xml_bytes, 'tei', increment_ref=False)
            file_size = len(xml_bytes)

            # Update database (FileRepository handles reference counting automatically)
            file_repo.update_file(
                existing_file.id,
                FileUpdate(
                    id=saved_hash,  # Update hash if content changed
                    file_size=file_size,
                    file_metadata={}  # Could extract more metadata from XML
                )
            )

            return SaveFileResponse(status="saved", hash=existing_file.stable_id)

        elif request.new_version or (existing_gold and existing_gold.variant == variant):
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

        # Save to storage
            xml_bytes = xml_string.encode('utf-8')
            saved_hash, storage_path = file_storage.save_file(xml_bytes, 'tei', increment_ref=False)
            file_size = len(xml_bytes)

        # Acquire lock
            if not acquire_lock(saved_hash, session_id, settings.db_dir, logger_inst):
                raise HTTPException(status_code=423, detail="Failed to acquire lock")

        # Get PDF file to inherit collections
            pdf_file = file_repo.get_pdf_for_document(doc_id)
            doc_collections = pdf_file.doc_collections if pdf_file else []

        # Insert new version
            created_file = file_repo.insert_file(FileCreate(
                id=saved_hash,
                filename=f"{file_id}.{variant}.v{next_version}.tei.xml" if variant else f"{file_id}.v{next_version}.tei.xml",
                doc_id=doc_id,
                file_type='tei',
                label=None,
                variant=variant,
                version=next_version,
                is_gold_standard=False,
                doc_collections=doc_collections,
                doc_metadata={},
                file_metadata={},
                file_size=file_size
            ))

            status = "new"
            return SaveFileResponse(status=status, hash=created_file.stable_id)

        else:
        # Create new gold standard file
            if not _user_has_role(user, 'reviewer'):
                raise HTTPException(
                    status_code=403,
                    detail="Only reviewers can create new gold standard files"
                )

            logger_inst.info(f"Creating new gold standard for doc_id={doc_id}, variant={variant}")

        # Save to storage
            xml_bytes = xml_string.encode('utf-8')
            saved_hash, storage_path = file_storage.save_file(xml_bytes, 'tei', increment_ref=False)
            file_size = len(xml_bytes)

        # Acquire lock
            if not acquire_lock(saved_hash, session_id, settings.db_dir, logger_inst):
                raise HTTPException(status_code=423, detail="Failed to acquire lock")

        # Get PDF file to inherit collections
            pdf_file = file_repo.get_pdf_for_document(doc_id)
            doc_collections = pdf_file.doc_collections if pdf_file else []

        # Insert new gold standard
            filename = f"{file_id}.{variant}.tei.xml" if variant else f"{file_id}.tei.xml"
            created_file = file_repo.insert_file(FileCreate(
                id=saved_hash,
                # stable_id will be auto-generated by insert_file (short, permanent ID)
                filename=filename,
                doc_id=doc_id,
                file_type='tei',
                label=None,
                variant=variant,
                version=None,  # Gold files have no version
                is_gold_standard=True,
                doc_collections=doc_collections,
                doc_metadata={},
                file_metadata={},
                file_size=file_size
            ))

            status = "new_gold"
            return SaveFileResponse(status=status, hash=created_file.stable_id)

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

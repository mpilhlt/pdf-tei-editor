"""
File upload API router for FastAPI.

Implements POST /api/files/upload - Upload PDF or XML files.

Key features:
- Upload PDF or XML files
- Save to hash-sharded storage
- Store metadata in database
- MIME type validation
- Return abbreviated hash
"""

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException, Request
import magic
import mimetypes
from pathlib import Path
from typing import Optional

from ..lib.file_storage import FileStorage
from ..lib.file_repository import FileRepository
from ..lib.models_files import UploadResponse
from ..lib.models import FileCreate
from ..lib.dependencies import (
    get_file_repository,
    get_file_storage,
    get_hash_abbreviator,
    get_session_id
)
from ..lib.hash_abbreviation import HashAbbreviator
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])

ALLOWED_MIME_TYPES = {'application/pdf', 'application/xml', 'text/xml'}


@router.post("/upload", response_model=UploadResponse)
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    storage: FileStorage = Depends(get_file_storage),
    repo: FileRepository = Depends(get_file_repository),
    abbreviator: HashAbbreviator = Depends(get_hash_abbreviator),
    session_id: Optional[str] = Depends(get_session_id)
):
    """
    Upload a PDF or XML file.

    Files are stored in hash-sharded storage and metadata is saved to database.
    Returns the abbreviated file hash for subsequent operations.

    Args:
        file: Uploaded file (PDF or XML)
        storage: File storage (injected)
        repo: File repository (injected)
        abbreviator: Hash abbreviator (injected)
        session_id: Current session ID (injected, optional)

    Returns:
        UploadResponse with file type and abbreviated hash

    Raises:
        HTTPException: 400 if no file or invalid type
    """
    # Require session for uploads
    if not session_id:
        raise HTTPException(status_code=401, detail="Session required for file upload")

    if not file.filename:
        raise HTTPException(status_code=400, detail="No selected file")

    logger.info(f"Uploading file: {file.filename}")

    # Read file content
    content = await file.read()

    # Validate MIME type
    if not _is_allowed_mime_type(file.filename, content):
        logger.warning(f"Invalid file type for {file.filename}")
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Allowed types: application/pdf, application/xml"
        )

    # Determine file type
    if file.filename.lower().endswith('.pdf'):
        file_type = 'pdf'
    elif file.filename.lower().endswith('.xml'):
        file_type = 'xml'
    else:
        # Fallback based on content
        mime_type = magic.from_buffer(content, mime=True)
        if mime_type == 'application/pdf':
            file_type = 'pdf'
        else:
            file_type = 'xml'

    logger.debug(f"Detected file type: {file_type}")

    # Save to hash-sharded storage
    file_hash, storage_path = storage.save_file(content, file_type)

    logger.info(f"Saved file to storage: {file_hash[:16]}... at {storage_path}")

    # Check if file already exists in database
    existing_file = repo.get_file_by_id(file_hash)
    if existing_file:
        logger.info(f"File already exists in database: {file_hash[:16]}...")
        # Return existing file info
        abbreviated_hash = abbreviator.abbreviate(file_hash)
        return UploadResponse(
            type=file_type,
            filename=abbreviated_hash
        )

    # Save metadata to database
    file_create = FileCreate(
        id=file_hash,
        filename=f"{file_hash}.{file_type}",
        doc_id=file_hash,  # Temporary doc_id - will be updated on save/processing
        file_type=file_type,
        file_size=len(content),
        file_metadata={
            "original_filename": file.filename,
            "upload_source": "upload_endpoint",
            "session_id": session_id
        }
    )

    try:
        repo.insert_file(file_create)
        logger.info(f"Inserted file metadata into database: {file_hash[:16]}...")
    except Exception as e:
        logger.error(f"Error inserting file metadata: {e}")
        # File is already in storage, so don't fail completely
        # Just log and continue with abbreviated hash

    # Return response compatible with Flask endpoint
    abbreviated_hash = abbreviator.abbreviate(file_hash)

    logger.info(f"Upload complete: {file.filename} -> {abbreviated_hash}")

    return UploadResponse(
        type=file_type,
        filename=abbreviated_hash
    )


def _is_allowed_mime_type(filename: str, file_content: bytes) -> bool:
    """
    Check file type using content (libmagic) and extension.

    Args:
        filename: Original filename
        file_content: File bytes

    Returns:
        True if file type is allowed
    """
    try:
        # Check content-based MIME type
        mime_type_by_content = magic.from_buffer(file_content, mime=True)
        if mime_type_by_content in ALLOWED_MIME_TYPES:
            return True
    except Exception as e:
        logger.warning(f"Error detecting MIME type from content: {e}")

    # Check extension-based MIME type
    mime_type_by_extension, _ = mimetypes.guess_type(filename)
    return mime_type_by_extension in ALLOWED_MIME_TYPES

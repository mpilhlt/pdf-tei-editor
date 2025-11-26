"""
File upload API router for FastAPI.

Implements POST /api/files/upload - Upload PDF or XML files.

Key features:
- Upload PDF or XML files
- Save to hash-sharded storage
- Store metadata in database
- MIME type validation
- Return full hash
"""

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException, Request
import mimetypes
from pathlib import Path
from typing import Optional

# Try to import libmagic, but make it optional
try:
    import magic
    MAGIC_AVAILABLE = True
except (ImportError, OSError) as e:
    MAGIC_AVAILABLE = False
    magic = None

from ..lib.file_storage import FileStorage
from ..lib.file_repository import FileRepository
from ..lib.models_files import UploadResponse
from ..lib.models import FileCreate
from ..lib.dependencies import (
    get_file_repository,
    get_file_storage,
    get_session_id
)
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])

ALLOWED_MIME_TYPES = {'application/pdf', 'application/xml', 'text/xml'}

# Log libmagic availability on module load
if not MAGIC_AVAILABLE:
    logger.warning(
        "libmagic is not available. File upload will rely on file extensions only. "
        "Install libmagic for content-based MIME type detection: "
        "macOS: brew install libmagic, Linux: apt-get install libmagic1"
    )


@router.post("/upload", response_model=UploadResponse)
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    storage: FileStorage = Depends(get_file_storage),
    repo: FileRepository = Depends(get_file_repository),
    session_id: Optional[str] = Depends(get_session_id)
):
    """
    Upload a PDF or XML file.

    Files are stored in hash-sharded storage and metadata is saved to database.
    Returns the full file hash for subsequent operations.

    Args:
        file: Uploaded file (PDF or XML)
        storage: File storage (injected)
        repo: File repository (injected)
        session_id: Current session ID (injected, optional)

    Returns:
        UploadResponse with file type and full hash

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
        # Fallback based on content (if libmagic available)
        if MAGIC_AVAILABLE:
            try:
                mime_type = magic.from_buffer(content, mime=True)
                if mime_type == 'application/pdf':
                    file_type = 'pdf'
                else:
                    file_type = 'xml'
            except Exception as e:
                logger.warning(f"Error detecting MIME type with libmagic: {e}")
                # Default to xml if detection fails
                file_type = 'xml'
        else:
            # Without libmagic, default to xml for files without clear extension
            file_type = 'xml'

    logger.debug(f"Detected file type: {file_type}")

    # Save to hash-sharded storage
    file_hash, storage_path = storage.save_file(content, file_type)

    logger.info(f"Saved file to storage: {file_hash[:16]}... at {storage_path}")

    # Check if file already exists in database (including soft-deleted files)
    existing_file = repo.get_file_by_id(file_hash, include_deleted=True)
    if existing_file:
        if existing_file.deleted:
            # File was soft-deleted - undelete it and update label
            logger.info(f"Undeleting previously deleted file: {file_hash[:16]}...")

            # Extract label from filename
            import os
            original_name = os.path.splitext(file.filename)[0]
            label = original_name.replace("__", "/")

            # Undelete the file and update label
            updated_file = repo.undelete_file(file_hash, label=label)
            logger.info(f"Undeleted file: {file_hash[:16]}... -> {updated_file.stable_id}")

            return UploadResponse(
                type=file_type,
                filename=updated_file.stable_id
            )
        else:
            # File exists and is not deleted
            logger.info(f"File already exists in database: {file_hash[:16]}...")
            return UploadResponse(
                type=file_type,
                filename=existing_file.stable_id
            )

    # Extract a label from the original filename
    # Remove extension and use as initial label
    import os
    import re
    original_name = os.path.splitext(file.filename)[0]
    # Convert underscores used for DOIs back to slashes/dots
    # e.g., "10.1111__eulj.12049" -> "10.1111/eulj.12049"
    label = original_name.replace("__", "/")

    # Use filename (without extension) as doc_id, replacing whitespace with underscores
    # This ensures the fileref in extracted/saved TEI matches the file's doc_id
    doc_id = re.sub(r'\s+', '_', original_name)

    # Save metadata to database
    file_create = FileCreate(
        id=file_hash,
        filename=f"{file_hash}.{file_type}",
        doc_id=doc_id,
        file_type=file_type,
        file_size=len(content),
        label=label,
        file_metadata={
            "original_filename": file.filename,
            "upload_source": "upload_endpoint",
            "session_id": session_id
        }
    )

    try:
        created_file = repo.insert_file(file_create)
        logger.info(f"Inserted file metadata into database: {file_hash[:16]}...")

        # Return auto-generated stable_id (short, permanent ID)
        logger.info(f"Upload complete: {file.filename} -> {created_file.stable_id}")

        return UploadResponse(
            type=file_type,
            filename=created_file.stable_id
        )
    except Exception as e:
        logger.error(f"Error inserting file metadata: {e}")
        # This shouldn't happen since we check for existing files above
        # If it does, it's likely a race condition - try to get the file again
        existing_file = repo.get_file_by_id(file_hash)
        if existing_file:
            logger.info(f"File exists after race condition: {file_hash[:16]}...")
            return UploadResponse(
                type=file_type,
                filename=existing_file.stable_id
            )
        # If we still can't find it, this is an actual error
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save file metadata: {str(e)}"
        )


def _is_allowed_mime_type(filename: str, file_content: bytes) -> bool:
    """
    Check file type using content (libmagic if available) and extension.

    Args:
        filename: Original filename
        file_content: File bytes

    Returns:
        True if file type is allowed
    """
    # Check content-based MIME type (if libmagic available)
    if MAGIC_AVAILABLE:
        try:
            mime_type_by_content = magic.from_buffer(file_content, mime=True)
            if mime_type_by_content in ALLOWED_MIME_TYPES:
                return True
        except Exception as e:
            logger.warning(f"Error detecting MIME type from content: {e}")

    # Check extension-based MIME type (always available fallback)
    mime_type_by_extension, _ = mimetypes.guess_type(filename)
    return mime_type_by_extension in ALLOWED_MIME_TYPES

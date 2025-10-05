from fastapi import APIRouter, Query, Depends, Request, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from pathlib import Path
import mimetypes
import os

from ..lib.server_utils import get_session_id_from_request
from ..lib.file_data import get_file_data, apply_variant_filtering
from ..lib.cache_manager import is_cache_dirty
from ..lib.locking import get_all_active_locks
from ..lib.auth import AuthManager
from ..lib.access_control import DocumentAccessFilter
from ..config import get_settings

try:
    import magic  # python-magic
    HAS_MAGIC = True
except ImportError:
    HAS_MAGIC = False

router = APIRouter(prefix="/api/files", tags=["files"])

class FileInfo(BaseModel):
    """File information model"""
    id: str
    label: Optional[str] = None
    author: Optional[str] = None
    title: Optional[str] = None
    date: Optional[str] = None
    doi: Optional[str] = None
    fileref: Optional[str] = None
    collection: Optional[str] = None
    pdf: Optional[Dict[str, Any]] = None
    gold: Optional[List[Dict[str, Any]]] = None
    versions: Optional[List[Dict[str, Any]]] = None

class UploadResponse(BaseModel):
    """Upload response model"""
    type: str
    filename: str

# Allowed MIME types for uploads
ALLOWED_MIME_TYPES = {'application/pdf', 'application/xml', 'text/xml'}

@router.get("/list", response_model=List[FileInfo])
async def file_list(
    request: Request,
    variant: Optional[str] = Query(None, description="Filter by variant"),
    refresh: bool = Query(False, description="Force refresh from filesystem")
):
    """
    Get list of files with metadata.

    - **variant**: Filter by variant (empty string for no variant)
    - **refresh**: Force refresh from filesystem instead of using cache
    """
    settings = get_settings()

    # Get file data with metadata already populated
    force_refresh = refresh or is_cache_dirty()
    files_data = get_file_data(
        data_root=settings.data_root,
        db_dir=settings.db_dir,
        force_refresh=force_refresh
    )

    # Add lock information if WebDAV is enabled
    webdav_enabled = settings.webdav_enabled
    if webdav_enabled:
        active_locks = get_all_active_locks(settings.data_root)
        session_id = get_session_id_from_request(request)

        for data in files_data:
            if "versions" in data:
                for version in data["versions"]:
                    version['is_locked'] = version['path'] in active_locks and active_locks.get(version['path']) != session_id

    # Apply variant filtering if specified
    if variant is not None:
        files_data = apply_variant_filtering(files_data, variant)

    # Apply access control filtering
    session_id = get_session_id_from_request(request)
    user = None
    if session_id:
        auth_manager = AuthManager(settings.db_dir)
        user = auth_manager.get_user_by_session_id(session_id)
    files_data = DocumentAccessFilter.filter_files_by_access(files_data, user)

    return files_data

def is_allowed_mime_type(filename: str, file_content: bytes) -> bool:
    """
    Check the file type using both the file extension (mimetypes) and the file's content (magic).
    """
    if HAS_MAGIC:
        # Check based on file content using libmagic
        mime_type_by_content = magic.from_buffer(file_content, mime=True)
        if mime_type_by_content in ALLOWED_MIME_TYPES:
            return True
    else:
        print("magic library not available, skipping content-based MIME type check.")

    # Check based on file extension
    mime_type_by_extension, _ = mimetypes.guess_type(filename)

    if mime_type_by_extension in ALLOWED_MIME_TYPES:
        return True

    return False

def secure_filename(filename: str) -> str:
    """
    Secure a filename by removing potentially dangerous characters.
    This is a simplified version of Werkzeug's secure_filename.
    """
    if not filename:
        return "unnamed_file"

    # Remove path traversal attempts and path separators
    # This handles "../" sequences and converts them to empty strings
    filename = filename.replace("../", "").replace("..\\", "")
    filename = filename.replace("/", "").replace("\\", "")

    # Remove characters that could be problematic
    allowed_chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    secure_name = "".join(c for c in filename if c in allowed_chars)

    # Ensure we don't have an empty filename
    if not secure_name:
        secure_name = "unnamed_file"
    return secure_name

@router.post("/upload", response_model=UploadResponse)
async def upload_file(
    request: Request,
    file: UploadFile = File(...)
):
    """
    Handles file uploads to the server. Saves the uploaded file to the UPLOAD_DIR.
    Returns a JSON response indicating success or failure.

    Requires authentication via session ID.
    """
    settings = get_settings()

    # Check authentication
    session_id = get_session_id_from_request(request)
    if not session_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Verify session is valid
    auth_manager = AuthManager(settings.db_dir)
    user = auth_manager.get_user_by_session_id(session_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid session")

    # Validate file was provided
    if not file.filename:
        raise HTTPException(status_code=400, detail="No selected file")

    # Read file content for MIME type validation
    file_content = await file.read()
    await file.seek(0)  # Reset file pointer

    # Validate file type
    if not is_allowed_mime_type(file.filename, file_content):
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Allowed types: application/pdf, application/xml"
        )

    # Secure the filename
    filename = secure_filename(file.filename)
    extension = Path(filename).suffix[1:] if Path(filename).suffix else ""

    # Save file to upload directory
    upload_dir = settings.upload_dir
    upload_dir.mkdir(parents=True, exist_ok=True)
    filepath = upload_dir / filename

    try:
        with open(filepath, "wb") as buffer:
            await file.seek(0)
            content = await file.read()
            buffer.write(content)

        return UploadResponse(type=extension, filename=filename)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving file: {str(e)}")
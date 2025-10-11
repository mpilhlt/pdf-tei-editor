"""
Pydantic models for file API operations.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime


# Response models
class FileListItem(BaseModel):
    """Single file entry in list response"""
    id: str                                    # Abbreviated hash (5+ chars) for client
    filename: str
    doc_id: str
    file_type: str
    label: Optional[str] = None
    variant: Optional[str] = None
    version: Optional[int] = None
    is_gold_standard: bool = False
    file_size: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    # Inherited from PDF (when file_type = 'tei')
    doc_collections: Optional[List[str]] = None
    doc_metadata: Optional[Dict[str, Any]] = None

    # Lock status (added at runtime)
    is_locked: bool = False

    # Access control (added at runtime)
    access_control: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


class DocumentGroup(BaseModel):
    """Document with grouped files (PDF + TEI versions + gold)"""
    doc_id: str
    doc_collections: List[str]
    doc_metadata: Dict[str, Any]

    # PDF file
    pdf: Optional[FileListItem] = None

    # TEI files grouped by category
    versions: List[FileListItem] = []      # Regular TEI versions (no variant, not gold)
    gold: List[FileListItem] = []          # Gold standard files
    variants: Dict[str, List[FileListItem]] = {}  # Keyed by variant name


class FileListResponse(BaseModel):
    """Response for GET /api/files/list"""
    files: List[DocumentGroup]


# Request models
class UploadResponse(BaseModel):
    """Response for POST /api/files/upload"""
    type: str           # 'pdf' or 'xml'
    filename: str


class SaveFileRequest(BaseModel):
    """Request for POST /api/files/save"""
    xml_string: str
    file_id: str                           # Hash or path (hash preferred)
    new_version: bool = False
    encoding: Optional[str] = None         # 'base64' if encoded


class SaveFileResponse(BaseModel):
    """Response for POST /api/files/save"""
    status: str         # 'saved', 'new', 'new_gold', 'promoted_to_gold'
    hash: str           # File hash of saved file


class CreateVersionFromUploadRequest(BaseModel):
    """Request for POST /api/files/create_version_from_upload"""
    temp_filename: str
    file_path: str      # Hash or path


class DeleteFilesRequest(BaseModel):
    """Request for POST /api/files/delete"""
    files: List[str]    # List of file hashes or paths


class DeleteFilesResponse(BaseModel):
    """Response for POST /api/files/delete"""
    result: str         # 'ok'


class MoveFilesRequest(BaseModel):
    """Request for POST /api/files/move"""
    pdf_path: str       # Hash or path
    xml_path: str       # Hash or path
    destination_collection: str


class MoveFilesResponse(BaseModel):
    """Response for POST /api/files/move"""
    new_pdf_path: str
    new_xml_path: str


class GetLocksResponse(BaseModel):
    """Response for GET /api/files/locks"""
    locked_files: List[str]    # List of file IDs (abbreviated hashes)


class AcquireLockRequest(BaseModel):
    """Request for POST /api/files/acquire_lock"""
    file_id: str


# Note: acquire_lock returns plain string "OK" to match Flask API
# No response model needed for simple string return


class ReleaseLockRequest(BaseModel):
    """Request for POST /api/files/release_lock"""
    file_id: str


class ReleaseLockResponse(BaseModel):
    """Response for POST /api/files/release_lock"""
    action: str         # 'released', 'already_released'
    message: str


class CheckLockRequest(BaseModel):
    """Request for POST /api/files/check_lock"""
    file_id: str


class CheckLockResponse(BaseModel):
    """Response for POST /api/files/check_lock"""
    is_locked: bool
    locked_by: Optional[str] = None


class HeartbeatRequest(BaseModel):
    """Request for POST /api/files/heartbeat"""
    file_path: str      # Hash or path


class HeartbeatResponse(BaseModel):
    """Response for POST /api/files/heartbeat"""
    status: str         # 'lock_refreshed'
    # No cache_status in FastAPI (deprecated)

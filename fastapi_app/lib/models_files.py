"""
Pydantic models for file API operations.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime


# Response models - New simplified structure

class DocumentMetadata(BaseModel):
    """Document metadata extracted from TEI header"""
    title: str
    authors: List[Dict[str, Any]] = []
    date: Optional[str] = None
    publisher: Optional[str] = None

    class Config:
        from_attributes = True


class FileItemModel(BaseModel):
    """Base model for files with label field"""
    id: str                                    # Stable ID for URLs and references
    filename: str
    file_type: str                             # 'pdf' or 'tei'
    label: str                                 # Display label
    file_size: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ArtifactModel(FileItemModel):
    """Artifact file - extends FileItemModel with artifact-specific properties"""
    variant: Optional[str] = None              # Variant name or null
    version: Optional[int] = None              # Version number or null for gold
    is_gold_standard: bool                     # True for gold standards
    is_locked: bool                            # Lock status
    access_control: Optional[Dict[str, Any]] = None  # Access control rules or null


class DocumentGroupModel(BaseModel):
    """Document with source file and artifacts"""
    doc_id: str
    collections: List[str]                     # All collections
    doc_metadata: Dict[str, Any]               # Metadata from TEI header
    source: FileItemModel                      # Source file (PDF or primary XML)
    artifacts: List[ArtifactModel]             # All artifact files (flattened)

    class Config:
        from_attributes = True


class FileListResponseModel(BaseModel):
    """Response for GET /api/files/list"""
    files: List[DocumentGroupModel]


# Legacy models (kept for backward compatibility with other endpoints)
class FileListItem(BaseModel):
    """Single file entry in list response (LEGACY - use FileItemModel/ArtifactModel)"""
    id: str                                    # Stable ID (6+ chars, permanent) for client
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
    """Document with grouped files (LEGACY - use DocumentGroupModel)"""
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
    """Response for GET /api/files/list (LEGACY - use FileListResponseModel)"""
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
    file_id: str        # Hash or stable_id


class DeleteFilesRequest(BaseModel):
    """Request for POST /api/files/delete"""
    files: List[str]    # List of file hashes or paths


class DeleteFilesResponse(BaseModel):
    """Response for POST /api/files/delete"""
    result: str         # 'ok'


class MoveFilesRequest(BaseModel):
    """Request for POST /api/files/move"""
    pdf_id: str         # Hash or stable_id
    xml_id: str         # Hash or stable_id
    destination_collection: str


class MoveFilesResponse(BaseModel):
    """Response for POST /api/files/move"""
    new_pdf_id: str
    new_xml_id: str


class CopyFilesRequest(BaseModel):
    """Request for POST /api/files/copy"""
    pdf_id: str         # Hash or stable_id
    xml_id: str         # Hash or stable_id
    destination_collection: str


class CopyFilesResponse(BaseModel):
    """Response for POST /api/files/copy"""
    new_pdf_id: str
    new_xml_id: str


class GetLocksResponse(BaseModel):
    """Response for GET /api/files/locks"""
    locked_files: List[str]    # List of file IDs (stable IDs)


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
    file_id: str        # Hash or stable_id


class HeartbeatResponse(BaseModel):
    """Response for POST /api/files/heartbeat"""
    status: str         # 'lock_refreshed'
    # No cache_status in FastAPI (deprecated)

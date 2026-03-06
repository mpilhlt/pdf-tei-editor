"""
Pydantic models for file metadata and related entities.

These models provide type safety and validation for data transfer between
the database layer and FastAPI routes.
"""

from pydantic import BaseModel, Field, ConfigDict, field_validator
from datetime import datetime
from typing import Optional


class FileMetadata(BaseModel):
    """
    Complete file metadata model matching the database schema.

    This model represents a file record with all metadata including
    document-level metadata (for PDFs) and file-specific metadata (for TEI files).
    """
    model_config = ConfigDict(from_attributes=True)

    id: str
    stable_id: str  # Stable short ID for URLs (never changes)
    filename: str
    doc_id: str
    file_type: str  # 'pdf', 'tei', 'rng'
    file_size: int
    label: Optional[str] = None
    variant: Optional[str] = None
    status: Optional[str] = None  # Status from last revision (TEI files only)
    last_revision: Optional[str] = None  # Timestamp from last revision change (TEI files only)
    version: Optional[int] = 1  # NULL for gold and variants, integer for versions
    is_gold_standard: bool = False

    # Document metadata (PDF files only)
    doc_collections: list[str] = Field(default_factory=list)
    doc_metadata: dict = Field(default_factory=dict)

    # File-specific metadata (TEI files)
    file_metadata: dict = Field(default_factory=dict)

    # Sync tracking
    sync_status: str = 'modified'
    local_modified_at: datetime = Field(default_factory=datetime.now)
    sync_hash: Optional[str] = None

    deleted: bool = False
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    created_by: Optional[str] = None  # Username of user who created this file

    @field_validator('file_type')
    @classmethod
    def validate_file_type(cls, v: str) -> str:
        """Validate that file_type is one of the allowed values."""
        allowed = {'pdf', 'tei', 'rng'}
        if v not in allowed:
            raise ValueError(f"file_type must be one of {allowed}")
        return v

    @field_validator('sync_status')
    @classmethod
    def validate_sync_status(cls, v: str) -> str:
        """Validate that sync_status is one of the allowed values."""
        allowed = {'synced', 'modified', 'pending', 'pending_delete', 'deletion_synced', 'error'}
        if v not in allowed:
            raise ValueError(f"sync_status must be one of {allowed}")
        return v


class FileCreate(BaseModel):
    """
    Input model for creating new file entries.

    This model is used when inserting new files into the database.
    Timestamps and sync status will be set automatically.
    stable_id will be generated automatically if not provided.
    """
    id: str
    stable_id: Optional[str] = None  # Auto-generated if not provided
    filename: str
    doc_id: str
    doc_id_type: str = 'custom'  # 'doi', 'fileref', 'custom'
    file_type: str
    file_size: int
    label: Optional[str] = None
    variant: Optional[str] = None
    status: Optional[str] = None  # Status from last revision (TEI files only)
    last_revision: Optional[str] = None  # Timestamp from last revision change (TEI files only)
    version: Optional[int] = 1  # NULL for gold and variants, integer for versions
    is_gold_standard: bool = False
    doc_collections: list[str] = Field(default_factory=list)
    doc_metadata: dict = Field(default_factory=dict)
    file_metadata: dict = Field(default_factory=dict)
    created_by: Optional[str] = None  # Username of user who created this file

    @field_validator('file_type')
    @classmethod
    def validate_file_type(cls, v: str) -> str:
        """Validate that file_type is one of the allowed values."""
        allowed = {'pdf', 'tei', 'rng'}
        if v not in allowed:
            raise ValueError(f"file_type must be one of {allowed}")
        return v


class FileUpdate(BaseModel):
    """
    Input model for updating existing file entries.

    All fields are optional - only provided fields will be updated.
    Sync tracking fields (sync_status, local_modified_at, updated_at)
    are set automatically.
    """
    id: Optional[str] = None  # Allow updating content hash when file content changes
    filename: Optional[str] = None
    file_size: Optional[int] = None
    label: Optional[str] = None
    status: Optional[str] = None  # Status from last revision (TEI files only)
    last_revision: Optional[str] = None  # Timestamp from last revision change (TEI files only)
    version: Optional[int] = None
    is_gold_standard: Optional[bool] = None
    doc_collections: Optional[list[str]] = None
    doc_metadata: Optional[dict] = None
    file_metadata: Optional[dict] = None


class FileWithDocMetadata(FileMetadata):
    """
    Extended file metadata model that includes inherited document metadata.

    This model is used when retrieving TEI files that should inherit
    document-level metadata from their associated PDF file.
    """
    inherited_doc_collections: list[str] = Field(default_factory=list)
    inherited_doc_metadata: dict = Field(default_factory=dict)


class SyncUpdate(BaseModel):
    """
    Model for updating sync-related fields.

    Used when updating sync status, hash, and timestamps after
    synchronization operations.
    """
    sync_status: str
    sync_hash: Optional[str] = None

    @field_validator('sync_status')
    @classmethod
    def validate_sync_status(cls, v: str) -> str:
        """Validate that sync_status is one of the allowed values."""
        allowed = {'synced', 'modified', 'pending', 'pending_delete', 'deletion_synced', 'error'}
        if v not in allowed:
            raise ValueError(f"sync_status must be one of {allowed}")
        return v


class FileQuery(BaseModel):
    """
    Model for querying files with various filters.

    Used for filtering files by type, document, label, version, etc.
    """
    doc_id: Optional[str] = None
    file_type: Optional[str] = None
    label: Optional[str] = None
    variant: Optional[str] = None
    is_gold_standard: Optional[bool] = None
    sync_status: Optional[str] = None
    deleted: bool = False

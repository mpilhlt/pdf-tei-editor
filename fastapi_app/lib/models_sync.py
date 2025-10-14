"""
Pydantic models for sync operations.

Defines request/response models for:
- Sync status checking
- Sync execution
- Conflict resolution
- SSE progress updates
"""

from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional, Literal


class SyncStatusResponse(BaseModel):
    """Response model for sync status check (O(1) operation)."""
    needs_sync: bool
    local_version: int
    remote_version: int
    unsynced_count: int
    last_sync_time: Optional[datetime] = None
    sync_in_progress: bool = False


class SyncRequest(BaseModel):
    """Request model for sync operations."""
    force: bool = Field(
        default=False,
        description="Force sync even if quick check indicates no changes needed"
    )


class ConflictInfo(BaseModel):
    """Information about a file conflict."""
    file_id: str
    stable_id: str
    filename: str
    doc_id: str
    local_modified_at: datetime
    local_hash: str
    remote_modified_at: Optional[datetime]
    remote_hash: Optional[str]
    conflict_type: Literal['modified_both', 'deleted_remote', 'deleted_local']


class SyncSummary(BaseModel):
    """Summary of sync operation results."""
    skipped: bool = False
    uploads: int = 0
    downloads: int = 0
    deletions_local: int = 0
    deletions_remote: int = 0
    metadata_updates: int = 0
    conflicts: int = 0
    errors: int = 0
    new_version: Optional[int] = None
    duration_ms: int = 0


class ConflictListResponse(BaseModel):
    """Response model for listing conflicts."""
    conflicts: list[ConflictInfo]
    total: int


class ConflictResolution(BaseModel):
    """Request model for resolving a conflict."""
    file_id: str
    resolution: Literal['local_wins', 'remote_wins', 'keep_both']
    new_variant: Optional[str] = Field(
        default=None,
        description="Variant name when using 'keep_both' resolution"
    )


class SSEMessage(BaseModel):
    """Model for Server-Sent Events messages."""
    event: str  # 'syncProgress', 'syncMessage', 'syncComplete', 'syncError'
    data: str

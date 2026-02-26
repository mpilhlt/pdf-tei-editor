"""
Pydantic models for PDF-TEI Editor.

Provides type-safe data models for API requests/responses and internal data transfer.
"""

from fastapi_app.lib.models.models import (
    FileMetadata,
    FileCreate,
    FileUpdate,
    SyncUpdate,
    FileQuery,
    FileWithDocMetadata,
)
from fastapi_app.lib.models.models_files import (
    FileItemModel,
    ArtifactModel,
    DocumentGroupModel,
    FileListResponseModel,
    FileListItem,
    DocumentGroup,
    FileListResponse,
    UploadResponse,
    SaveFileRequest,
    SaveFileResponse,
    CreateVersionFromUploadRequest,
    DeleteFilesRequest,
    DeleteFilesResponse,
    MoveFilesRequest,
    MoveFilesResponse,
    CopyFilesRequest,
    CopyFilesResponse,
    GetLocksResponse,
    AcquireLockRequest,
    ReleaseLockRequest,
    ReleaseLockResponse,
    CheckLockRequest,
    CheckLockResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    GarbageCollectRequest,
    GarbageCollectResponse,
    DocumentMetadata,
)
from fastapi_app.lib.models.models_extraction import (
    AnnotationGuideInfo,
    ExtractorInfo,
    ListExtractorsResponse,
    ExtractRequest,
    ExtractResponse,
)
from fastapi_app.lib.models.models_permissions import (
    DocumentPermissionsModel,
    SetPermissionsRequest,
    AccessControlModeResponse,
)
from fastapi_app.lib.models.models_sync import (
    SyncStatusResponse,
    SyncRequest,
    ConflictInfo,
    SyncSummary,
    ConflictListResponse,
    ConflictResolution,
    SSEMessage,
)
from fastapi_app.lib.models.models_validation import (
    ValidateRequest,
    ValidationErrorModel,
    ValidateResponse,
    AutocompleteDataRequest,
    AutocompleteDataResponse,
)

__all__ = [
    # Core models
    "FileMetadata",
    "FileCreate",
    "FileUpdate",
    "SyncUpdate",
    "FileQuery",
    "FileWithDocMetadata",
    # File operation models
    "FileItemModel",
    "ArtifactModel",
    "DocumentGroupModel",
    "FileListResponseModel",
    "FileListItem",
    "DocumentGroup",
    "FileListResponse",
    "UploadResponse",
    "SaveFileRequest",
    "SaveFileResponse",
    "CreateVersionFromUploadRequest",
    "DeleteFilesRequest",
    "DeleteFilesResponse",
    "MoveFilesRequest",
    "MoveFilesResponse",
    "CopyFilesRequest",
    "CopyFilesResponse",
    "GetLocksResponse",
    "AcquireLockRequest",
    "ReleaseLockRequest",
    "ReleaseLockResponse",
    "CheckLockRequest",
    "CheckLockResponse",
    "HeartbeatRequest",
    "HeartbeatResponse",
    "GarbageCollectRequest",
    "GarbageCollectResponse",
    # Extraction models
    "AnnotationGuideInfo",
    "ExtractorInfo",
    "ListExtractorsResponse",
    "ExtractRequest",
    "ExtractResponse",
    "DocumentMetadata",
    # Permission models
    "DocumentPermissionsModel",
    "SetPermissionsRequest",
    "AccessControlModeResponse",
    # Sync models
    "SyncStatusResponse",
    "SyncRequest",
    "ConflictInfo",
    "SyncSummary",
    "ConflictListResponse",
    "ConflictResolution",
    "SSEMessage",
    # Validation models
    "ValidateRequest",
    "ValidationErrorModel",
    "ValidateResponse",
    "AutocompleteDataRequest",
    "AutocompleteDataResponse",
]

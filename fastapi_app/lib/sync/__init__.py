"""
Core synchronization infrastructure.

Provides abstract interfaces and models for sync implementations.
Actual sync backends are implemented as plugins in fastapi_app/plugins/.
"""

from .base import SyncServiceBase
from .models import (
    SyncStatusResponse,
    SyncRequest,
    SyncSummary,
    ConflictInfo,
    ConflictListResponse,
    ConflictResolution,
    SSEMessage,
)

__all__ = [
    "SyncServiceBase",
    "SyncStatusResponse",
    "SyncRequest",
    "SyncSummary",
    "ConflictInfo",
    "ConflictListResponse",
    "ConflictResolution",
    "SSEMessage",
]

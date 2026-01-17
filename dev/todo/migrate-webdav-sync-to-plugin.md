# Migrate WebDAV Sync to Backend Plugin

## Overview

Move WebDAV synchronization from being baked into the core application to a backend plugin. The core sync infrastructure (abstract interfaces, models, SSE events) moves to `lib/sync/`, while the WebDAV-specific implementation moves to a plugin.

## Architecture

```
                     ┌─────────────────────────────────────────┐
                     │           Core (lib/sync/)              │
                     │                                         │
                     │  ┌─────────────────────────────────┐   │
                     │  │  Abstract Sync Service Interface │   │
                     │  │  - SyncServiceBase (ABC)         │   │
                     │  │  - SyncSummary, ConflictInfo     │   │
                     │  │  - SSE event definitions         │   │
                     │  └─────────────────────────────────┘   │
                     │                                         │
                     └─────────────────────────────────────────┘
                                        │
                     ┌─────────────────────────────────────────┐
                     │           Event Bus (lib/)              │
                     │  - file.saved                           │
                     │  - file.created                         │
                     │  - file.deleted                         │
                     └─────────────────────────────────────────┘
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           │                            │                            │
           ▼                            ▼                            ▼
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│  webdav_sync plugin │    │  local_sync plugin  │    │   git_sync plugin   │
│  (implements base)  │    │  (already exists)   │    │   (hypothetical)    │
└─────────────────────┘    └─────────────────────┘    └─────────────────────┘
```

## Current State

### Backend Components

1. **Sync service** (`fastapi_app/lib/sync_service.py`)
   - `SyncService` class - WebDAV-specific implementation
   - Contains both abstract sync logic and WebDAV-specific code

2. **Remote metadata manager** (`fastapi_app/lib/remote_metadata.py`)
   - `RemoteMetadataManager` - WebDAV-specific

3. **Sync router** (`fastapi_app/routers/sync.py`)
   - Endpoints at `/api/v1/sync/*`
   - Tightly coupled to WebDAV sync

4. **Sync models** (`fastapi_app/lib/models_sync.py`)
   - Pydantic models - mostly generic, reusable

5. **Dependencies** (`fastapi_app/lib/dependencies.py`)
   - `get_sync_service()` - WebDAV-specific factory

6. **Configuration** (`fastapi_app/config.py`)
   - `WEBDAV_*` environment variables

### Frontend Components

1. **Sync plugin** (`app/src/plugins/sync.js`)
   - WebDAV-specific, checks `webdavEnabled` state

2. **Application state** (`app/src/state.js`)
   - `webdavEnabled: boolean`

## Target State

### Core Sync Infrastructure (lib/sync/)

Create new `lib/sync/` package for generic sync infrastructure:

```
fastapi_app/lib/sync/
├── __init__.py           # Exports public API
├── base.py               # SyncServiceBase abstract class
└── models.py             # Generic sync models (moved from lib/models_sync.py)
```

#### lib/sync/__init__.py

```python
"""Core synchronization infrastructure.

This package provides abstract interfaces and models for sync implementations.
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
```

#### lib/sync/base.py

```python
"""Abstract base class for synchronization services."""

from abc import ABC, abstractmethod
from typing import Optional
from .models import SyncSummary, SyncStatusResponse, ConflictListResponse, ConflictResolution


class SyncServiceBase(ABC):
    """
    Abstract base class for sync implementations.

    Sync plugins implement this interface to provide synchronization
    with various backends (WebDAV, Git, cloud storage, etc.).

    SSE Events:
        Implementations should emit these events via SSEService:
        - syncProgress: int (0-100) - Progress percentage
        - syncMessage: str - Status message for user
    """

    @abstractmethod
    def check_status(self) -> SyncStatusResponse:
        """
        Check if synchronization is needed.

        Returns:
            SyncStatusResponse with sync status details
        """
        pass

    @abstractmethod
    def perform_sync(
        self,
        client_id: Optional[str] = None,
        force: bool = False
    ) -> SyncSummary:
        """
        Perform synchronization.

        Args:
            client_id: Client ID for SSE progress updates
            force: Force sync even if not needed

        Returns:
            SyncSummary with operation results
        """
        pass

    @abstractmethod
    def get_conflicts(self) -> ConflictListResponse:
        """
        Get list of sync conflicts.

        Returns:
            ConflictListResponse with conflict details
        """
        pass

    @abstractmethod
    def resolve_conflict(self, resolution: ConflictResolution) -> dict:
        """
        Resolve a sync conflict.

        Args:
            resolution: Resolution strategy

        Returns:
            Dict with result message
        """
        pass
```

#### lib/sync/models.py

Move from `lib/models_sync.py` with minor updates:

```python
"""Pydantic models for sync operations.

These models are generic and used by all sync implementations.
"""

from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional, Literal


class SyncStatusResponse(BaseModel):
    """Response model for sync status check."""
    needs_sync: bool
    unsynced_count: int
    last_sync_time: Optional[datetime] = None
    sync_in_progress: bool = False
    # Implementation-specific version tracking (optional)
    local_version: Optional[int] = None
    remote_version: Optional[int] = None


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
    uploaded: int = 0
    downloaded: int = 0
    deleted_local: int = 0
    deleted_remote: int = 0
    metadata_synced: int = 0
    conflicts: int = 0
    errors: int = 0
    duration_ms: int = 0
    message: Optional[str] = None
    # Implementation-specific version (optional)
    new_version: Optional[int] = None


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
```

### WebDAV Sync Plugin

Move WebDAV-specific implementation to plugin:

```
fastapi_app/plugins/webdav_sync/
├── __init__.py
├── plugin.py              # Plugin class
├── routes.py              # Custom routes
├── service.py             # WebDAV sync service (implements SyncServiceBase)
├── remote_metadata.py     # Moved from lib/remote_metadata.py
└── tests/
    └── test_plugin.py
```

#### plugin.py

```python
from fastapi_app.lib.plugin_base import Plugin
from fastapi_app.lib.plugin_tools import get_plugin_config
from typing import Any


class WebDavSyncPlugin(Plugin):
    """WebDAV synchronization plugin."""

    def __init__(self):
        super().__init__()
        self._init_config()

    def _init_config(self):
        """Initialize plugin configuration from environment variables."""
        get_plugin_config(
            "plugin.webdav-sync.enabled",
            "WEBDAV_ENABLED",
            default=False,
            value_type="boolean"
        )
        get_plugin_config(
            "plugin.webdav-sync.base-url",
            "WEBDAV_BASE_URL",
            default=""
        )
        get_plugin_config(
            "plugin.webdav-sync.username",
            "WEBDAV_USERNAME",
            default=""
        )
        get_plugin_config(
            "plugin.webdav-sync.password",
            "WEBDAV_PASSWORD",
            default=""
        )
        get_plugin_config(
            "plugin.webdav-sync.remote-root",
            "WEBDAV_REMOTE_ROOT",
            default="/pdf-tei-editor"
        )

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "webdav-sync",
            "name": "WebDAV Sync",
            "description": "Synchronize files with WebDAV server",
            "category": "sync",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "sync",
                    "label": "Sync Now",
                    "description": "Synchronize with WebDAV server",
                    "state_params": []
                }
            ]
        }

    @classmethod
    def is_available(cls) -> bool:
        """Only available if WebDAV is configured."""
        from fastapi_app.lib.plugin_tools import get_plugin_config

        enabled = get_plugin_config(
            "plugin.webdav-sync.enabled",
            "WEBDAV_ENABLED",
            default=False,
            value_type="boolean"
        )
        if not enabled:
            return False

        base_url = get_plugin_config(
            "plugin.webdav-sync.base-url",
            "WEBDAV_BASE_URL",
            default=""
        )
        return bool(base_url)

    def get_endpoints(self) -> dict[str, Any]:
        return {
            "sync": self.execute_sync
        }

    async def execute_sync(self, context, params: dict) -> dict:
        """Execute sync via custom route (preview/execute pattern)."""
        preview_url = "/api/plugins/webdav-sync/preview"
        execute_url = "/api/plugins/webdav-sync/execute"

        return {
            "outputUrl": preview_url,
            "executeUrl": execute_url
        }
```

### Frontend: Generalized Sync

1. **Replace `webdavEnabled` with `syncEnabled`**

   In `app/src/state.js`:
   ```javascript
   syncEnabled: false,  // True if any sync plugin is available
   ```

2. **Update sync.js plugin**

   ```javascript
   // Get available sync plugins from backend
   async function getSyncPlugins() {
     const plugins = await api.getBackendPlugins();
     return plugins.filter(p => p.category === 'sync');
   }

   async function install(state) {
     const syncPlugins = await getSyncPlugins();
     currentSyncPlugin = syncPlugins.length > 0 ? syncPlugins[0] : null;

     // SSE events remain the same - all sync plugins use same event names
     sse.addEventListener('syncProgress', handleProgress);
     sse.addEventListener('syncMessage', handleMessage);
   }

   function update(state) {
     // Show sync UI if any sync plugin is available
     syncContainer.style.display = state.syncEnabled ? 'flex' : 'none';
   }

   async function syncFiles(state) {
     if (!currentSyncPlugin) return { skipped: true };

     // Execute via backend plugin API
     const result = await api.executeBackendPlugin(
       currentSyncPlugin.id,
       'sync',
       {}
     );
     return result;
   }
   ```

## Implementation Steps

### Phase 1: Create lib/sync/ Package

1. **Create directory structure**
   ```
   fastapi_app/lib/sync/
   ├── __init__.py
   ├── base.py
   └── models.py
   ```

2. **Move models from lib/models_sync.py**
   - Copy to `lib/sync/models.py`
   - Update imports

3. **Create abstract base class**
   - Implement `lib/sync/base.py`

4. **Update imports throughout codebase**
   - Change `from ..lib.models_sync import ...` to `from ..lib.sync import ...`

### Phase 2: Create WebDAV Sync Plugin

1. **Create plugin directory structure**
   ```
   fastapi_app/plugins/webdav_sync/
   ```

2. **Move WebDAV-specific code**
   - Move `lib/sync_service.py` → `webdav_sync/service.py`
   - Move `lib/remote_metadata.py` → `webdav_sync/remote_metadata.py`
   - Update `service.py` to implement `SyncServiceBase`

3. **Create plugin.py**
   - Plugin class with `is_available()` checking config

4. **Create routes.py**
   - Follow preview/execute pattern
   - Routes at `/api/plugins/webdav-sync/*`

### Phase 3: Update Event Bus

1. **Define standard file events** (document in `lib/event_bus.py`):
   ```python
   # Events emitted by core file operations
   "file.saved"    # stable_id, file_type
   "file.created"  # stable_id, file_type
   "file.deleted"  # stable_id
   ```

2. **Emit events from routers**
   - `files_save.py`: emit `file.saved`/`file.created`
   - File deletion routes: emit `file.deleted`

3. **Plugins can subscribe** (optional auto-sync feature)
   ```python
   def __init__(self):
       super().__init__()
       bus = get_event_bus()
       bus.on("file.saved", self._on_file_saved)
   ```

### Phase 4: Remove Core WebDAV Dependencies

1. **Remove `routers/sync.py`**
   - Functionality moved to plugin routes

2. **Remove from dependencies.py**
   - Remove `get_sync_service()` function
   - Remove `SyncService` import

3. **Delete old files**
   - Delete `lib/sync_service.py`
   - Delete `lib/remote_metadata.py`
   - Delete `lib/models_sync.py` (after migration)

### Phase 5: Update Frontend

1. **Update state.js**
   - Rename `webdavEnabled` → `syncEnabled`

2. **Update sync.js**
   - Generalize to work with any sync plugin

3. **Update start.js**
   - Check for sync plugins instead of `webdavEnabled`

4. **Update document-actions.js**
   - Calls to `sync.syncFiles()` remain unchanged

## API Changes

### New Plugin Routes

| Endpoint | Description |
|----------|-------------|
| `GET /api/plugins/webdav-sync/status` | Check sync status |
| `GET /api/plugins/webdav-sync/preview` | Preview sync changes |
| `GET /api/plugins/webdav-sync/execute` | Execute sync |
| `GET /api/plugins/webdav-sync/conflicts` | List conflicts |
| `POST /api/plugins/webdav-sync/resolve` | Resolve conflict |

### Deprecated Routes

| Old Route | Status |
|-----------|--------|
| `GET /api/v1/sync/status` | Deprecated, remove in v1.x |
| `POST /api/v1/sync` | Deprecated, remove in v1.x |
| `GET /api/v1/sync/conflicts` | Deprecated, remove in v1.x |
| `POST /api/v1/sync/resolve-conflict` | Deprecated, remove in v1.x |

### Config State API

Update `GET /api/v1/config/state`:
- Add `sync_enabled: boolean` (derived from plugin availability)
- Deprecate `webdav_enabled` (keep for backwards compatibility)

## File Changes Summary

### New Files

```
fastapi_app/lib/sync/__init__.py
fastapi_app/lib/sync/base.py
fastapi_app/lib/sync/models.py
fastapi_app/plugins/webdav_sync/__init__.py
fastapi_app/plugins/webdav_sync/plugin.py
fastapi_app/plugins/webdav_sync/routes.py
fastapi_app/plugins/webdav_sync/service.py
fastapi_app/plugins/webdav_sync/remote_metadata.py
fastapi_app/plugins/webdav_sync/tests/test_plugin.py
```

### Deleted Files

```
fastapi_app/lib/sync_service.py
fastapi_app/lib/remote_metadata.py
fastapi_app/lib/models_sync.py
fastapi_app/routers/sync.py
```

### Modified Files

```
fastapi_app/lib/dependencies.py  # Remove get_sync_service()
fastapi_app/config.py            # Keep WEBDAV_* vars for plugin
app/src/state.js                 # webdavEnabled → syncEnabled
app/src/plugins/sync.js          # Generalize for any sync plugin
app/src/plugins/start.js         # Check syncEnabled instead of webdavEnabled
app/src/plugins/document-actions.js  # Minimal changes
```

## Testing

1. **Core tests** (`lib/sync/tests/`)
   - Test `SyncServiceBase` interface contract
   - Test models serialization

2. **Plugin tests** (`webdav_sync/tests/`)
   - Test `is_available()` with various configs
   - Test sync operations with mocked WebDAV

3. **Frontend tests**
   - Test sync UI with plugin discovery
   - Test fallback when no sync plugins

## Benefits

1. **Decoupled architecture** - Core doesn't know about WebDAV
2. **Organized code** - Sync infrastructure in `lib/sync/`
3. **Extensible** - Easy to add Git sync, S3 sync, etc.
4. **Consistent patterns** - Same plugin architecture as `local_sync`
5. **Event-driven** - Plugins can react to file changes

## Future Sync Plugins (Examples)

1. **git_sync** - Sync with Git repository
2. **s3_sync** - Sync with S3 bucket
3. **dropbox_sync** - Sync with Dropbox

All would implement `SyncServiceBase` and use the same SSE events for progress.

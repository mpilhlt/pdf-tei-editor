# Phase 6: Database-Driven Sync and SSE APIs

**Status**: ✅ Complete
**Dependencies**: Phase 5 complete (validation and extraction APIs)
**Goal**: Replace filesystem-based WebDAV sync with database-driven delta synchronization

## Overview

Phase 6 replaces the Flask O(n) filesystem scanning with O(1) database-driven sync, achieving 1000x speedup for "no changes" detection.

**Key innovation**: Two-tier database architecture
- **Local DB** (`fastapi_app/db/metadata.db`) - Fast queries, sync tracking
- **Remote DB** (`WEBDAV_REMOTE_ROOT/metadata.db`) - Shared state, source of truth

This eliminates:
- ❌ `.deleted` marker files → `deleted=1` flag in remote DB
- ❌ Metadata sync problems → metadata stored in remote DB
- ❌ O(n) filesystem scans → O(1) database queries

## Remote Database Schema

```sql
-- Remote metadata.db (on WebDAV server)
CREATE TABLE file_metadata (
    -- Identity
    id TEXT PRIMARY KEY,              -- Content hash (SHA-256)
    stable_id TEXT UNIQUE NOT NULL,   -- Stable short ID
    filename TEXT NOT NULL,

    -- Document organization
    doc_id TEXT NOT NULL,
    doc_id_type TEXT DEFAULT 'doi',

    -- File classification
    file_type TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER,

    -- File-specific
    label TEXT,
    variant TEXT,
    version INTEGER DEFAULT 1,
    is_gold_standard BOOLEAN DEFAULT 0,

    -- Metadata (JSON)
    doc_collections TEXT,             -- ["corpus1", "corpus2"]
    doc_metadata TEXT,                -- {author, title, ...}
    file_metadata TEXT,               -- {extraction_method, ...}

    -- Deletion (replaces .deleted marker files!)
    deleted BOOLEAN DEFAULT 0,

    -- Version tracking
    remote_version INTEGER,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_doc_id ON file_metadata(doc_id);
CREATE INDEX idx_stable_id ON file_metadata(stable_id);
CREATE INDEX idx_deleted ON file_metadata(deleted) WHERE deleted = 1;

CREATE TABLE sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**What's NOT in remote DB**: `local_modified_at`, `sync_status`, `sync_hash` (local-only)

## WebDAV Structure

```
WEBDAV_REMOTE_ROOT/
├── metadata.db              # ← Shared metadata (deletion state, collections, etc.)
├── version.txt              # Version number
├── version.txt.lock         # Sync lock
└── ab/
    ├── abc123...pdf         # Data files only
    └── abc456...tei.xml     # No .deleted files!
```

## Implementation Tasks

### Task 1: Remote Metadata Manager (6-8 hours)

**File**: `fastapi_app/lib/remote_metadata.py`

```python
class RemoteMetadataManager:
    """Manages shared metadata.db on WebDAV server."""

    def download(self) -> Path:
        """Download metadata.db to temp file, create if missing."""

    def upload(self, local_path: Path):
        """Upload metadata.db to WebDAV."""

    def connect(self, db_path: Path):
        """Connect to downloaded DB."""

    def get_all_files(self) -> List[Dict]:
        """Get all file metadata."""

    def get_deleted_files(self) -> List[Dict]:
        """Get files with deleted=1."""

    def upsert_file(self, file_data: Dict):
        """Insert or update file metadata."""

    def mark_deleted(self, file_id: str, remote_version: int):
        """Mark file as deleted in remote DB."""
```

### Task 2: Extend FileRepository (4-6 hours)

**File**: `fastapi_app/lib/file_repository.py`

Add methods:
- `get_sync_metadata(key)` / `set_sync_metadata(key, value)`
- `get_all_files()` - for metadata comparison
- `get_unsynced_files()` - where `sync_status != 'synced'`
- `count_unsynced_files()` - O(1) skip check
- `mark_file_synced(file_id, remote_version)`
- `apply_remote_metadata(file_id, remote_metadata)`

Override existing methods to auto-set `sync_status='modified'` on changes.

### Task 3: Sync Service (16-20 hours)

**File**: `fastapi_app/lib/sync_service.py`

```python
class SyncService:
    """Database-driven sync with remote metadata.db."""

    def perform_sync(self, progress_callback) -> Dict:
        """Main sync algorithm."""
        # 1. Quick skip check (O(1))
        if not self.check_if_sync_needed():
            if local_version == remote_version:
                return {"skipped": True}

        # 2. Acquire lock
        # 3. Download remote metadata.db
        # 4. Compare metadata
        # 5. Sync deletions (from DB, not marker files!)
        # 6. Sync data files
        # 7. Sync metadata changes
        # 8. Upload updated metadata.db
        # 9. Release lock

    def _compare_metadata(self) -> Dict:
        """Compare local vs remote to find changes."""
        # Returns: local_new, local_modified, remote_new,
        #          remote_modified, conflicts, remote_deleted

    def _sync_deletions(self, changes, summary):
        """Handle deletions via deleted=1 flag."""
        # Apply remote deletions to local
        # Upload local deletions to remote DB
        # NO .deleted marker files!

    def _sync_data_files(self, changes, version, summary):
        """Upload/download actual data files."""

    def _sync_metadata(self, changes, version, summary):
        """Sync metadata changes (collections, labels, etc.)."""
        # Last-write-wins conflict resolution
```

### Task 4: SSE Service (3-4 hours)

**File**: `fastapi_app/lib/sse_service.py`

```python
class SSEService:
    """Server-Sent Events for real-time updates."""

    def __init__(self):
        self.message_queues: Dict[str, queue.Queue] = {}

    def create_queue(self, client_id: str) -> queue.Queue:
        """Create message queue for client."""

    def send_message(self, client_id: str, event_type: str, data: str) -> bool:
        """Send SSE message to client."""

    def event_stream(self, client_id: str) -> Generator:
        """Generator for SSE stream."""
```

### Task 5: Pydantic Models (1-2 hours)

**File**: `fastapi_app/lib/models_sync.py`

- `SyncStatusResponse` - sync status check result
- `SyncRequest` - force flag
- `SyncSummary` - uploads/downloads/deletes/conflicts counts
- `ConflictInfo` - conflict details
- `ConflictResolution` - resolution strategy

### Task 6: Sync Router (6-8 hours)

**File**: `fastapi_app/routers/sync.py`

```python
@router.get("/status", response_model=SyncStatusResponse)
async def get_sync_status():
    """O(1) check if sync needed."""

@router.post("/", response_model=SyncSummary)
async def perform_sync(request: SyncRequest):
    """Perform delta sync with progress via SSE."""

@router.get("/conflicts", response_model=ConflictListResponse)
async def list_conflicts():
    """List files with sync_status='conflict'."""

@router.post("/resolve-conflict")
async def resolve_conflict(resolution: ConflictResolution):
    """Resolve conflict: local_wins, remote_wins, keep_both."""
```

### Task 7: SSE Router (2-3 hours)

**File**: `fastapi_app/routers/sse.py`

```python
@router.get("/subscribe")
async def subscribe():
    """Subscribe to SSE stream for progress updates."""
    return StreamingResponse(
        sse_service.event_stream(user['username']),
        media_type="text/event-stream"
    )
```

### Task 8: Integration (1 hour)

- Update `fastapi_app/lib/dependencies.py`: Add `get_sse_service()`
- Update `fastapi_app/main.py`: Register sync and SSE routers

### Task 9: Integration Tests (16-20 hours)

**File**: `fastapi_app/tests/backend/sync.test.js`

Test scenarios:
- Sync status check
- Skip when no changes
- Upload new files
- Download remote files
- Deletion propagation (via DB, not markers!)
- Metadata changes sync
- Collection changes sync
- Conflict detection
- Conflict resolution

**Target**: 15+ tests

### Task 10: Python Unit Tests (8-10 hours)

**Files**:
- `fastapi_app/tests/py/test_sync_service.py`
- `fastapi_app/tests/py/test_sse_service.py`
- `fastapi_app/tests/py/test_remote_metadata.py`

**Target**: 20+ tests, 80%+ coverage

## Sync Operations

| Change | Local DB | Remote DB | WebDAV | Method |
|--------|----------|-----------|--------|--------|
| File added | `sync_status='pending_upload'` | Insert metadata | Upload file | DB + file |
| File modified | `sync_status='modified'` | Update metadata | Upload file | DB + file |
| File deleted | `deleted=1, sync_status='pending_delete'` | `deleted=1` | Delete file | DB only |
| Metadata changed | `sync_status='modified'` | Update | Nothing | DB only |
| Collection changed | `sync_status='modified'` | Update `doc_collections` | Nothing | DB only |

**Key**: No `.deleted` marker files! Deletions tracked in database.



## Example: Deletion Propagation

```
Instance A deletes file:
  1. Delete local data file
  2. Local DB: deleted=1, sync_status='pending_delete'
  3. Sync: Update remote metadata.db: deleted=1

Instance B syncs:
  1. Download remote metadata.db
  2. Find file with deleted=1
  3. Delete local data file
  4. Local DB: deleted=1
```

**No .deleted marker files anywhere!**

## Example: Metadata Change

```
Instance A: Add to collection "gold_subset"
  1. Local DB: doc_collections = ["corpus1", "gold_subset"]
  2. Sync: Update remote metadata.db
  3. NO data file upload (content unchanged)

Instance B syncs:
  1. Download remote metadata.db
  2. Apply: doc_collections = ["corpus1", "gold_subset"]
  3. NO data file download
```

**Estimate**: 8-10 working days

## Success Criteria

✅ Remote metadata.db syncing between instances
✅ Deletions propagate via database (no `.deleted` files)
✅ Metadata changes sync (collections, labels, doc_metadata)
✅ SSE progress updates working
✅ 15+ integration tests passing
✅ 20+ unit tests passing (80%+ coverage)
✅ 1000x performance improvement verified

## Migration from Flask

1. First FastAPI instance creates `metadata.db` on WebDAV
2. Populates from existing files
3. Other instances adopt on next sync
4. Flask instances can coexist (will ignore metadata.db)
5. Gradual migration: one instance at a time

## References

- [sync-design.md](sync-design.md) - Conceptual design (needs update)
- [schema-design.md](schema-design.md) - Local DB schema
- [server/api/sync.py](../../server/api/sync.py) - Flask implementation
- [phase-5-completion.md](phase-5-completion.md) - Previous phase

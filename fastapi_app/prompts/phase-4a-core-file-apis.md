# Phase 4A: Core File Management APIs

**Status**: In Progress
**Goal**: Implement essential file APIs for reading and uploading files with hash abbreviation support.

## Overview

Phase 4 has been split into two sub-phases for manageable implementation:

- **Phase 4A** (This document): Core read/write file APIs - list, serve, upload + supporting libraries
- **Phase 4B**: Advanced file operations - save, delete, move, locks, heartbeat + migration tools

This phase implements the minimum viable file management system needed for frontend integration.

## Completion Status

### ✅ Completed

- [x] Hash abbreviation system (`lib/hash_abbreviation.py`)
- [x] Pydantic models for all file APIs (`lib/models_files.py`)
- [x] FastAPI dependencies (`lib/dependencies.py`)

### 🔄 In Progress

- [ ] Port locking system (`lib/locking.py`)
- [ ] Port access control (`lib/access_control.py`)
- [ ] File list API (`routers/files_list.py`)
- [ ] File serving API (`routers/files_serve.py`)
- [ ] File upload API (`routers/files_upload.py`)
- [ ] Update `file_repository.py` with hash resolution
- [ ] Create routers directory and init
- [ ] Register routers in `main.py`
- [ ] Basic integration tests

### ⏸️ Deferred to Phase 4B

- File save API (complex versioning logic)
- File delete API
- File move API
- File locks API endpoints
- Heartbeat API
- File importer for Flask migration
- CLI migration tools
- Comprehensive test suite

## Tasks for Phase 4A

### 1. Port Locking System ✅ (Next)

**File**: `fastapi_app/lib/locking.py`

Port from `server/lib/locking.py` with these changes:

- Remove Flask dependencies (`current_app`, `ApiError`)
- Use `settings.db_dir` instead of `current_app.config`
- Accept `logger` as parameter instead of using `current_app.logger`
- Use hash-based file identification instead of paths
- Keep SQLite-based implementation (same schema)

**Key functions to port**:
```python
def init_locks_db(db_dir: Path, logger) -> None
def acquire_lock(file_hash: str, session_id: str, db_dir: Path, logger) -> bool
def release_lock(file_hash: str, session_id: str, db_dir: Path, logger) -> Dict
def check_lock(file_hash: str, session_id: str, db_dir: Path, logger) -> Dict
def get_all_active_locks(db_dir: Path, logger) -> Dict[str, str]
def cleanup_stale_locks(db_dir: Path, logger, timeout_seconds: int = 90) -> int
```

### 2. Port Access Control ✅

**File**: `fastapi_app/lib/access_control.py`

Port from `server/lib/access_control.py` with these changes:

- Remove Flask dependencies
- Work with Pydantic models instead of dicts
- Use database queries instead of file-based lookups
- Keep same permission logic (admin, reviewer, annotator)

**Key functions to port**:
```python
def check_file_access(file_metadata: FileMetadata, user: Optional[Dict], operation: str) -> bool
def filter_files_by_access(files: List[FileMetadata], user: Optional[Dict]) -> List[FileMetadata]
class DocumentAccessFilter:
    @staticmethod
    def filter_files_by_access(documents: List[DocumentGroup], user: Optional[Dict]) -> List[DocumentGroup]
```

### 3. Update File Repository ✅

**File**: `fastapi_app/lib/file_repository.py`

Add hash resolution methods:

```python
def resolve_file_id(self, file_id: str, abbreviator: Optional[HashAbbreviator] = None) -> str:
    """
    Resolve abbreviated or full hash to full hash.

    Args:
        file_id: Abbreviated hash (5+ chars) or full hash (64 chars)
        abbreviator: Optional HashAbbreviator instance

    Returns:
        Full SHA-256 hash (64 chars)

    Raises:
        ValueError: If hash cannot be resolved
    """
    # If already 64 chars, assume it's a full hash
    if len(file_id) == 64:
        return file_id

    # Use abbreviator to resolve
    if abbreviator is None:
        abbreviator = get_abbreviator(self)

    try:
        return abbreviator.resolve(file_id)
    except KeyError:
        raise ValueError(f"Cannot resolve file ID: {file_id}")

def get_file_by_id_or_abbreviated(
    self,
    file_id: str,
    abbreviator: Optional[HashAbbreviator] = None
) -> Optional[FileMetadata]:
    """Get file by abbreviated or full hash"""
    full_hash = self.resolve_file_id(file_id, abbreviator)
    return self.get_file_by_id(full_hash)
```

### 4. Create Routers Directory

```bash
mkdir -p fastapi_app/routers
touch fastapi_app/routers/__init__.py
```

### 5. File List API ✅

**File**: `fastapi_app/routers/files_list.py`

Implements: `GET /api/files/list`

Replaces: `server/api/files/list.py`

**Key features**:
- Database queries instead of filesystem scan
- Document-centric grouping (PDF + TEI files)
- Abbreviated hashes in response
- Lock status integration
- Access control filtering
- Optional variant filtering

**Response structure**:
```json
{
  "files": [
    {
      "doc_id": "10.1234/paper1",
      "doc_collections": ["corpus1"],
      "doc_metadata": {...},
      "pdf": {
        "id": "abc12",  // 5-char abbreviated hash
        "filename": "abc123...def.pdf",
        "file_type": "pdf",
        ...
      },
      "versions": [{...}],
      "gold": [{...}],
      "variants": {"grobid": [{...}]}
    }
  ]
}
```

### 6. File Serving API ✅

**File**: `fastapi_app/routers/files_serve.py`

Implements: `GET /api/files/{document_id}`

Replaces: `server/api/files/serve_file_by_id.py`

**Key features**:
- Accept abbreviated or full hash
- Look up in database
- Serve from hash-sharded storage
- Access control enforcement
- Proper MIME types

### 7. File Upload API ✅

**File**: `fastapi_app/routers/files_upload.py`

Implements: `POST /api/files/upload`

Replaces: `server/api/files/upload.py`

**Key features**:
- Upload PDF or XML files
- Save to hash-sharded storage
- Store metadata in database
- MIME type validation
- Return abbreviated hash

**Response**:
```json
{
  "type": "pdf",
  "filename": "abc12"  // abbreviated hash
}
```

### 8. Register Routers in Main ✅

**File**: `fastapi_app/main.py`

Add imports and router registration:

```python
# Import file routers
from .routers import files_list, files_serve, files_upload

# Register with API router
api_v1.include_router(files_list.router)
api_v1.include_router(files_serve.router)
api_v1.include_router(files_upload.router)
```

### 9. Basic Integration Tests ✅

**Files**: `fastapi_app/tests/backend/files_*.test.js`

Create basic tests for:
- List files (empty, with files, with filters)
- Serve file (by abbreviated hash, by full hash, 404, access control)
- Upload file (PDF, XML, invalid type)

Run with:
```bash
npm run dev:fastapi  # Terminal 1
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_list.test.js  # Terminal 2
```

## Architecture Decisions

### Hash Abbreviation Flow

**Upload**:
```
Client uploads → Server generates SHA-256 → Save to storage
→ Insert to DB with full hash → Return abbreviated hash to client
```

**List**:
```
Client requests list → Server queries DB → Get all full hashes
→ Abbreviate all hashes → Return documents with abbreviated IDs
```

**Serve**:
```
Client requests file by abbreviated hash → Server resolves to full hash
→ Look up in DB → Serve from storage
```

### Access Control

- **Public files**: No restrictions
- **Collection-restricted**: Check user's allowed collections
- **Role-based**: Reviewer > Annotator > Guest
- Applied at query time (filter in memory, not in SQL for simplicity)

### Lock Integration

- File list includes lock status (`is_locked: true` if locked by another session)
- Lock status checked against current session ID
- Locks managed in separate `locks.db` (same as Flask)

## Testing Strategy

### Unit Tests (Python)
```python
# tests/py/test_hash_abbreviation.py
def test_abbreviation_no_collision():
    """5 chars sufficient for small dataset"""

def test_abbreviation_with_collision():
    """Auto-increase to 6 chars on collision"""

def test_resolution():
    """Resolve abbreviated to full hash"""
```

### Integration Tests (JavaScript)
```javascript
// tests/backend/files_list.test.js
test('lists files with abbreviated hashes', async () => {
  const response = await fetch('/api/files/list');
  const data = await response.json();
  assert(data.files[0].pdf.id.length === 5);
});

test('serves file by abbreviated hash', async () => {
  const response = await fetch('/api/files/abc12');
  assert(response.ok);
});
```

## Success Criteria

Phase 4A is complete when:

- ✅ Locking system ported and working
- ✅ Access control ported and working
- ✅ File list API returns document-centric structure with abbreviated hashes
- ✅ File serve API accepts abbreviated hashes and serves files
- ✅ File upload API saves to hash-sharded storage and returns abbreviated hash
- ✅ All routers registered and accessible at `/api/files/*`
- ✅ Basic integration tests pass
- ✅ Frontend can list files, view PDFs, and upload new files

## Next Steps After 4A

Once Phase 4A is complete and tested, proceed to:

→ **[Phase 4B: Advanced File Operations](phase-4b-advanced-file-ops.md)**

This includes:
- File save API (complex versioning logic)
- File delete/move APIs
- File locks/heartbeat APIs
- File importer for Flask migration
- CLI migration tools
- Comprehensive test coverage

## Reference Files

- Original plan: [phase-4-file-management.md](phase-4-file-management.md)
- Flask implementations: `server/api/files/*.py`
- Database schema: [schema-design.md](schema-design.md)

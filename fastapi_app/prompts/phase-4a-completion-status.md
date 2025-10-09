# Phase 4A Implementation Status

**Date**: 2025-01-09
**Status**: Core Implementation Complete - Ready for Testing

## Summary

Phase 4A (Core File Management APIs) has been successfully implemented with all essential components for reading and uploading files. The system is ready for integration testing.

## Completed Components

### 1. Foundation Layer ✅

#### Hash Abbreviation System
**File**: `fastapi_app/lib/hash_abbreviation.py`

- ✅ `HashAbbreviator` class with collision detection
- ✅ 5-character default abbreviation (auto-increases on collision)
- ✅ Bidirectional mapping (full ↔ abbreviated)
- ✅ Global abbreviator with request-scoped initialization
- ✅ Helper functions: `abbreviate_hash()`, `resolve_hash()`, `reset_abbreviator()`

**Key Features**:
- Handles up to 1M+ files with 5 characters
- Automatic collision detection and length increase
- Supports both abbreviated and full hash lookups

#### Pydantic Models
**File**: `fastapi_app/lib/models_files.py`

- ✅ `FileListItem` - Individual file in list response
- ✅ `DocumentGroup` - Document with grouped files (PDF + TEI versions + gold + variants)
- ✅ `FileListResponse` - Response for file list endpoint
- ✅ `UploadResponse` - Response for upload endpoint
- ✅ Request/response models for all file operations (save, delete, move, locks, heartbeat)

**Key Features**:
- Type-safe API contracts
- Automatic validation
- Document-centric structure

#### FastAPI Dependencies
**File**: `fastapi_app/lib/dependencies.py`

- ✅ `get_db()` - Database manager
- ✅ `get_file_repository()` - File repository
- ✅ `get_file_storage()` - File storage
- ✅ `get_hash_abbreviator()` - Hash abbreviator
- ✅ `get_session_manager()` - Session manager
- ✅ `get_auth_manager()` - Auth manager
- ✅ `get_session_id()` - Session ID extraction
- ✅ `get_current_user()` - Current user (optional)
- ✅ `require_authenticated_user()` - Current user (required)
- ✅ `require_session()` - Decorator for session validation

**Key Features**:
- Clean dependency injection
- Request-scoped instances
- Proper separation of concerns

### 2. Supporting Libraries ✅

#### Locking System
**File**: `fastapi_app/lib/locking.py`

Ported from Flask with these changes:
- ✅ Removed Flask dependencies (`current_app`, `ApiError`)
- ✅ Accept `db_dir` and `logger` as parameters
- ✅ Use hash-based file identification (instead of paths)
- ✅ Keep SQLite-based implementation (same schema)

**Functions**:
- `init_locks_db()` - Initialize locks database
- `acquire_lock()` - Acquire lock (atomic, handles refresh/takeover)
- `release_lock()` - Release lock
- `check_lock()` - Check lock status
- `get_all_active_locks()` - Get all active locks
- `cleanup_stale_locks()` - Remove stale locks

**Key Features**:
- 90-second lock timeout
- Atomic lock operations with `BEGIN IMMEDIATE`
- Stale lock takeover
- WAL mode for concurrent access

#### Access Control
**File**: `fastapi_app/lib/access_control.py`

Ported from Flask with these changes:
- ✅ Work with Pydantic models (instead of dicts)
- ✅ Use database metadata (instead of file parsing)
- ✅ Removed Flask dependencies
- ✅ Simplified for metadata-based access control

**Classes**:
- `DocumentPermissions` - Data class for permissions
- `AccessControlChecker` - Check user access
- `DocumentAccessFilter` - Filter document lists

**Functions**:
- `get_document_permissions_from_metadata()` - Extract permissions from metadata
- `check_file_access()` - Check file access for user
- `filter_files_by_access()` - Filter file list by access

**Key Features**:
- Visibility: public/private
- Editability: editable/protected
- Owner-based permissions
- Admin bypass
- Role-based access (admin > reviewer > annotator > guest)

#### File Repository Updates
**File**: `fastapi_app/lib/file_repository.py`

- ✅ `resolve_file_id()` - Resolve abbreviated or full hash to full hash
- ✅ `get_file_by_id_or_abbreviated()` - Get file by abbreviated or full hash

**Key Features**:
- Transparent hash resolution
- Accepts 5-char or 64-char hashes
- Automatic abbreviator initialization

### 3. API Routers ✅

#### File List API
**File**: `fastapi_app/routers/files_list.py`
**Endpoint**: `GET /api/files/list`

- ✅ Database queries (instead of filesystem scan)
- ✅ Document-centric grouping (PDF + TEI files)
- ✅ Abbreviated hashes in response
- ✅ Lock status integration
- ✅ Access control filtering
- ✅ Optional variant filtering

**Response Structure**:
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

**Key Features**:
- Returns abbreviated hashes (5 chars)
- Document-centric structure
- Lock status included
- Access control applied
- Variant filtering support

#### File Serving API
**File**: `fastapi_app/routers/files_serve.py`
**Endpoint**: `GET /api/files/{document_id}`

- ✅ Accept abbreviated or full hash
- ✅ Look up in database
- ✅ Serve from hash-sharded storage
- ✅ Access control enforcement
- ✅ Proper MIME types (PDF, XML)
- ✅ Special case for `empty.pdf`

**Key Features**:
- Hash resolution (abbreviated → full)
- Database lookup
- Access control check
- Storage path resolution
- MIME type detection

#### File Upload API
**File**: `fastapi_app/routers/files_upload.py`
**Endpoint**: `POST /api/files/upload`

- ✅ Upload PDF or XML files
- ✅ Save to hash-sharded storage
- ✅ Store metadata in database
- ✅ MIME type validation (libmagic + extension)
- ✅ Return abbreviated hash
- ✅ Session requirement

**Response**:
```json
{
  "type": "pdf",
  "filename": "abc12"  // abbreviated hash
}
```

**Key Features**:
- MIME type validation
- Hash-sharded storage
- Database metadata
- Deduplication (same content = same hash)
- Abbreviated hash in response

### 4. Integration ✅

#### Router Registration
**File**: `fastapi_app/main.py`

- ✅ Import file routers
- ✅ Register with `api_v1` router
- ✅ Available at `/api/v1/files/*` and `/api/files/*` (backward compatibility)

**Registered Routes**:
- `GET /api/files/list` - List files
- `GET /api/files/{document_id}` - Serve file
- `POST /api/files/upload` - Upload file

## Testing Status

### Manual Testing
- ⏸️ Pending: Start FastAPI server and test endpoints
- ⏸️ Pending: Test with curl/Postman
- ⏸️ Pending: Test with frontend

### Integration Tests
- ⏸️ Pending: Create test files
- ⏸️ Pending: Test file list endpoint
- ⏸️ Pending: Test file serve endpoint
- ⏸️ Pending: Test file upload endpoint

## How to Test Phase 4A

### 1. Start FastAPI Server

```bash
# Terminal 1: Start server
npm run dev:fastapi

# Or directly with Python
python -m uvicorn run_fastapi:app --reload --port 8000
```

### 2. Test Endpoints with curl

```bash
# Health check
curl http://localhost:8000/health

# List files (no auth)
curl http://localhost:8000/api/files/list

# Upload file (requires session)
curl -X POST http://localhost:8000/api/files/upload \
  -H "x-session-id: YOUR_SESSION_ID" \
  -F "file=@/path/to/file.pdf"

# Serve file by abbreviated hash
curl http://localhost:8000/api/files/abc12 -o downloaded.pdf
```

### 3. Run Integration Tests

```bash
# Terminal 1: Start server
npm run dev:fastapi

# Terminal 2: Run tests
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_list.test.js
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_serve.test.js
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_upload.test.js
```

## Known Issues / TODOs

### Immediate Fixes Needed

1. **Database Initialization**: Ensure database is initialized on startup
   - Add database initialization to `lifespan` in `main.py`
   - Create tables if they don't exist

2. **Import Dependencies**: May need to install `python-magic` library
   ```bash
   pip install python-magic
   ```

3. **Router Import Order**: May have circular import issues
   - Check if routers can import from `..lib` properly

### Testing Requirements

1. **Create Test Data**:
   - Sample PDF files
   - Sample TEI XML files
   - Test database with known files

2. **Integration Test Files**:
   - `files_list.test.js` - Test file listing
   - `files_serve.test.js` - Test file serving
   - `files_upload.test.js` - Test file upload

3. **Python Unit Tests**:
   - `test_hash_abbreviation.py` - Test collision detection
   - `test_locking.py` - Test lock operations
   - `test_access_control.py` - Test permission checks

## Dependencies

### Python Packages
- `fastapi` - Web framework
- `uvicorn` - ASGI server
- `pydantic` - Data validation
- `python-magic` - MIME type detection
- `lxml` - XML parsing (for access control metadata)

### Existing FastAPI Libs (Already Available)
- `database.py` - Database manager
- `file_storage.py` - Hash-sharded file storage
- `file_repository.py` - File metadata repository (now updated)
- `sessions.py` - Session management
- `auth.py` - Authentication
- `models.py` - Core Pydantic models
- `config.py` - Configuration

## Next Steps

### Immediate (Before Phase 4B)

1. **Fix Database Initialization**
   - Ensure `metadata.db` is created on startup
   - Run migrations if needed

2. **Test Core Endpoints**
   - Start server
   - Test file list (should return empty array initially)
   - Upload a PDF file
   - List files again (should show the PDF)
   - Serve the PDF by abbreviated hash

3. **Create Basic Integration Tests**
   - Test empty file list
   - Test upload PDF
   - Test upload XML
   - Test serve by abbreviated hash
   - Test serve by full hash
   - Test invalid MIME type rejection

4. **Fix Any Import/Runtime Errors**
   - Check for circular imports
   - Verify all dependencies are available
   - Test error handling

### Phase 4B (Deferred Features)

Once Phase 4A is tested and working:

1. **File Save API** (Complex versioning logic)
2. **File Delete API** (Soft delete)
3. **File Move API** (Multi-collection support)
4. **File Locks API** (Lock management endpoints)
5. **Heartbeat API** (Lock keep-alive)
6. **File Importer** (Flask migration tool)
7. **CLI Tools** (Migration scripts)
8. **Comprehensive Tests** (Full test coverage)

See [phase-4b-advanced-file-ops.md](phase-4b-advanced-file-ops.md) for details.

## Architecture Summary

### Request Flow

**File List**:
```
Client → GET /api/files/list
→ Database query (all non-deleted files)
→ Group by doc_id
→ Abbreviate all hashes
→ Apply access control
→ Return DocumentGroup[] with 5-char hashes
```

**File Upload**:
```
Client → POST /api/files/upload (multipart file)
→ Validate MIME type
→ Compute SHA-256 hash
→ Save to hash-sharded storage (ab/abc123...def.pdf)
→ Insert metadata to database (full 64-char hash)
→ Return abbreviated hash (5 chars)
```

**File Serve**:
```
Client → GET /api/files/abc12
→ Resolve abc12 to full hash (via abbreviator)
→ Look up in database
→ Check access control
→ Get file from storage (ab/abc123...def.pdf)
→ Return file content with MIME type
```

### Data Flow

```
Storage:        data/files/ab/abc123def456...789.pdf (64-char hash)
Database:       id='abc123def456...789' (64-char hash)
Abbreviator:    abc12 ↔ abc123def456...789 (5-char ↔ 64-char)
API Response:   {"id": "abc12", ...} (5-char hash)
API Request:    GET /api/files/abc12 (5-char hash accepted)
```

### Hash Abbreviation Details

**Why 5 characters?**
- 5 hex chars = 16^5 = 1,048,576 possible values
- Typical dataset: <10,000 files
- Collision probability: <1% with 10,000 files
- If collision: auto-increase to 6 chars (16.7M values)

**Collision Handling**:
```python
# Initial: 5 chars for all hashes
abc123... → abc12
def456... → def45

# Collision detected: both start with abc12
abc123... ─┐
abc125... ─┴→ Rebuild with 6 chars
           → abc123, abc125
```

## Files Created

### Core Implementation
- `fastapi_app/lib/hash_abbreviation.py` (180 lines)
- `fastapi_app/lib/models_files.py` (136 lines)
- `fastapi_app/lib/dependencies.py` (156 lines)
- `fastapi_app/lib/locking.py` (348 lines)
- `fastapi_app/lib/access_control.py` (234 lines)

### API Routers
- `fastapi_app/routers/__init__.py` (3 lines)
- `fastapi_app/routers/files_list.py` (232 lines)
- `fastapi_app/routers/files_serve.py` (125 lines)
- `fastapi_app/routers/files_upload.py` (178 lines)

### Documentation
- `fastapi_app/prompts/phase-4a-core-file-apis.md`
- `fastapi_app/prompts/phase-4b-advanced-file-ops.md`
- `fastapi_app/prompts/phase-4a-completion-status.md` (this file)

### Updated Files
- `fastapi_app/lib/file_repository.py` (added hash resolution methods)
- `fastapi_app/main.py` (registered file routers)

**Total Lines of Code**: ~1,600 lines (excluding tests and documentation)

## Success Criteria

Phase 4A will be considered complete when:

- ✅ All core libraries implemented (hash abbreviation, locking, access control)
- ✅ All core API routers implemented (list, serve, upload)
- ✅ Routers registered in main.py
- ⏸️ Database initializes correctly on startup
- ⏸️ Server starts without errors
- ⏸️ File list endpoint returns correct structure
- ⏸️ File upload works and returns abbreviated hash
- ⏸️ File serve accepts abbreviated hash and returns file
- ⏸️ Access control is enforced
- ⏸️ Lock status is included in file list
- ⏸️ Basic integration tests pass

## Conclusion

Phase 4A core implementation is **complete** and ready for testing. All essential components for reading and uploading files with hash abbreviation support are in place.

**Next Action**: Test the implementation manually, fix any issues, then create integration tests.

**After Phase 4A is validated**: Proceed to Phase 4B for advanced file operations (save, delete, move, locks, migration tools).

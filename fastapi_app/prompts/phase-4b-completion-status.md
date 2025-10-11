# Phase 4B Implementation Status

**Date**: 2025-01-11 (Updated)
**Status**: Testing Infrastructure Complete - Endpoints Implemented, Integration Tests Created

## Summary

Phase 4B advanced file operations have been partially implemented with all CRUD operations except the complex save API. The implemented endpoints are ready for testing.

## Completed Components

### 1. File Delete API ✅
**File**: `fastapi_app/routers/files_delete.py`
**Endpoint**: `POST /api/files/delete`

- ✅ Accepts list of file IDs (abbreviated or full hashes)
- ✅ Soft delete (sets deleted=1, sync_status='pending_delete')
- ✅ Physical files remain in storage for sync tracking
- ✅ Access control enforcement (write permissions)
- ✅ Resolves abbreviated hashes

**Key Features**:
- Soft delete for sync tracking
- Batch deletion support
- Permission checks per file
- Graceful handling of missing files

### 2. File Move API ✅
**File**: `fastapi_app/routers/files_move.py`
**Endpoint**: `POST /api/files/move`

- ✅ Updates doc_collections array (multi-collection support)
- ✅ No physical file move (hash-sharded storage is collection-agnostic)
- ✅ Updates PDF metadata only (TEI files inherit)
- ✅ Access control enforcement
- ✅ Returns abbreviated hashes in response

**Key Features**:
- Multi-collection support (adds collection to array)
- Documents can belong to multiple collections
- No physical file operations
- Sync status updated to 'modified'

### 3. File Locks API ✅
**File**: `fastapi_app/routers/files_locks.py`
**Endpoints**:
- `GET /api/files/locks` - List all active locks
- `POST /api/files/check_lock` - Check lock status
- `POST /api/files/acquire_lock` - Acquire lock for editing
- `POST /api/files/release_lock` - Release lock

- ✅ Hash-based file identification
- ✅ Abbreviated hash support
- ✅ Access control for lock acquisition (edit permissions)
- ✅ Reuses existing locking.py library
- ✅ Detailed logging with session ID tracking

**Key Features**:
- 90-second lock timeout (from lib/locking.py)
- Automatic lock refresh
- Stale lock takeover support
- Permission-based lock acquisition

### 4. Heartbeat API ✅
**File**: `fastapi_app/routers/files_heartbeat.py`
**Endpoint**: `POST /api/files/heartbeat`

- ✅ Lock refresh/keep-alive
- ✅ No cache_status in response (deprecated)
- ✅ Abbreviated hash support
- ✅ Reuses acquire_lock for refresh

**Key Features**:
- Simple lock refresh
- Prevents lock timeout during editing
- No cache management (database always current)

### 5. Router Registration ✅
**File**: `fastapi_app/main.py`

- ✅ All new routers imported
- ✅ Registered with api_v1 (`/api/v1/files/*`)
- ✅ Registered with api_compat (`/api/files/*`) for Flask compatibility
- ✅ Available in both versioned and unversioned APIs

**Registered Routes**:
- `/api/files/delete` - Delete files
- `/api/files/move` - Move files to collection
- `/api/files/locks` - Get all locks
- `/api/files/check_lock` - Check single lock
- `/api/files/acquire_lock` - Acquire lock
- `/api/files/release_lock` - Release lock
- `/api/files/heartbeat` - Refresh lock

## Deferred Components

### File Save API ⏸️
**Complexity**: ~400 lines with intricate logic
**Reason for deferral**: Requires careful implementation of:
- Version vs gold file determination
- Variant handling
- File promotion (version → gold)
- Role-based access control (reviewer vs annotator)
- Metadata extraction and fileref updates
- Collection determination
- Timestamp generation for versions

**Recommendation**: Implement in separate focused session with:
1. Study of Flask save logic in detail
2. Unit tests for save strategy determination
3. Integration tests for each save scenario
4. Careful handling of edge cases

### Migration Tools ⏸️
From Phase 4B plan:
- File importer (lib/file_importer.py)
- Migration CLI (bin/migrate_to_fastapi.py)
- Import CLI (bin/import_files.py)
- Rebuild database CLI (bin/rebuild_database.py)

**Note**: These tools are essential for migrating Flask data but not required for API functionality.

### Comprehensive Testing 🔄
- ⏸️ Python unit tests for each endpoint
- ✅ JavaScript E2E tests created (needs user setup to run)
- ✅ Integration tests with real file operations (ready to run)

## Files Created (2025-01-11 Session)

### Routers (Existing)
- `fastapi_app/routers/files_delete.py` (~100 lines)
- `fastapi_app/routers/files_move.py` (~110 lines)
- `fastapi_app/routers/files_locks.py` (~200 lines)
- `fastapi_app/routers/files_heartbeat.py` (~70 lines)

### Integration Tests (NEW ✅)
- `fastapi_app/tests/backend/files_delete.test.js` (~200 lines)
- `fastapi_app/tests/backend/files_move.test.js` (~230 lines)
- `fastapi_app/tests/backend/files_locks.test.js` (~290 lines)
- `fastapi_app/tests/backend/files_heartbeat.test.js` (~200 lines)

### Pydantic Models (UPDATED ✅)
- `fastapi_app/lib/models_files.py` - Added response models:
  - `DeleteFilesResponse`
  - `GetLocksResponse`
  - Updated all endpoint return types for proper OpenAPI generation

### Test Helpers (UPDATED ✅)
- `fastapi_app/tests/helpers/test-auth.js` - Enhanced with:
  - Optional `baseUrl` parameter for all functions
  - `createTestSession()` helper function

**Total New Code**: ~1380 lines (routers + tests + models)

## Testing Status

### Startup Issues Fixed (2025-10-11)

- ✅ **Fixed**: Import error for `get_locked_file_ids` in files_locks.py
  - Added `get_locked_file_ids()` function to fastapi_app/lib/locking.py
  - Function returns list of file IDs (abbreviated hashes) for locked files by session
  - Updated files_locks router to use new function with abbreviator
- ✅ **Fixed**: Smart startup script created at bin/start-dev-fastapi
  - Detects if server already running
  - Reports auto-reload capability
  - Provides helpful restart instructions
- ✅ Updated package.json dev:fastapi command to use smart startup script

### Manual Testing

- ✅ **TESTED**: Start FastAPI server - Server starts successfully, all databases initialized
- ✅ **TESTED**: Health endpoint (`/health`) - Returns `{"status":"ok"}`
- ✅ **TESTED**: File list endpoint (`/api/files/list`) - Returns properly structured document groups with abbreviated hashes
- ✅ **TESTED**: File upload endpoint (`/api/files/upload`) - Properly requires session authentication
- ✅ **TESTED**: File serve endpoint (`/api/files/{file_id}`) - Successfully serves files by abbreviated hash
- ⏸️ Pending: Test delete endpoint with session
- ⏸️ Pending: Test move endpoint with session
- ⏸️ Pending: Test lock acquisition/release with session
- ⏸️ Pending: Test heartbeat with session

### Integration Tests (2025-01-11 Update)

- ✅ **CREATED**: `files_delete.test.js` - Comprehensive delete endpoint tests
- ✅ **CREATED**: `files_move.test.js` - File move/collection management tests
- ✅ **CREATED**: `files_locks.test.js` - Full lock lifecycle tests (acquire/release/check/list)
- ✅ **CREATED**: `files_heartbeat.test.js` - Lock refresh/heartbeat tests
- ⚠️ **BLOCKED**: Tests require proper test user setup (see below)
- ⏸️ Pending: Verify functional equivalence with Flask after user setup

## How to Test Phase 4B (Completed Endpoints)

### 1. Start FastAPI Server

```bash
# Terminal 1: Start server
npm run dev:fastapi

# Or directly with Python
python -m uvicorn run_fastapi:app --reload --port 8000
```

### 2. Test with curl

```bash
# Delete files (requires session)
curl -X POST http://localhost:8000/api/files/delete \
  -H "x-session-id: YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '["abc12", "def34"]'

# Move files
curl -X POST http://localhost:8000/api/files/move \
  -H "x-session-id: YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "pdf_path": "abc12",
    "xml_path": "def34",
    "destination_collection": "new_collection"
  }'

# Get all locks
curl http://localhost:8000/api/files/locks \
  -H "x-session-id: YOUR_SESSION_ID"

# Acquire lock
curl -X POST http://localhost:8000/api/files/acquire_lock \
  -H "x-session-id: YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"file_id": "abc12"}'

# Release lock
curl -X POST http://localhost:8000/api/files/release_lock \
  -H "x-session-id: YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"file_id": "abc12"}'

# Heartbeat
curl -X POST http://localhost:8000/api/files/heartbeat \
  -H "x-session-id: YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"file_path": "abc12"}'
```

### 3. Run Integration Tests (when created)

```bash
# Terminal 1: Start server
npm run dev:fastapi

# Terminal 2: Run tests
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_delete.test.js
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_move.test.js
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_locks.test.js
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_heartbeat.test.js
```

## Known Issues / TODOs

### Critical - User Authentication Setup Required ⚠️

**Issue**: Integration tests are failing due to missing test user configuration.

**Current State**:
- Only `admin` user works (password: "admin")
- `annotator` user exists but has incorrect password hash in `db/users.json`
- Tests currently use `annotator` user which cannot authenticate

**Solution Options**:

1. **Quick Fix** - Use admin for tests:
   - Update all test files to use `login('admin', 'admin', BASE_URL)`
   - This works immediately but tests run with admin privileges

2. **Proper Fix** - Create test users:
   ```bash
   # Add to db/users.json with proper password hashes
   {
     "username": "testannotator",
     "fullname": "Test Annotator",
     "roles": ["user", "annotator"],
     "passwd_hash": "38778e10be714f5d0b30c9c1598bc60bf54371e26198eb4d890010dc4e194abe"  # "annotatorpass"
   }
   ```

3. **Best Fix** - User management CLI:
   - Create `bin/add_user.py` script
   - Properly hash passwords and add to database
   - Include in migration tools

**Next Session Action**: Either use quick fix to unblock tests, or implement proper user management.

### Next Steps for New Session

**Priority 1: Unblock Integration Tests** (30 minutes)
1. Fix user authentication:
   - Option A: Quick fix - change tests to use `admin` user
   - Option B: Add test user to `db/users.json` manually
   - Option C: Create user management script
2. Run all integration tests:
   ```bash
   E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_*.test.js
   ```
3. Fix any failing tests

**Priority 2: Add Response Model Validation** (15 minutes)
1. Verify OpenAPI docs include all response models:
   - Visit http://localhost:8000/docs
   - Check each Phase 4B endpoint has proper response schema
2. Test client generation with proper types

**Priority 3: Implement File Save API** (2-3 hours)
1. Study Flask save logic in `server/api/files/save.py` (~400 lines)
2. Break down into helper functions:
   - Determine save strategy (new/update/version/gold/promote)
   - Extract metadata from TEI
   - Handle version numbering
   - Handle gold standard promotion
3. Implement with full error handling
4. Create comprehensive tests

**Priority 4: Phase 4B Completion Verification** (30 minutes)
1. Manual testing of all endpoints
2. Compare responses with Flask equivalents
3. Document any differences
4. Update completion status

## Architecture Summary

### Request Flows

**Delete**:
```
Client → POST /api/files/delete (abbreviated hashes)
→ Resolve hashes to full hashes
→ Check permissions for each file
→ Soft delete (deleted=1, sync_status='pending_delete')
→ Return {"result": "ok"}
```

**Move**:
```
Client → POST /api/files/move (pdf_path, xml_path, destination)
→ Resolve pdf_path to full hash
→ Look up PDF file in database
→ Check write permissions
→ Add destination to doc_collections array
→ Update sync_status='modified'
→ Return abbreviated hashes
```

**Locks**:
```
Client → POST /api/files/acquire_lock (file_id)
→ Resolve file_id to full hash
→ Check edit permissions
→ Call acquire_lock(full_hash, session_id)
→ Return "OK" or 423 error
```

**Heartbeat**:
```
Client → POST /api/files/heartbeat (file_path)
→ Resolve file_path to full hash
→ Call acquire_lock (handles refresh for same session)
→ Return {"status": "lock_refreshed"}
```

## Success Criteria

Phase 4B (partial) is complete when:

- ✅ Delete API implemented with Pydantic models
- ✅ Move API implemented with Pydantic models
- ✅ Locks API endpoints implemented with Pydantic models
- ✅ Heartbeat API implemented with Pydantic models
- ✅ All routers registered in main.py
- ✅ Integration tests created (4 test files, ~920 lines)
- ⚠️ Integration tests ready but blocked on user setup
- ⏸️ Save API implemented (deferred)
- ⏸️ Integration tests passing (needs user fix)
- ⏸️ Functional equivalence with Flask verified (except save)

## Session Summary (2025-01-11)

### Accomplishments ✅

1. **Added Pydantic Response Models**:
   - All Phase 4B endpoints now have proper response models
   - OpenAPI documentation will be complete
   - Type-safe client generation enabled

2. **Created Comprehensive Integration Tests**:
   - 4 test files covering all Phase 4B endpoints
   - ~920 lines of test code
   - Based on existing Flask E2E tests
   - Ready to run once user authentication is fixed

3. **Enhanced Test Infrastructure**:
   - Updated test helpers to support flexible BASE_URL
   - Added `createTestSession()` helper
   - Tests can run against any FastAPI instance

4. **Verified Flask API Compatibility**:
   - Studied all Flask endpoint implementations
   - Ensured FastAPI endpoints match request/response structure
   - Documented key differences (soft delete, no cache_status, etc.)

### Blocking Issues ⚠️

**User Authentication**: Tests cannot run because test users don't exist or have wrong passwords in `db/users.json`. Must be fixed before tests can run.

### What's Next

See "Next Steps for New Session" section above for detailed action items.

## Comparison with Flask

| Feature | Flask | FastAPI (Phase 4B) |
|---------|-------|-------------------|
| **Delete** | Hard delete + .deleted marker | Soft delete (deleted=1) |
| **Move** | Physical file move | Update doc_collections array |
| **Locks** | Path-based | Hash-based (abbreviated) |
| **Heartbeat** | Returns cache_status | No cache (database current) |
| **Save** | Complex logic | Not yet implemented |

## Conclusion

Phase 4B has successfully implemented 4 out of 5 core file operation endpoints with comprehensive testing infrastructure. All endpoints have proper Pydantic models and integration tests ready to run.

**Current State (2025-01-11)**:
- ✅ All simple CRUD operations (delete, move)
- ✅ All lock management operations
- ✅ Heartbeat for lock refresh
- ✅ Pydantic response models for all endpoints
- ✅ Comprehensive integration tests created
- ⚠️ Tests blocked on user authentication setup
- ⏸️ Complex save logic deferred

**Immediate Next Action**:
1. Fix user authentication (30 min quick fix: use admin, or add test user)
2. Run integration tests and verify they pass
3. Then implement save API with full testing

**Files to Review in Next Session**:
- `fastapi_app/tests/backend/files_*.test.js` - All test files
- `db/users.json` - User authentication database
- `server/api/files/save.py` - Flask save logic to port

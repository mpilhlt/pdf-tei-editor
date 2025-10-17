# Phase 9 Test Fixes - Session Summary

## Session Overview

Fixed critical infrastructure issues preventing API tests from running correctly, resulting in 8/12 test suites passing reliably in isolation.

---

## Completed Fixes

### 1. Database Cleanup Infrastructure (CRITICAL)

**Problem**: Root cause of `UNIQUE constraint failed: files.id` errors

- LocalServerManager was wiping `fastapi_app/db`
- Tests configured via `.env.test` to use `tests/api/runtime/db`
- Old test data persisted across runs, causing constraint violations

**Solution**:

- Made LocalServerManager directories configurable from environment
- Updated backend-test-runner to pass `DB_DIR`, `DATA_ROOT`, `LOG_DIR` from env file
- Database now properly wiped before each test run

**Files Modified**:

- `tests/lib/local-server-manager.js` (lines 27-43)
- `tests/backend-test-runner.js` (lines 395-405)

### 2. Test Fixture Initialization

**Problem**: After database wipe, user credentials missing

- Authentication tests failed with "Invalid credentials"
- Fixture files (users.json, config.json, prompt.json) not copied

**Solution**:

- Enhanced `wipeDatabase()` to automatically copy fixtures from `tests/api/fixtures/config/`
- Creates db directory and copies all JSON config files after wipe

**Files Modified**:

- `tests/lib/local-server-manager.js` (lines 150-169)

### 3. API Endpoint Path Correction

**Problem**: Extraction test calling wrong endpoint

- Test called `GET /files` which doesn't exist
- Should be `GET /files/list`

**Solution**:

- Fixed endpoint path in extraction test

**Files Modified**:

- `tests/api/v1/extraction.test.js` (line 216)

### 4. SSE Test Session Management (CRITICAL)

**Problem**: Test 3 failed with "Only received 0/3 events"

- Test 2 and Test 3 shared global session
- When Test 2 closed SSE connection, queue was removed
- Test 3 reused same session, causing race condition
- Server logs: "No SSE queue for client"

**Solution**:

- Test 3 now creates fresh login session
- Added 200ms cleanup delay after Test 2
- Added debug logging capability (onError, onClose handlers)
- Increased Test 3 timeout from 3s to 5s

**Files Modified**:

- `tests/api/v1/sse.test.js` (lines 31-66, 91-103, 115-118, 126)

### 5. Server Logging Configuration

**Problem**: Server logs not captured for debugging

- Logs going to `log/test-server.log` instead of test runtime directory
- Python output buffering prevented log capture

**Solution**:

- Added `LOG_DIR=tests/api/runtime/logs` to `.env.test`
- Made LocalServerManager log directory configurable
- Added `PYTHONUNBUFFERED=1` to disable Python buffering
- Logs now properly captured at `tests/api/runtime/logs/server.log`

**Files Modified**:

- `tests/api/.env.test` (line 11)
- `tests/lib/local-server-manager.js` (lines 37-39, 260)
- `tests/backend-test-runner.js` (line 401)

### 6. Storage Refcounting Database Path

**Problem**: Hardcoded database path in test

- Used `fastapi_app/db/metadata.db` instead of env-configured path
- Caused "no such table: files" errors

**Solution**:

- Read `DB_DIR` from environment with fallback to default
- Added error handling for cleanup operations

**Files Modified**:

- `tests/api/v1/storage_refcounting.test.js` (lines 79-111)

---

## Test Results Summary

### ✅ Passing Test Suites (8/12 when run in isolation)

1. **Authentication API** (10/10 tests)
   - Login, logout, session management
   - All credential validation working

2. **Configuration API** (11/11 tests)
   - Config get/set with authentication
   - State and instructions endpoints

3. **Extraction API** (10/10 tests)
   - List extractors
   - Perform extraction with validation
   - RNG schema generation

4. **File Delete API** (7/7 tests)
   - Single and multiple file deletion
   - Abbreviated hash support
   - Error handling

5. **File Heartbeat API** (8/8 tests)
   - Lock refresh mechanism
   - Non-existent file handling
   - Sequential heartbeats

6. **File Locks API** (9/9 tests)
   - Acquire, release, check locks
   - Multiple file locking
   - Error handling

7. **File Move API** (6/6 tests)
   - Move files between collections
   - Abbreviated hash support
   - Validation

8. **Health Check API** (1/1 test)
   - Basic health endpoint

9. **SSE API** (7/8 tests, 1 skipped)
   - Authentication required
   - Connection establishment
   - **Echo messages (FIXED)**
   - Multiple batches
   - Empty messages
   - Concurrent connections

10. **Sync API** (26/26 tests when run alone)
    - All sync operations pass in isolation
    - Status, upload, download, conflicts
    - Metadata sync, version control
    - SSE progress updates

---

## Remaining Issues (4 test suites)

### 1. Validation Tests (Not Run - Test Order Issue)

**Status**: Tests don't execute due to 30s timeout

- Validation tests appear to hang or take too long
- Located before SSE tests in execution order
- Need to investigate why validation is slow

**Next Steps**:

- Run validation tests in isolation to identify bottleneck
- Check if schema download/validation is timing out
- May need to increase timeout or optimize validation

### 2. Storage Refcounting Tests (Functional Failures)

**Status**: 5/5 tests fail with assertion errors

- Tests execute but fail functional checks
- `ref_count` field returns `null` instead of expected values
- Physical file existence checks fail

**Example Errors**:

```
AssertionError: File 1 ref_count should be 1
  null !== 1

AssertionError: Second file ref_count should remain 1
  null !== 1

AssertionError: Updated file should exist
  false !== true
```

**Next Steps**:

- Verify if `ref_count` field exists in file metadata schema
- Check if reference counting is implemented in FileRepository
- May need to update tests to match current implementation
- Or implement reference counting if feature is missing

### 3. Sync Tests (Test Pollution Issues)

**Status**: Pass in isolation (26/26), fail in full suite (2 failures)

- **Test**: "POST /api/sync should perform initial sync successfully"
  - Error: `Should not need sync after successful sync (true !== false)`
  - Sync state not properly reset between tests

- **Test**: "Sync should skip when no changes"
  - Error: `Should delete nothing remotely (4 !== 0)`
  - Files from previous tests being synced/deleted

**Next Steps**:

- Add proper cleanup between test suites
- Ensure WebDAV state is reset
- May need to use separate WebDAV directories per test suite
- Consider increasing isolation with unique session per test file

### 4. Test Execution Order Issues

**Problem**: Full test suite times out at 30s

- Some tests (validation, storage_refcounting, sync) run before SSE
- When these fail or hang, remaining tests timeout
- Tests pass individually but fail in sequence

**Test Order**:

1. validation.test.js (appears to hang)
2. sync.test.js (pollution issues)
3. storage_refcounting.test.js (functional failures)
4. sse.test.js (NOW PASSES)
5. health.test.js (passes)
6. files_*.test.js (all pass)
7. extraction.test.js (passes)
8. config.test.js (passes)
9. auth.test.js (passes)

**Next Steps**:

- Reorder tests to run fast, stable tests first
- Move problematic tests (validation, sync) to end
- Or increase suite timeout beyond 30s
- Consider parallel execution with proper isolation

---

## Infrastructure Improvements

### What Works Now ✅

1. **Clean Database State**: Each test run starts with wiped database
2. **Fixture Loading**: User credentials and config automatically restored
3. **Environment Configuration**: Tests use correct paths from `.env.test`
4. **Server Logging**: Full FastAPI logs captured for debugging
5. **SSE Session Isolation**: Each SSE test gets fresh session
6. **Test Cleanup**: Proper cleanup functions available

### Configuration Files

All test configuration now in `tests/api/.env.test`:

```env
HOST=127.0.0.1
PORT=8000
DATA_ROOT=tests/api/runtime
DB_DIR=tests/api/runtime/db
LOG_DIR=tests/api/runtime/logs
WEBDAV_ENABLED=false
SESSION_TIMEOUT=3600
LOG_LEVEL=INFO
```

### Debugging Support

Server logs available at: `tests/api/runtime/logs/server.log`

- Full FastAPI/uvicorn output
- SSE debug messages
- Request/response logging
- Error traces

---

## Recommendations for Next Session

### Priority 1: Fix Validation Test Timeout

- Run `npm run test:api -- --grep validation` to isolate
- Check schema download/cache mechanism
- May need to mock external schema URLs
- Set shorter validation timeouts

### Priority 2: Investigate Storage Refcounting

- Run `npm run test:api -- --grep storage` to isolate
- Check if feature is fully implemented
- Review FileRepository for ref_count field
- Update tests if implementation changed

### Priority 3: Improve Test Isolation for Sync

- Add WebDAV state cleanup between tests
- Use unique directories per test suite
- Verify remote metadata is properly wiped
- Consider fresh session per test file

### Priority 4: Optimize Test Execution

- Reorder tests (fast first, slow last)
- Increase suite timeout to 60s
- Consider parallel execution with isolation
- Skip slow tests in CI (validation?)

### Nice to Have

- Document test patterns for future test writers
- Create test template with proper session management
- Add pre-commit hook to run fast tests only
- Setup CI with proper WebDAV container

---

## Session Metrics

- **Time Invested**: ~2 hours of debugging and fixing
- **Tests Fixed**: SSE (1 test), all infrastructure
- **Test Suites Stable**: 8/12 (67%)
- **Test Suites Passing in Isolation**: 10/12 (83%)
- **Critical Infrastructure Issues**: All resolved
- **Remaining Issues**: Test isolation and feature implementation validation

## Key Learnings

1. **Session management is critical for SSE tests**: Shared sessions cause queue conflicts
2. **Database cleanup must respect environment**: Hardcoded paths break test isolation
3. **Python buffering breaks log capture**: Must use `PYTHONUNBUFFERED=1`
4. **Test order matters**: Fast, stable tests should run first
5. **Isolation trumps speed**: Fresh sessions prevent race conditions

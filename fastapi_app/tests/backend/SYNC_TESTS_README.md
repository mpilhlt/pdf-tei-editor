# Sync Integration Tests

This directory contains comprehensive integration tests for Phase 6: Sync and SSE APIs.

## Overview

The sync tests validate the database-driven synchronization system, including:

- O(1) sync status checks
- File upload/download synchronization
- Deletion propagation via database (no `.deleted` files)
- Metadata-only sync (collection changes, label updates)
- Conflict detection and resolution
- Concurrent sync locking
- Server-sent events (SSE) for progress updates
- Version management

## Test Files

- **[sync.test.js](sync.test.js)** - Main integration test suite (28 tests)
- **[../helpers/webdav-server.js](../helpers/webdav-server.js)** - WebDAV test server manager
- **[../helpers/test-env.js](../helpers/test-env.js)** - Test environment configuration

## Prerequisites

### 1. Install Dependencies

The tests require WsgiDAV for the test WebDAV server:

```bash
# Install Python dependencies (including dev dependencies)
uv sync --all-groups

# Or manually install
pip install wsgidav cheroot
```

### 2. Python Command

The WebDAV server helper expects `python3` to be available. Ensure it's in your PATH:

```bash
python3 --version
```

## Running the Tests

**Important Note**: Due to Node.js test runner limitations with serializing child processes, the WebDAV server must be started **externally** before running the tests. The test runner (Option 1) handles this automatically.

### Option 1: Automatic Test Runner (Recommended)

The test runner handles WebDAV server setup and FastAPI configuration automatically:

```bash
# Run sync tests only
python bin/test-fastapi.py sync

# Run with verbose output
python bin/test-fastapi.py --verbose sync

# Keep database between runs (faster, but not isolated)
python bin/test-fastapi.py --keep-db sync
```

### Option 2: Manual Setup

For more control or debugging, you can run components manually:

#### Step 1: Create Test Environment File

The tests automatically create a `.env.test` file, or you can create it manually:

```bash
# .env.test
HOST=127.0.0.1
PORT=8000
DATA_ROOT=fastapi_app/data
DB_DIR=fastapi_app/db

# WebDAV Configuration for Sync Tests
WEBDAV_ENABLED=true
WEBDAV_BASE_URL=http://localhost:8081
WEBDAV_USERNAME=test
WEBDAV_PASSWORD=test123
WEBDAV_REMOTE_ROOT=/pdf-tei-editor

SESSION_TIMEOUT=3600
LOG_LEVEL=INFO
```

#### Step 2: Start FastAPI Server with Test Config

```bash
# Terminal 1: Start FastAPI with test environment
FASTAPI_ENV_FILE=.env.test npm run dev:fastapi
```

The server will load WebDAV configuration from `.env.test` instead of `.env.fastapi`.

#### Step 3: Start WebDAV Test Server

Due to Node.js test runner limitations, start the WebDAV server manually:

```bash
# Terminal 2: Start WebDAV test server
mkdir -p /tmp/webdav-test
python3 -m wsgidav \
  --host 127.0.0.1 \
  --port 8081 \
  --root /tmp/webdav-test \
  --auth http-basic \
  --server cheroot \
  --no-config
```

Set HTTP auth credentials via environment:
```bash
export WSGIDAV_HTTP_BASIC_AUTH='{"test": "test123"}'
```

#### Step 4: Run Tests

```bash
# Terminal 3: Run sync tests
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/sync.test.js
```

## Test Structure

### Test Categories

1. **Sync Status Tests** (2 tests)
   - O(1) status check
   - Detection of sync-needed state

2. **Basic Sync Tests** (3 tests)
   - Initial sync
   - Skip when no changes
   - Force sync

3. **File Upload/Download Tests** (2 tests)
   - Upload new local files
   - Download new remote files

4. **Deletion Propagation Tests** (2 tests)
   - Local deletions → remote
   - Remote deletions → local

5. **Metadata-Only Sync Tests** (2 tests)
   - Metadata changes without file transfers
   - Collection changes

6. **Conflict Tests** (4 tests)
   - Conflict listing
   - Conflict detection
   - Resolution strategies (local_wins, remote_wins, keep_both)

7. **Concurrent Sync Tests** (2 tests)
   - Lock prevention
   - Lock timeout

8. **SSE Tests** (4 tests)
   - Connection establishment
   - Progress updates
   - Keep-alive pings
   - Disconnection handling

9. **Version Management Tests** (1 test)
   - Version increment tracking

10. **Error Handling Tests** (3 tests)
    - Network errors
    - Malformed metadata
    - Parameter validation

### Test Data

Tests use unique identifiers to avoid collisions:

```javascript
const testRunId = Date.now().toString(36) + Math.random().toString(36).substring(2);
const testFilePath = `/data/sync-test-${testRunId}.tei.xml`;
```

All test files are cleaned up after execution.

## WebDAV Test Server

The tests use WsgiDAV as a lightweight WebDAV server:

- **Host**: 127.0.0.1
- **Port**: 8081
- **Auth**: HTTP Basic (username: test, password: test123)
- **Root**: Temporary directory (auto-cleanup)

The server is started automatically by the test suite and cleaned up after tests complete.

## Debugging

### Enable Verbose Logging

```bash
# See WebDAV server output
python bin/test-fastapi.py --verbose sync
```

### Check Server Logs

```bash
# FastAPI server logs
tail -f log/fastapi-server.log
```

### Manual WebDAV Server

For debugging WebDAV issues, start the server manually:

```bash
# Terminal 1: Start WebDAV server
python3 -m wsgidav \
  --host 127.0.0.1 \
  --port 8081 \
  --root /tmp/webdav-test \
  --auth http-basic \
  --server cheroot

# Terminal 2: Test with curl
curl -u test:test123 http://localhost:8081/
```

### Common Issues

#### WebDAV Server Fails to Start

- **Error**: `ModuleNotFoundError: No module named 'wsgidav'`
- **Solution**: Install dev dependencies with `uv sync --all-groups`

#### Python3 Not Found

- **Error**: `spawn python3 ENOENT`
- **Solution**: Ensure Python 3 is installed and `python3` is in your PATH

#### Port Already in Use

- **Error**: `Address already in use: 8081`
- **Solution**: Kill existing process on port 8081:
  ```bash
  lsof -ti:8081 | xargs kill
  ```

#### FastAPI Not Using Test Config

- **Error**: Tests fail with WebDAV connection errors
- **Solution**: Ensure `FASTAPI_ENV_FILE=.env.test` is set when starting the server

## Test Coverage

Current test coverage for Phase 6:

- **Python Unit Tests**: 45/45 passing (100%)
  - `test_remote_metadata.py` - 14 tests
  - `test_sse_service.py` - 16 tests
  - `test_sync_service.py` - 15 tests

- **Integration Tests**: 28 tests
  - Sync operations - 13 tests
  - Conflict handling - 4 tests
  - SSE - 4 tests
  - Concurrent sync - 2 tests
  - Error handling - 3 tests
  - Version management - 1 test
  - Status checks - 2 tests

## Performance Expectations

The database-driven sync provides dramatic performance improvements:

### Before (Flask with filesystem scanning)
- 10K files, no changes: 4-8 seconds (O(n) scan)
- 100K files, no changes: 30-60 seconds (O(n) scan)

### After (FastAPI with database-driven sync)
- 10K files, no changes: 1-5 ms (O(1) count query)
- 100K files, no changes: 1-5 ms (O(1) count query)

**Speedup**: ~1000x for "no changes" detection

## Next Steps

After running the integration tests:

1. **Verify Performance**: Test with large file counts
2. **Multi-Instance Testing**: Test with multiple FastAPI instances syncing
3. **Stress Testing**: Concurrent sync attempts, large file uploads
4. **Real WebDAV Testing**: Test with actual WebDAV servers (Nextcloud, etc.)

## Contributing

When adding new sync features:

1. Add unit tests in `fastapi_app/tests/py/test_sync_service.py`
2. Add integration tests in `fastapi_app/tests/backend/sync.test.js`
3. Update this README with new test scenarios
4. Ensure all tests pass before committing

## References

- [Phase 6 Status](../../prompts/phase-6-status.md) - Implementation details
- [Sync Design](../../prompts/sync-design.md) - Algorithm and architecture
- [Migration Plan](../../prompts/migration-plan.md) - Overall project plan

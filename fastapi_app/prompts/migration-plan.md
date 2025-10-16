# FastAPI Migration Plan

## Overview

This directory contains the complete plan for migrating from Flask to FastAPI.

**Current State**: Flask-based backend in `server/` with JSON-cached file metadata
**Target State**: FastAPI backend in `fastapi_app/` with SQLite-backed file metadata
**Approach**: Clean slate implementation with isolated development and comprehensive testing
**Previous Work**: Early FastAPI implementation archived in `old-fastapi/` for reference

**Note**: The directory is named `fastapi_app` (not `fastapi`) to avoid Python import conflicts with the FastAPI library. The `run_fastapi.py` wrapper module is used to launch the application.

## Goals

1. **API Equivalence**: 1:1 functional parity with Flask API
2. **Type Safety**: Pydantic models for automatic validation
3. **OpenAPI Specification**: Auto-generated spec for client generation
4. **Modern Architecture**: Framework-agnostic core library with dependency injection
5. **Performance**: SQLite with hash-sharded file storage

## Key Design Decisions

### API Versioning

- **All API endpoints use `/api/v1/` prefix** for versioned access
- **No backward-compatible unversioned routes**: The frontend uses a client shim ([app/src/plugins/client.js](../../app/src/plugins/client.js)) that wraps all server interactions, making Flask-compatible unversioned routes unnecessary
- OpenAPI schema generation targets only `/api/v1/*` endpoints
- This simplifies the codebase and allows for future API version changes without cluttering the schema

### Document-Centric Schema

- `doc_id` (DOI, custom ID, etc.) is the primary organizing principle
- One document → multiple files (PDF + TEI versions + gold standard)
- Metadata inheritance: document metadata stored only with PDF files
- Multi-collection support: documents can belong to multiple collections

### File Type & Extensions

- `file_type` determines extension automatically:
  - `'pdf'` → `.pdf`
  - `'tei'` → `.tei.xml`
  - `'rng'` → `.rng`

### Hash-Sharded Storage

- Git-style sharding: `{hash[:2]}/{hash}{extension}`
- Example: `ab/abcdef123....tei.xml`
- Scales to millions of files without filesystem slowdowns

### Metadata Organization

**PDF files** (document metadata):

- `doc_collections`: JSON array `["corpus1", "corpus2"]` (multi-collection!)
- `doc_metadata`: JSON object `{author, title, date, doi, ...}`

**TEI files** (file-specific):

- `label`: Optional custom label
- `variant`: Variant identifier (TEI only)
- `version`: Version number
- `is_gold_standard`: Boolean flag
- `file_metadata`: JSON for extraction info

See [schema-design.md](schema-design.md) for complete details.

## Migration Phases

### [Phase 0: Foundation and Infrastructure](phase-0-foundation.md)

- Project setup and clean slate
- Python dependencies
- Basic FastAPI application
- Logging infrastructure
- Testing infrastructure
- API versioning setup

**Status**: ✅ Complete
**Summary**: [phase-0-completion.md](phase-0-completion.md)
**Previous Implementation**: Archived in `old-fastapi/` directory

### [Phase 1: Core Library Migration](phase-1-core-library.md)

- Port utility libraries (XML, TEI, config)
- Authentication and session management
- Server utilities with dependency injection
- Framework-agnostic hashing utilities

**Status**: ✅ Complete
**Summary**: [phase-1-completion.md](phase-1-completion.md)

### [Phase 2: SQLite File Metadata System](phase-2-sqlite-metadata.md)

- Database schema implementation
- Database manager and transactions
- File repository with document-centric queries
- Hash-based file storage
- Integration testing

**Status**: ✅ Complete
**Summary**: [phase-2-completion.md](phase-2-completion.md)

### [Phase 3: Authentication and Configuration APIs](phase-3-auth-config.md)

- Authentication API (login, logout, status)
- Configuration API (CRUD operations)
- OpenAPI client generation prototype
- Comprehensive E2E testing

**Status**: ✅ Complete
**Summary**: [phase-3-completion.md](phase-3-completion.md)

### [Phase 4: File Management APIs](phase-4-file-management.md)

- File listing with SQLite backend
- File upload with hash storage
- File serving and version management
- File operations (delete, move, copy, save)
- File locking endpoints (acquire, release, check, heartbeat)
- Hash abbreviation system for client communication
- Stable document IDs for persistent URLs

**Status**: ✅ Complete
**Summary**: [phase-4b-status.md](phase-4b-status.md)
**Details**:
- Phase 4A: Basic file operations (list, upload, serve)
- Phase 4B: Advanced operations (delete, move, copy, save, locks, heartbeat)
- 6 core endpoints implemented with 19/19 tests passing
- Reference counting system for automatic cleanup
- Multi-collection support for documents
- Stable nanoid-based IDs for permanent URLs

### [Phase 5: Validation and Extraction APIs](phase-5-completion.md)

- XML/TEI validation endpoints (XSD and RelaxNG)
- CodeMirror autocomplete generation from schemas
- Metadata extraction system (PDF and XML-based)
- Extractor discovery and management
- Framework-agnostic libraries with dependency injection
- Storage reference counting tests and bug fixes

**Status**: ✅ Complete
**Summary**: [phase-5-completion.md](phase-5-completion.md)
**Details**:
- 2 validation endpoints with 8/8 tests passing
- 2 extraction endpoints with 9/10 tests passing (90%)
- Storage reference counting with 5/5 tests passing (100%)
- Framework-agnostic schema validation with timeout protection
- Integrated with Phase 4 file storage and metadata system
- Fixed reference counting cleanup bug in file deletion
- Overall: 77/78 tests passing (99%)

### [Phase 6: Sync and SSE APIs](phase-6-completion.md)

- Database-driven document synchronization with two-tier architecture (local + remote metadata.db)
- O(1) change detection using SQLite (1000x faster than filesystem scan)
- Server-sent events for real-time progress updates
- Database-driven deletion (no `.deleted` marker files)
- Metadata-only sync for collection changes
- WebDAV lock management and conflict resolution

**Status**: ✅ Complete
**Summary**: [phase-6-completion.md](phase-6-completion.md)
**Details**:
- 4 sync endpoints + 1 SSE endpoint + 1 SSE test endpoint implemented
- RemoteMetadataManager, SSEService, SyncService implemented
- FileRepository extended with sync methods
- Configuration and dependency injection complete
- Python unit tests: 45/45 passing (100%)
- Integration tests: 33/33 passing (100%)
  - Sync tests: 26/26 passing
  - SSE tests: 7/7 passing (1 skipped)
- WsgiDAV-based test infrastructure with automatic setup/teardown
- Session-based SSE queues (matches Flask implementation)
- Total: ~1,635 lines of production + test code

### [Phase 7: Client Generation and Frontend Integration](phase-7-client-integration.md)

- Complete OpenAPI client generation (31 methods, 28 types)
- Build system integration (prebuild, check scripts, pre-commit hook)
- Frontend migration to generated client (27 methods migrated)
- Enhanced generator with upload/SSE exclusion and query parameter support
- API client usage documentation

**Status**: ✅ Complete
**Summary**: [phase-7-completion.md](phase-7-completion.md)
**Details**:
- 31 generated methods with full JSDoc type annotations
- 27 frontend methods migrated to use generated client
- 1 upload method kept with manual FormData handling
- 5 endpoints appropriately excluded (3 uploads + 2 SSE)
- Automated client regeneration (prebuild hook, pre-commit check)
- ~5 second generation time
- Total: ~1,100 lines added (client 888 + docs 200 + scripts 100)

### Phase 8: Testing and Validation

- Full E2E test suite
- Performance testing
- Migration script testing

**Status**: ⬜ Not started

### Phase 9: Deployment and Switchover

- Docker configuration
- Production deployment
- Flask decommissioning

**Status**: ⬜ Not started

### Phase 10: Documentation and Cleanup

- API documentation
- Development guides
- Migration cleanup

**Status**: ⬜ Not started

## Development Workflow

### Running the Dev Server

```bash
npm run dev:fastapi
# Server available at http://localhost:8000
# API docs at http://localhost:8000/docs
```

**Troubleshooting**: If server fails to start, check `log/fastapi-server.log` for detailed error messages. Common issues:
- Database schema errors: Remove `fastapi_app/db/` directory and restart to recreate with current schema
- Port conflicts: Ensure port 8000 is available
- Missing dependencies: Run `uv sync` to install dependencies

### Running Tests

**✨ Recommended: Use the robust test runner script** (handles server lifecycle automatically, works on all platforms):

```bash
# Run all integration tests with clean database
python bin/test-fastapi.py

# Run specific test files
python bin/test-fastapi.py validation extraction

# Keep database between runs (faster, but not isolated)
python bin/test-fastapi.py --keep-db files_save

# Debug mode: keep server running after tests for manual testing
python bin/test-fastapi.py --no-cleanup validation

# Show server output during tests
python bin/test-fastapi.py --verbose

# See all options
python bin/test-fastapi.py --help
```

You can also use the shortcut `npm run test:fastapi:e2e`

**What the test script does:**
1. ✅ Kills any running FastAPI servers (cross-platform)
2. ✅ Wipes `fastapi_app/db/*` directory for clean slate (all databases)
3. ✅ Starts FastAPI server and waits for successful startup
4. ✅ Verifies startup by checking logs for errors and testing `/health` endpoint
5. ✅ Runs specified integration tests with `E2E_BASE_URL` set
6. ✅ Stops server (unless `--no-cleanup`)
7. ✅ Shows test results and log file path: `log/fastapi-server.log`

**Works on Windows, macOS, and Linux!**

---

**Manual testing** (for interactive development):

```bash
# Terminal 1: Start server
npm run dev:fastapi

# Terminal 2: Run specific tests
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/validation.test.js

# Or run all tests
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/*.test.js

# -- kill the server

```

**Python unit tests**:

```bash
npm run test:fastapi:py
```

### Migration Pattern for Each Endpoint

1. Read Flask implementation
2. Port lib dependencies with dependency injection
3. Define Pydantic models
4. Implement FastAPI router
5. Write comprehensive E2E tests
6. **Run and validate tests pass**
7. Regenerate API client
8. Document changes


## Test-Driven Development

### Backend E2E Tests for FastAPI Migration

During the Flask-to-FastAPI migration, backend E2E tests are used to verify the FastAPI implementation against the same test suite used for Flask, ensuring functional equivalence without requiring containerized testing during development.

#### Test Organization

- **Existing Flask backend tests**: `tests/e2e/backend/*.test.js` - Can be reused for FastAPI testing
- **FastAPI-specific backend tests**: `fastapi_app/tests/backend/*.test.js` - Tests specific to FastAPI implementation
- **Python unit tests**: `fastapi_app/tests/py/*.py` - Unit tests for FastAPI components


#### Reusing Existing Flask Backend Tests

The existing Flask backend tests in `tests/e2e/backend/` can be reused to test FastAPI by ensuring fixtures match:

```bash
# Terminal 1: Start FastAPI server with appropriate fixtures
# Ensure db/ or config/ directories are configured with same test data as Flask tests expect
npm run dev:fastapi

# Terminal 2: Run existing Flask backend tests against FastAPI server
E2E_BASE_URL=http://localhost:8000 node --test tests/e2e/backend/*.test.js

# Run specific test file
E2E_BASE_URL=http://localhost:8000 node --test tests/e2e/backend/file-locks-api.test.js

# This verifies functional equivalence: same tests, same fixtures, same results

# -- kill the server
```

**Important**: When reusing Flask tests for FastAPI validation:
- Ensure test fixtures (data in `db/` or `config/`) match what Flask tests expect
- The FastAPI server must expose the same API endpoints with identical behavior
- Any test failures indicate API incompatibilities that need to be resolved

#### Running Python Unit Tests

Python unit tests for FastAPI components are located in `fastapi_app/tests/py/` and can be run without a server:

```bash
# Run all FastAPI Python unit tests
npm run test:fastapi:py

# Or using uv directly
uv run python -m unittest fastapi_app/tests/py/*.py

# Run specific test file
uv run python -m unittest fastapi_app/tests/py/test_auth.py

# Run specific test class
uv run python -m unittest fastapi_app/tests/py.test_auth.TestAuth

# Run with verbose output
uv run python -m unittest -v fastapi_app/tests/py/*.py
```

**Note**: Flask Python unit tests remain at `tests/py/` and use `npm run test:py`.

#### Example: Writing Backend Tests for FastAPI

Backend tests should work with the `E2E_BASE_URL` environment variable:

```javascript
/**
 * Health check endpoint test
 *
 * @testCovers fastapi/main.py
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

describe('Health Check', () => {
    test('should return ok status', async () => {
        const response = await fetch(`${BASE_URL}/health`);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.strictEqual(data.status, 'ok');
    });
});
```

This approach allows rapid iteration during FastAPI development without the overhead of container rebuilds.



## Critical Success Factors

✅ **Test-Driven**: Always run tests before marking complete.
✅ **Incremental**: One endpoint at a time, fully tested
✅ **Framework-Agnostic**: All `lib/` code injectable and testable
✅ **Database-First**: SQLite from start, no JSON caching
✅ **Client-Driven**: Regenerate client after each API change

## Reference Documentation

- [Schema Design](schema-design.md) - Complete database schema with examples
- [Development Workflow](development-workflow.md) - Commands and best practices
- [Testing Guide](../../prompts/testing-guide.md) - E2E testing patterns
- [Architecture Overview](../../prompts/architecture.md) - System architecture

## Progress Tracking

Track progress by updating phase status in this document:

- ⬜ Not started
- 🔄 In progress
- ✅ Complete
- ⚠️ Blocked

Last updated: 2025-10-16

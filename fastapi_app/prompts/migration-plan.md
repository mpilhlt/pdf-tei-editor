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

**Status**: ⬜ Not started

### [Phase 3: Authentication and Configuration APIs](phase-3-auth-config.md)

- Authentication API (login, logout, status)
- Configuration API (CRUD operations)
- OpenAPI client generation prototype
- Comprehensive E2E testing

**Status**: ✅ Complete
**Summary**: [phase-3-completion.md](phase-3-completion.md)

### Phase 4: File Management APIs

- File listing with SQLite backend
- File upload with hash storage
- File serving and version management
- File operations (delete, move)
- File locking endpoints

**Status**: ⬜ Not started

### Phase 5: Validation and Extraction APIs

- XML/TEI validation
- AI-based metadata extraction
- Extractor management

**Status**: ⬜ Not started

### Phase 6: Sync and SSE APIs

- Document synchronization
- Server-sent events for real-time updates

**Status**: ⬜ Not started

### Phase 7: Client Generation and Frontend Integration

- Complete OpenAPI client generation
- Build system integration
- Frontend migration to generated client

**Status**: ⬜ Not started

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

### Running Tests

```bash
# Terminal 1: Start server
npm run dev:fastapi

# Terminal 2: Run FastAPI backend tests
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/*.test.js

# Or run Python unit tests
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

#### Running Backend Tests Against Local FastAPI Server

FastAPI backend tests run against a locally running development server, avoiding Docker overhead during development:

```bash
# Terminal 1: Start FastAPI development server
npm run dev:fastapi

# Terminal 2: Run all FastAPI backend tests
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/*.test.js

# Run specific test file
E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/health.test.js

# Run with grep pattern to filter tests (Node.js 20.9.0+)
E2E_BASE_URL=http://localhost:8000 node --test --test-name-pattern="health" fastapi_app/tests/backend/*.test.js
```

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

Last updated: 2025-10-05

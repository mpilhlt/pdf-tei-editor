# Phase 9: Test Consolidation and API Equivalence Validation

## Status: ⬜ Not started

## Overview

Consolidate and reorganize all tests into a unified structure that validates API equivalence between Flask and FastAPI implementations. This phase also restructures application data organization and establishes clear separation between test fixtures, runtime data, and production data.

## Goals

1. **Unified Test Structure**: Clear organization by test type with proper unit/integration/e2e separation
2. **API Equivalence Validation**: Run identical API tests against both Flask and FastAPI
3. **Proper Data Organization**: Restructure application data under `data/` parent directory
4. **Test Fixtures Management**: Config presets for different test scenarios
5. **Runtime Isolation**: Test runtime data separate from fixtures and gitignored
6. **Cross-Backend Compatibility**: Verify FastAPI tests work against Flask and vice versa
7. **Containerized Testing**: Ensure all test types work in isolated containers

## Directory Structure Reorganization

### Application Data Structure (Production)

**Current**:
```
/
├── data/              # Mixed usage
├── db/                # Application database
├── config/            # Application config
└── fastapi_app/
    ├── data/          # FastAPI-specific (to be removed)
    ├── db/            # FastAPI-specific (to be removed)
    └── config/        # FastAPI-specific (to be removed)
```

**Target**:
```
/
└── data/              # Parent for all application data
    ├── db/            # Application database (users.json, collections.json, etc.)
    ├── files/         # Document files and metadata
    └── webdav-data/   # Legacy data (to be migrated/archived)
```

### Test Directory Structure

**Target**:
```
tests/
├── api/                              # Backend API integration tests
│   ├── v0/                          # Flask API tests (legacy)
│   │   ├── auth.test.js
│   │   ├── config.test.js
│   │   ├── files.test.js
│   │   └── ...
│   ├── v1/                          # FastAPI tests (current)
│   │   ├── auth.test.js
│   │   ├── config.test.js
│   │   ├── files.test.js
│   │   └── ...
│   ├── fixtures/                    # API test fixtures
│   │   ├── minimal/                 # Minimal test data
│   │   │   └── config/              # Config preset only
│   │   ├── standard/                # Standard test scenario
│   │   │   └── config/
│   │   └── complex/                 # Complex test scenario
│   │       └── config/
│   ├── runtime/                     # Runtime data (gitignored, ephemeral)
│   │   ├── db/                      # Generated during tests
│   │   ├── files/                   # Generated during tests
│   │   └── logs/                    # Server logs during tests
│   └── helpers/                     # API test utilities
│       ├── api-client.js
│       └── assertions.js
├── e2e/                             # Playwright browser tests
│   ├── frontend/                    # Frontend E2E tests
│   │   ├── editor.spec.js
│   │   └── ...
│   ├── fixtures/                    # E2E test fixtures
│   │   ├── minimal/
│   │   │   └── config/
│   │   ├── standard/
│   │   │   └── config/
│   │   └── complex/
│   │       └── config/
│   ├── helpers/                     # E2E test utilities
│   │   ├── page-objects.js
│   │   └── assertions.js
│   ├── runtime/                     # Runtime data (gitignored, ephemeral)
│   │   ├── db/                      # Generated during tests
│   │   ├── files/                   # Generated during tests
│   │   └── logs/                    # Server logs during tests
│   └── playwright.config.js
├── unit/                            # Unit tests
│   ├── js/                          # JavaScript unit tests
│   │   ├── modules/
│   │   │   └── *.test.js
│   │   ├── plugins/
│   │   │   └── *.test.js
│   │   └── helpers/
│   │       └── test-utils.js
│   ├── flask/                       # Flask unit tests (to be removed later)
│   │   ├── test_*.py
│   │   └── helpers/
│   └── fastapi/                     # FastAPI unit tests
│       ├── test_*.py
│       └── helpers/
└── lib/                             # Test infrastructure
    ├── server-manager.js
    ├── local-server-manager.js
    ├── container-server-manager.js
    ├── webdav-server-manager.js
    └── fixture-loader.js            # Fixture loading utilities
```

### Migration Mapping

**API Tests**:
- `tests/e2e/backend/*.test.js` → `tests/api/v0/` (Flask tests)
- `fastapi_app/tests/backend/*.test.js` → `tests/api/v1/` (FastAPI tests)

**E2E Tests**:
- `tests/e2e/frontend/*.spec.js` → `tests/e2e/frontend/` (no change)

**Unit Tests**:
- `tests/js/*.test.js` → `tests/unit/js/`
- `tests/py/*.py` → `tests/unit/flask/`
- `fastapi_app/tests/py/*.py` → `tests/unit/fastapi/`

**Application Data**:
- `db/` → `data/db/`
- `data/` → `data/files/`
- `config/` → `data/config/` (or stays at root - TBD)
- `fastapi_app/{data,db,config}/` → Remove after migration

**Test Fixtures**:
- Create `tests/api/fixtures/` with config presets
- Create `tests/e2e/fixtures/` with config presets
- Add `tests/e2e/runtime/` to `.gitignore`

## Phase 9 Implementation Steps

### Step 1: Application Data Reorganization

**Objective**: Restructure application data under unified `data/` directory and remove FastAPI-specific data directories.

**Tasks**:

1. **Create new data structure**:
   ```bash
   mkdir -p data/db data/files
   ```

2. **Move existing data**:
   ```bash
   # Move database files
   mv db/*.json data/db/

   # Move document files (if not already in data/)
   # Verify data/ structure matches target
   ```

3. **Update application configuration**:
   - Update Flask app to use `data/db/`, `data/files/`
   - Update FastAPI app to use `data/db/`, `data/files/`
   - Search for hardcoded paths: `db/`, references to `fastapi_app/data`, `fastapi_app/db`
   - Update environment variables and config files

4. **Remove FastAPI-specific data directories**:
   ```bash
   # After verifying apps work with new structure
   rm -rf fastapi_app/data fastapi_app/db fastapi_app/config
   ```

5. **Update .gitignore**:
   ```
   # Application runtime data
   data/db/
   data/files/

   # Test runtime data (ephemeral)
   tests/api/runtime/
   tests/e2e/runtime/
   ```

**Validation**:
- ✅ Both Flask and FastAPI work with new `data/` structure
- ✅ No references to old data paths remain
- ✅ Application starts and serves requests correctly
- ✅ File operations work (upload, download, delete)

---

### Step 2: Test Directory Reorganization

**Objective**: Move all tests to new unified structure without breaking existing functionality.

**Tasks**:

1. **Create new directory structure**:
   ```bash
   mkdir -p tests/api/v0 tests/api/v1 tests/api/fixtures tests/api/helpers tests/api/runtime
   mkdir -p tests/e2e/fixtures tests/e2e/helpers tests/e2e/runtime
   mkdir -p tests/unit/js tests/unit/flask tests/unit/fastapi
   ```

2. **Move API tests**:
   ```bash
   # Flask tests
   mv tests/e2e/backend/*.test.js tests/api/v0/

   # FastAPI tests
   mv fastapi_app/tests/backend/*.test.js tests/api/v1/
   ```

3. **Move unit tests**:
   ```bash
   # JavaScript unit tests
   mv tests/js/*.test.js tests/unit/js/

   # Flask unit tests
   mv tests/py/*.py tests/unit/flask/

   # FastAPI unit tests
   mv fastapi_app/tests/py/*.py tests/unit/fastapi/
   ```

4. **Create test fixtures**:
   - Create `tests/api/fixtures/minimal/config/` with basic config
   - Create `tests/api/fixtures/standard/config/` with typical test scenario
   - Create `tests/e2e/fixtures/minimal/config/` with basic config
   - Create `tests/e2e/fixtures/standard/config/` with typical test scenario

5. **Create fixture loader utility**:
   - Create `tests/lib/fixture-loader.js`:
     - Load config presets from fixture directories
     - Initialize runtime directories: `tests/{api,e2e}/runtime/{db,files,logs}`
     - Run import script if needed for file fixtures
     - **Cleanup strategy**:
       - Clean runtime directories **before** tests start
       - Clean runtime directories **after** tests finish successfully
       - **Keep runtime data for debugging** if tests fail

6. **Update test runners**:
   - Update [tests/backend-test-runner.js](../../tests/backend-test-runner.js):
     - Change default from `fastapi_app/tests/backend/` to `tests/api/v1/`
     - Support `--test-dir tests/api/v0` for Flask tests
     - Add `--fixture` flag to select fixture preset
   - Update [tests/smart-test-runner.js](../../tests/smart-test-runner.js):
     - Recognize new test paths
     - Support `tests/unit/` for unit tests

7. **Update npm scripts** in [package.json](../../package.json):
   ```json
   {
     "test:api:v0": "node tests/backend-test-runner.js --test-dir tests/api/v0",
     "test:api:v1": "node tests/backend-test-runner.js --test-dir tests/api/v1",
     "test:api": "npm run test:api:v1",
     "test:unit:js": "node --test tests/unit/js/**/*.test.js",
     "test:unit:flask": "uv run python -m unittest discover tests/unit/flask",
     "test:unit:fastapi": "uv run python -m unittest discover tests/unit/fastapi",
     "test:unit:py": "npm run test:unit:flask && npm run test:unit:fastapi",
     "test:unit": "npm run test:unit:js && npm run test:unit:py"
   }
   ```

**Validation**:
- ✅ All API tests pass in their new locations
- ✅ Unit tests pass in new structure
- ✅ Fixture loader correctly initializes runtime data
- ✅ No import errors or broken references

---

### Step 3: Cross-Backend API Testing

**Objective**: Validate API equivalence by running v0 tests against FastAPI and v1 tests against Flask.

**Tasks**:

1. **Review API test compatibility**:
   - Identify tests that rely on backend-specific behavior
   - Document expected differences (if any)
   - Create compatibility matrix

2. **Update API tests to use fixtures**:
   - Ensure tests initialize with fixture loader
   - Tests should use `E2E_BASE_URL` environment variable
   - No hardcoded paths to `data/`, `db/`, or `config/`

3. **Run FastAPI tests (v1) against Flask server**:
   ```bash
   # Terminal 1: Start Flask dev server with test fixture
   npm run dev -- --fixture minimal

   # Terminal 2: Run FastAPI tests against Flask
   E2E_BASE_URL=http://localhost:5000 node --test tests/api/v1/*.test.js
   ```

   - Document failures and their causes
   - Fix Flask implementation if bugs found
   - Mark tests as "Flask-incompatible" if intentional differences exist

4. **Run Flask tests (v0) against FastAPI server**:
   ```bash
   # Terminal 1: Start FastAPI dev server with test fixture
   npm run dev:fastapi -- --fixture minimal

   # Terminal 2: Run Flask tests against FastAPI
   E2E_BASE_URL=http://localhost:8000 node --test tests/api/v0/*.test.js
   ```

   - Document failures and their causes
   - Fix FastAPI implementation if bugs found
   - Mark tests as "FastAPI-incompatible" if intentional differences exist

5. **Create equivalence test report**:
   - List all tests with compatibility status
   - Document API differences between Flask and FastAPI
   - Recommend fixes or clarify intended behavior

6. **Add cross-backend npm scripts**:
   ```json
   {
     "test:api:v1-on-flask": "echo 'Start Flask server first' && E2E_BASE_URL=http://localhost:5000 node --test tests/api/v1/*.test.js",
     "test:api:v0-on-fastapi": "echo 'Start FastAPI server first' && E2E_BASE_URL=http://localhost:8000 node --test tests/api/v0/*.test.js"
   }
   ```

**Validation**:
- ✅ Cross-backend compatibility documented
- ✅ All critical API endpoints behave identically
- ✅ Differences justified and documented
- ✅ No regressions introduced

---

### Step 4: Playwright E2E Integration with FastAPI

**Objective**: Configure Playwright tests to work with FastAPI backend in both local and containerized modes.

**Tasks**:

1. **Review Playwright test configuration**:
   - Read [tests/e2e/playwright.config.js](../../tests/e2e/playwright.config.js)
   - Identify Flask-specific assumptions
   - Document required backend configuration

2. **Update Playwright to use fixtures and runtime data**:
   - Playwright tests should load from `tests/e2e/fixtures/`
   - Runtime data generated in `tests/e2e/runtime/{db,files}`
   - Import script runs before tests to populate `tests/e2e/runtime/files/` from fixtures

3. **Update local server configuration**:
   - Modify [tests/lib/local-server-manager.js](../../tests/lib/local-server-manager.js):
     - Add `--backend fastapi|flask` option
     - Add `--fixture` option to select fixture preset
     - Initialize `tests/e2e/runtime/` from selected fixture
     - Support different ports and startup commands
   - Ensure FastAPI test mode matches containerized setup

4. **Test Playwright with local FastAPI**:
   ```bash
   # Run E2E tests against local FastAPI server with fixture
   npm run test:e2e:local -- --backend fastapi --fixture standard
   ```

   - Fix test failures related to backend differences
   - Update test fixtures if needed
   - Verify all frontend features work

5. **Update E2E runner for backend selection**:
   - Modify [tests/e2e-runner.js](../../tests/e2e-runner.js):
     - Add `--backend` flag (default: `fastapi`)
     - Add `--fixture` flag (default: `standard`)
     - Pass backend selection to server managers
   - Update npm scripts:
     ```json
     {
       "test:e2e": "node tests/e2e-runner.js --local --backend fastapi",
       "test:e2e:flask": "node tests/e2e-runner.js --local --backend flask"
     }
     ```

**Validation**:
- ✅ Playwright tests pass with FastAPI backend (local mode)
- ✅ Test fixtures properly initialized in `tests/e2e/runtime/`
- ✅ All frontend features functional
- ✅ Backend selection configurable

---

### Step 5: Containerized Testing for Both Backends

**Objective**: Ensure all test types work in isolated containers for both Flask and FastAPI.

**Tasks**:

1. **Update Dockerfiles for new data structure**:
   - Update Flask Dockerfile to use `data/db/`, `data/files/`
   - Update FastAPI Dockerfile to use `data/db/`, `data/files/`
   - Include fixture loading in container startup

2. **Update ContainerServerManager**:
   - Modify [tests/lib/container-server-manager.js](../../tests/lib/container-server-manager.js):
     - Add `backend` parameter (`fastapi` or `flask`)
     - Add `fixture` parameter to select fixture preset
     - Support different Dockerfiles and build contexts
     - Handle backend-specific environment variables
     - Mount `tests/e2e/runtime/` as volume for E2E tests

3. **Test API tests in containers**:
   ```bash
   # FastAPI API tests (containerized)
   npm run test:backend:container -- --test-dir tests/api/v1 --fixture minimal

   # Flask API tests (containerized)
   npm run test:backend:container -- --backend flask --test-dir tests/api/v0 --fixture minimal
   ```

4. **Test Playwright in containers**:
   ```bash
   # FastAPI E2E tests (containerized)
   npm run test:e2e:container -- --fixture standard

   # Flask E2E tests (containerized)
   npm run test:e2e:container -- --backend flask --fixture standard
   ```

5. **Create comprehensive test matrix npm scripts**:
   ```json
   {
     "test:all:fastapi:local": "npm run test:api:v1 && npm run test:e2e:local",
     "test:all:fastapi:container": "npm run test:backend:container -- --test-dir tests/api/v1 && npm run test:e2e:container",
     "test:all:flask:local": "npm run test:api:v0-on-flask && npm run test:e2e:flask",
     "test:all:flask:container": "npm run test:backend:container -- --backend flask --test-dir tests/api/v0 && npm run test:e2e:container -- --backend flask",
     "test:all": "npm run test:unit && npm run test:all:fastapi:container"
   }
   ```

**Validation**:
- ✅ All API tests pass in containers (both backends)
- ✅ Playwright tests pass in containers (both backends)
- ✅ Container setup/teardown reliable
- ✅ No port conflicts or resource leaks

---

### Step 6: Documentation and Cleanup

**Objective**: Update documentation, remove deprecated scripts, and finalize test organization.

**Tasks**:

1. **Update test documentation**:
   - Update [prompts/testing-guide.md](../../prompts/testing-guide.md):
     - Document new test structure
     - Explain v0 vs v1 API tests
     - Explain fixture system and runtime data
     - Provide cross-backend testing examples
   - Update [prompts/development-commands.md](../../prompts/development-commands.md):
     - Add new npm scripts
     - Document backend selection flags
     - Document fixture system

2. **Update architecture documentation**:
   - Update [prompts/architecture.md](../../prompts/architecture.md):
     - Document new `data/` structure
     - Explain test data organization
   - Update [CLAUDE.md](../../CLAUDE.md):
     - Update test commands
     - Document new test directory structure
     - Add cross-backend testing examples

3. **Update migration plan**:
   - Update [fastapi_app/prompts/migration-plan.md](../../fastapi_app/prompts/migration-plan.md):
     - Mark Phase 9 as complete
     - Document final test structure
     - Update "Running Tests" section

4. **Remove deprecated scripts and directories**:
   ```bash
   # Remove old FastAPI test directory
   rm -rf fastapi_app/tests/

   # Remove deprecated test script
   rm bin/test-fastapi.py

   # Remove old test directories
   rm -rf tests/e2e/backend/
   rm -rf tests/js/
   rm -rf tests/py/

   # Remove old data directories (after migration verified)
   rm -rf fastapi_app/data fastapi_app/db fastapi_app/config
   rm -rf db/
   ```

5. **Create Phase 9 completion report**:
   - Document test structure changes
   - Document data structure changes
   - Summarize API equivalence findings
   - List any remaining Flask-specific tests
   - Provide migration timeline for final switchover

**Validation**:
- ✅ All documentation accurate and up-to-date
- ✅ No broken links or outdated references
- ✅ Deprecated code removed
- ✅ Completion report comprehensive

---

## Success Criteria

**Phase 9 Completion**:

- ✅ Application data unified under `data/` directory
- ✅ Both Flask and FastAPI use same data structure
- ✅ All tests organized in unified structure (`tests/api/`, `tests/e2e/`, `tests/unit/`)
- ✅ API tests versioned as v0 (Flask) and v1 (FastAPI)
- ✅ Test fixtures organized with config presets
- ✅ Runtime data properly gitignored in `tests/e2e/runtime/`
- ✅ Cross-backend testing validated (v1 tests on Flask, v0 tests on FastAPI)
- ✅ API equivalence documented with compatibility matrix
- ✅ Playwright tests work with FastAPI backend (local and containerized)
- ✅ All test types pass in containerized mode for both backends
- ✅ Backend and fixture selection configurable via flags
- ✅ Comprehensive npm scripts for all test scenarios
- ✅ Documentation updated and accurate
- ✅ Deprecated scripts and directories removed
- ✅ Zero regressions in existing tests

**API Equivalence Validation**:

- ✅ 100% of critical endpoints behave identically
- ✅ Documented differences justified (e.g., performance, error messages)
- ✅ No breaking changes for frontend
- ✅ Both backends pass same test suite

**Data Structure Migration**:

- ✅ Single source of truth for application data: `data/`
- ✅ No FastAPI-specific data directories remain
- ✅ Clear separation between fixtures and runtime data
- ✅ Fixture loader utility functional
- ✅ Import script works with new structure

**Phase 10 Readiness**:

- ✅ Clear path to Flask decommissioning
- ✅ Tests ready for production deployment
- ✅ CI/CD pipeline can use containerized tests
- ✅ Documentation supports final switchover

## Test Execution Matrix

### Development Workflow

| Test Type | Backend | Mode | Command |
|-----------|---------|------|---------|
| Unit (JS) | N/A | N/A | `npm run test:unit:js` |
| Unit (Flask) | N/A | N/A | `npm run test:unit:flask` |
| Unit (FastAPI) | N/A | N/A | `npm run test:unit:fastapi` |
| API v0 (Flask) | Flask | Local dev server | `npm run test:api:v0-on-flask` |
| API v1 (FastAPI) | FastAPI | Local | `npm run test:api:v1` |
| API v1 (FastAPI) | Flask | Local dev server | `npm run test:api:v1-on-flask` |
| API v0 (Flask) | FastAPI | Local | `npm run test:api:v0-on-fastapi` |
| E2E | FastAPI | Local | `npm run test:e2e:local` |
| E2E | Flask | Local dev server | `npm run test:e2e:flask` |

### CI/CD Workflow

| Test Type | Backend | Mode | Command |
|-----------|---------|------|---------|
| Unit (all) | N/A | N/A | `npm run test:unit` |
| API v1 | FastAPI | Container | `npm run test:backend:container -- --test-dir tests/api/v1` |
| API v0 | Flask | Container | `npm run test:backend:container -- --backend flask --test-dir tests/api/v0` |
| E2E | FastAPI | Container | `npm run test:e2e:container` |
| E2E | Flask | Container | `npm run test:e2e:container -- --backend flask` |
| All tests | FastAPI | Container | `npm run test:all` |

## Critical Implementation Notes

### Application Data Structure

**Unified data directory**:
- `data/db/` - Database JSON files (users, collections, etc.)
- `data/files/` - Document files and metadata
- `data/webdav-data/` - Legacy data for migration reference

**Configuration**:
- Consider keeping `config/` at root or move to `data/config/` (decision TBD)
- Both backends must use same config location

### Test Fixtures

**Fixture structure**:
- Fixtures contain **config presets only**, no db/files
- Runtime data generated in `tests/e2e/runtime/` (gitignored)
- Import script populates runtime data from fixtures on test startup

**Fixture presets**:
- `minimal/` - Basic setup for smoke tests
- `standard/` - Typical test scenario with users, collections, documents
- `complex/` - Advanced scenarios (permissions, workflows, etc.)

### Runtime Data Management

**Test runtime directories** (`tests/api/runtime/` and `tests/e2e/runtime/`):

- Ephemeral data generated during test execution
- Must be gitignored
- Structure: `{db, files, logs}/`
  - `db/` - Database files generated during tests
  - `files/` - Document files generated during tests
  - `logs/` - Server logs for each test run (separate from `./log`)

**Cleanup strategy**:

- **Before tests start**: Clean runtime directories to ensure fresh state
- **After successful tests**: Clean runtime directories to avoid clutter
- **After failed tests**: **Keep runtime data** for debugging
  - Logs help diagnose server issues
  - Database state helps understand test failures
  - Files help reproduce issues

**Fixture loader responsibilities**:

- Clean runtime directories before test run
- Copy config from fixture preset
- Initialize empty `db/`, `files/`, and `logs/` directories
- Run import script to populate from config
- Clean up after successful test completion
- Skip cleanup if tests fail (for debugging)

### API Test Compatibility

All API tests must be backend-agnostic:
- Use `E2E_BASE_URL` environment variable
- Use fixture loader for initialization
- No hardcoded URLs, ports, or paths
- No backend-specific assumptions
- Test business logic, not implementation details

### Backend Selection

Test runners must support flags:
- `--backend fastapi|flask` - Select backend (default: `fastapi`)
- `--fixture minimal|standard|complex` - Select fixture preset (default: `standard`)
- Affects server startup command, port, and data initialization
- Passed through to all server managers

### Incremental Migration

Data structure can be migrated incrementally:
1. Create new `data/` structure
2. Update Flask to use new structure
3. Update FastAPI to use new structure
4. Verify both work correctly
5. Remove old directories

Tests can be migrated incrementally:
1. Move tests to new structure
2. Validate they pass in original backend
3. Test cross-backend compatibility
4. Update documentation
5. Remove deprecated versions

### Flask Decommissioning Path

After Phase 9:
1. All tests pass for both backends
2. API equivalence validated
3. Flask tests (v0) can be kept as regression suite
4. Once FastAPI in production:
   - Archive `tests/api/v0/`
   - Remove `tests/unit/flask/`
   - Update documentation to remove Flask references
   - Keep fixture system for FastAPI testing

## Dependencies

- Phase 8 completion (unified testing infrastructure)
- Working Flask development server
- Working FastAPI development server
- Playwright tests functional with Flask
- Docker/Podman for containerized testing
- Import script for populating test data

## Risks and Mitigations

**Risk**: Data structure migration breaks existing functionality
- **Mitigation**: Incremental migration, thorough testing at each step

**Risk**: API differences break cross-backend tests
- **Mitigation**: Document differences, fix critical ones, accept minor differences

**Risk**: Playwright tests fail with FastAPI backend
- **Mitigation**: Careful fixture setup, gradual migration, thorough debugging

**Risk**: Container setup issues on different platforms
- **Mitigation**: Test on macOS, Linux, Windows; use Phase 8 infrastructure

**Risk**: Test fixtures diverge or become stale
- **Mitigation**: Single source of truth, fixture loader validation, documentation

**Risk**: Runtime data not properly cleaned between tests
- **Mitigation**: Explicit cleanup in fixture loader, test isolation

## Next Phase

[Phase 10: Documentation and Cleanup](phase-10-documentation.md) (to be created)

- API documentation generation
- Developer guides
- Deployment documentation
- Flask decommissioning
- Final cleanup
- Legacy data migration from `data/webdav-data/`

---

Last updated: 2025-10-16

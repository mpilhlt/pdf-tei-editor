# Phase 8: Unified Testing Infrastructure - Local & Containerized

## Overview

Create a unified testing infrastructure that supports two execution modes:
1. **Local server testing** (default) - Fast iteration during development using a local backend server
2. **Containerized testing** (CI) - Isolated environment for CI/CD and pre-deployment validation

The design abstracts server lifecycle management from test execution, allowing seamless operation with the current backend during migration and the new backend after migration is complete.

## Design Principles

1. **Backend-Agnostic Tests**: All `*.test.js` files use `E2E_BASE_URL` environment variable - no hardcoded backend knowledge
2. **Mode-Based Execution**: Clear distinction between local (fast) and containerized (isolated) modes
3. **Layered Architecture**: Separation of concerns across discovery, orchestration, server lifecycle, and test execution
4. **Zero Code Duplication**: Shared logic extracted into reusable modules
5. **Migration-Friendly**: Works during transition period, then legacy code cleanly removed

## Test Organization

**Current State (During Migration)**:
```
tests/
├── js/                           # JavaScript unit tests (no server needed)
├── py/                           # Python unit tests - Flask-specific
├── e2e/
│   ├── frontend/                 # Playwright tests (*.spec.js)
│   └── backend/                  # Flask backend integration tests (*.test.js)

fastapi_app/
└── tests/
    ├── backend/                  # FastAPI backend integration tests (*.test.js)
    └── py/                       # FastAPI Python unit tests
```

**Target State (Phase 9 - Post-Migration)**:
```
tests/
├── js/                           # JavaScript unit tests (no server needed)
├── py/                           # Python unit tests - consolidated
├── e2e/
│   ├── frontend/                 # Playwright tests (*.spec.js)
│   └── backend/                  # Backend integration tests (*.test.js) - consolidated
```

All tests use `E2E_BASE_URL` environment variable, making them backend-agnostic.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: CLI Commands (package.json)                       │
│  npm run test:backend [--local|--container]                 │
│  npm run test:e2e [--local|--container]                     │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────┴────────────────────────────────────────────┐
│  Layer 2: Test Orchestration                                │
│  tests/backend-test-runner.js (backend *.test.js)           │
│  tests/e2e-runner.js (Playwright *.spec.js)                 │
│  - Discovers tests                                          │
│  - Filters by --grep/--grep-invert                          │
│  - Delegates to server managers                             │
│  - Executes tests                                           │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────┴────────────────────────────────────────────┐
│  Layer 3: Server Lifecycle Managers (SHARED)                │
│  tests/lib/server-manager.js (interface)                    │
│  ├── LocalServerManager (local mode)                        │
│  ├── ContainerServerManager (container mode)                │
│  └── WebdavServerManager (sync tests - local & container)   │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────┴────────────────────────────────────────────┐
│  Layer 4: Test Execution                                    │
│  - Backend: node --test {test-files}                        │
│  - Playwright: npx playwright test                          │
│  All tests read E2E_BASE_URL from environment               │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Tasks

### Task 1: Create Server Manager Abstraction
**File**: `tests/lib/server-manager.js`

Abstract interface for server lifecycle:
```javascript
class ServerManager {
  async start(options) { /* Start server, return base URL */ }
  async stop() { /* Stop server and cleanup */ }
  async isHealthy() { /* Check /health endpoint */ }
  getBaseUrl() { /* Return E2E_BASE_URL value */ }
}
```

### Task 2: Implement Local Server Manager
**File**: `tests/lib/local-server-manager.js`

Port functionality from `bin/test-fastapi.py`:
- Kill existing servers on port 8000
- Optionally wipe database (--clean-db flag)
- Start local server via `npm run dev:fastapi`
- Wait for /health endpoint
- Cleanup on exit (unless --no-cleanup)

**Key Features**:
- Cross-platform process management (pkill, lsof, taskkill)
- Log capture to `log/test-server.log`
- Health check with timeout

**Note**: WebDAV server is now a separate ServerManager (see Task 3a)

### Task 3: Implement Container Server Manager
**File**: `tests/lib/container-server-manager.js`

Refactor from `tests/e2e-runner.js`:
- Extract container lifecycle logic
- Support both Docker and Podman
- Build/rebuild control (--no-rebuild)
- Environment variable injection
- Health check via /health endpoint
- Log extraction and cleanup

**Reuses**:
- Existing container detection
- Image building logic
- Port management
- Cleanup handlers

### Task 3a: Implement WebDAV Server Manager
**File**: `tests/lib/webdav-server-manager.js`

Create a standalone ServerManager for WebDAV server used in sync tests:

**Purpose**:
- Decouples WebDAV lifecycle from LocalServerManager
- Enables WebDAV in containerized environments
- Allows orchestrator to start WebDAV independently

**Features**:
- Extends ServerManager abstract class
- Starts WsgiDAV server on configurable port (default: 8080)
- Generates temporary .env file for WebDAV configuration
- Cross-platform process management (pkill, lsof, taskkill)
- Health check via directory listing endpoint
- Independent cleanup

**Usage**:
```javascript
const webdavManager = new WebdavServerManager();
await webdavManager.start({
  port: 8080,
  webdavDir: 'path/to/webdav/root',
  verbose: false
});
const baseUrl = webdavManager.getBaseUrl(); // http://localhost:8080
await webdavManager.stop();
```

**Integration**:
- Backend-test-runner detects sync tests and auto-starts WebDAV
- E2E runner can start WebDAV in container or local mode
- No coupling to backend server lifecycle

### Task 4: Create Unified Backend Test Runner
**File**: `tests/backend-test-runner.js`

Orchestrates backend test execution:
- Test discovery (glob `**/*.test.js` from specified directories)
- Filtering (--grep, --grep-invert patterns)
- Server manager selection (--local vs --container)
- Test execution coordination (node --test)
- Result aggregation and reporting
- Automatic server lifecycle management

**CLI Options**:
```bash
--local              # Use local server (default)
--container          # Use containerized server
--grep <pattern>     # Filter tests by pattern
--grep-invert <pat>  # Exclude tests by pattern
--clean-db           # Wipe database before tests (local only)
--no-cleanup         # Keep server running after tests
--keep-db            # Don't wipe database (faster iteration)
--env <VAR=val>      # Pass environment variables (VAR or VAR=value)
--env-file <path>    # Load environment variables from .env file
--test-dir <path>    # Test directory (default: auto-detect)
```

**Environment Variable Handling**:

The runner supports multiple ways to inject environment variables:

1. **Individual variables**: `--env GEMINI_API_KEY` (reads from current env)
2. **Key-value pairs**: `--env API_KEY=secret123`
3. **Batch from .env file**: `--env-file .env.testing`
4. **FastAPI server .env override** (local mode only): Set `FASTAPI_ENV_FILE=/path/to/.env` to override the FastAPI server's default .env file

**Example .env file**:
```bash
# .env.testing
GEMINI_API_KEY=your_key_here
WEBDAV_HOST=localhost
WEBDAV_PORT=8080
```

**Usage**:
```bash
# Individual environment variables
node tests/backend-test-runner.js --env GEMINI_API_KEY

# Mix of sources
node tests/backend-test-runner.js --env-file .env.testing --env DEBUG=true

# Override .env file values
node tests/backend-test-runner.js --env-file .env --env GEMINI_API_KEY=override

# Override FastAPI server's .env file (local mode only)
FASTAPI_ENV_FILE=.env.testing node tests/backend-test-runner.js --local
```

**Note**: In containerized mode, all environment variables must be explicitly passed via `--env` or `--env-file` since the container doesn't have access to the host's environment or .env files.

### Task 5: Update Smart Test Runner Integration
**File**: `tests/smart-test-runner.js`

- Add backend mode detection (local vs container)
- Delegate backend tests to `backend-test-runner.js`
- Pass through grep patterns and environment variables
- Default to local mode for speed, container for CI

### Task 6: Update CLI Commands
**File**: `package.json`

```json
{
  "scripts": {
    // Backend integration tests - local (fast iteration)
    "test:backend": "node tests/backend-test-runner.js --local",
    "test:backend:local": "node tests/backend-test-runner.js --local",
    "test:backend:fast": "node tests/backend-test-runner.js --local --keep-db",

    // Backend integration tests - containerized (CI-ready)
    "test:backend:container": "node tests/backend-test-runner.js --container",
    "test:backend:ci": "node tests/backend-test-runner.js --container",

    // Playwright frontend tests - local (fast iteration)
    "test:e2e": "node tests/e2e-runner.js --playwright --local",
    "test:e2e:local": "node tests/e2e-runner.js --playwright --local",
    "test:e2e:headed": "node tests/e2e-runner.js --playwright --local --headed",

    // Playwright frontend tests - containerized (CI-ready)
    "test:e2e:container": "node tests/e2e-runner.js --playwright --container",
    "test:e2e:ci": "node tests/e2e-runner.js --playwright --container",

    // Smart test runner (delegates to both runners)
    "test:changed": "node tests/smart-test-runner.js",
    "test:all": "node tests/smart-test-runner.js --all"
  }
}
```

**Removed Scripts**:
- `test:fastapi:e2e` - Fully replaced by `test:backend`
- `test:e2e:backend` - Removed to avoid confusion (use `test:backend`)

### Task 7: Refactor E2E Runner (Playwright Focus)
**File**: `tests/e2e-runner.js`

Update to use shared server managers:
- Extract container logic to `ContainerServerManager`
- Support both `--local` and `--container` modes for Playwright tests
- Reuse `LocalServerManager` for local Playwright testing
- Reuse `ContainerServerManager` for containerized Playwright testing
- Remove backend test execution (delegated to `backend-test-runner.js`)

**Key Changes**:
- Playwright can now run against local server (fast iteration)
- Playwright can run against containerized server (CI mode)
- No code duplication - both runners share the same server managers

### Task 8: Design Phase 9 Test Consolidation
**File**: `fastapi_app/prompts/phase-9-consolidation.md`

Plan for consolidating all tests into `tests/` directory:
- Move `fastapi_app/tests/backend/*.test.js` → `tests/e2e/backend/`
- Move `fastapi_app/tests/py/*.py` → `tests/py/`
- Update test discovery paths in `backend-test-runner.js`
- Remove `tests/e2e/backend/` Flask tests
- Remove `fastapi_app/tests/` directory entirely
- Update all npm scripts to use consolidated paths

**Migration Strategy**:
1. Ensure all tests are backend-agnostic (use `E2E_BASE_URL`)
2. Add `--test-dir` parameter to `backend-test-runner.js` for flexible discovery
3. Test with both `fastapi_app/tests/backend` and `tests/e2e/backend` paths
4. Move tests in a single commit to ensure clean history
5. Update documentation and remove deprecated paths

## File Structure

**Phase 8 Structure (During Migration)**:

```
tests/
├── backend-test-runner.js          # NEW: Unified backend orchestrator
├── lib/
│   ├── server-manager.js           # NEW: Abstract interface
│   ├── local-server-manager.js     # NEW: Local server lifecycle
│   ├── container-server-manager.js # NEW: Container lifecycle (refactored)
│   └── webdav-server-manager.js    # NEW: Standalone WebDAV server
├── smart-test-runner.js            # UPDATED: Delegates backend tests
├── e2e-runner.js                   # UPDATED: Uses shared server managers
├── js/                             # JavaScript unit tests
├── py/                             # Python unit tests (Flask-specific)
└── e2e/
    ├── frontend/                   # Playwright tests (*.spec.js)
    └── backend/                    # Flask backend tests (*.test.js) - legacy

fastapi_app/
└── tests/
    ├── backend/                    # FastAPI backend tests (*.test.js)
    └── py/                         # FastAPI Python unit tests

bin/
└── test-fastapi.py                 # DEPRECATED: Logic moved to local-server-manager.js
```

**Phase 9 Structure (Post-Migration - Target State)**:

```
tests/
├── backend-test-runner.js          # Unified backend orchestrator
├── lib/
│   ├── server-manager.js           # Abstract interface
│   ├── local-server-manager.js     # Local server lifecycle
│   ├── container-server-manager.js # Container lifecycle
│   └── webdav-server-manager.js    # Standalone WebDAV server
├── smart-test-runner.js            # Smart test orchestration
├── e2e-runner.js                   # Playwright test orchestration
├── js/                             # JavaScript unit tests
├── py/                             # Python unit tests (consolidated)
└── e2e/
    ├── frontend/                   # Playwright tests (*.spec.js)
    └── backend/                    # Backend integration tests (*.test.js) - consolidated

# fastapi_app/tests/ removed entirely
# bin/test-fastapi.py removed entirely
```

**Key Design Points for Phase 9 Compatibility**:

1. **Test Discovery**: `backend-test-runner.js` accepts `--test-dir` parameter, allowing it to discover tests from any directory
2. **Backend-Agnostic**: All tests use `E2E_BASE_URL` - no hardcoded Flask/FastAPI references
3. **Server Managers**: Abstracted lifecycle works with any backend that exposes `/health` endpoint
4. **Flexible Paths**: Smart test runner can work with both directory structures during migration

## Migration Timeline

**Week 1: Foundation**
1. Create `ServerManager` abstract class
2. Implement `LocalServerManager` (port from test-fastapi.py)
3. Implement `ContainerServerManager` (refactor from e2e-runner.js)
4. Implement `WebdavServerManager` (decouple from LocalServerManager)
5. Add comprehensive JSDoc and error handling

**Week 2: Integration**
6. Create `backend-test-runner.js` with test discovery
7. Integrate with server managers (backend + WebDAV)
8. Add CLI argument parsing with `--env-file` support
9. Update `package.json` scripts (remove `test:fastapi:e2e`)

**Week 3: Smart Runner & Testing**
10. Update `smart-test-runner.js` to use backend-test-runner
11. Test local mode with FastAPI tests
12. Test container mode with existing tests
13. Test WebDAV integration in both modes
14. Documentation and examples

**Post-Migration Cleanup**
15. Remove `bin/test-fastapi.py`
16. Remove legacy test infrastructure
17. Update e2e-runner.js to focus on Playwright only

## Usage Examples

**Development (local server)**:
```bash
# Run all backend tests with local server
npm run test:backend

# Run specific tests (fast iteration with database kept)
npm run test:backend:fast -- --grep validation

# Debug mode (keep server running)
node tests/backend-test-runner.js --local --no-cleanup --grep auth

# Clean slate test
node tests/backend-test-runner.js --local --clean-db --grep extraction

# Load environment variables from file
node tests/backend-test-runner.js --local --env-file .env.testing

# Override FastAPI server's .env (local mode only)
FASTAPI_ENV_FILE=.env.testing npm run test:backend
```

**CI/CD (containerized)**:
```bash
# Run all tests in isolated container
npm run test:backend:ci

# Specific test suite
npm run test:backend:container -- --grep "file operations"

# With environment variables
node tests/backend-test-runner.js --container --env GEMINI_API_KEY

# Load environment variables from file (for container injection)
node tests/backend-test-runner.js --container --env-file .env.ci

# Mix sources
node tests/backend-test-runner.js --container --env-file .env --env DEBUG=1
```

**Smart testing (detects mode)**:
```bash
# Changed files only (defaults to local)
npm run test:changed

# All tests
npm run test:all

# CI mode
CI=true npm run test:changed  # Uses container mode
```

## Benefits

1. **Fast Iteration**: Local mode ~2-5s startup vs ~30-60s containerized
2. **CI-Ready**: Container mode provides isolated, reproducible environments
3. **No Duplication**: Server lifecycle logic centralized in managers
4. **Migration-Friendly**: Works during transition, legacy cleanly removed after
5. **Flexible Testing**: Easy to switch between local and containerized
6. **Clear Intent**: CLI commands express developer/CI intent clearly
7. **Cross-Platform**: Works on macOS, Linux, and Windows

## Phase 9 Preparation: Test Consolidation Strategy

Phase 8 infrastructure is designed to enable seamless test consolidation in Phase 9. Here's how the transition will work:

### Test Directory Consolidation

**Step 1: Verify Backend-Agnostic Tests**

All tests must use `E2E_BASE_URL` environment variable:

```javascript
// ✅ Good - backend-agnostic
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// ❌ Bad - hardcoded backend
const BASE_URL = 'http://localhost:5000';  // Flask-specific
```

**Step 2: Add Test Directory Flexibility**

Update `backend-test-runner.js` to support `--test-dir` parameter:

```javascript
// Default behavior (Phase 8)
const defaultDirs = [
  'fastapi_app/tests/backend',  // FastAPI tests during migration
  'tests/e2e/backend'            // Flask tests (legacy)
];

// Phase 9 behavior
const defaultDirs = [
  'tests/e2e/backend'            // Consolidated tests
];
```

**Step 3: Migration Sequence**

1. Run all FastAPI tests from `fastapi_app/tests/backend/` to ensure 100% pass rate
2. Move tests in git:
   - `git mv fastapi_app/tests/backend/*.test.js tests/e2e/backend/`
   - `git mv fastapi_app/tests/py/*.py tests/py/`
3. Remove Flask backend tests from `tests/e2e/backend/` (no longer needed)
4. Update `backend-test-runner.js` default test directory
5. Update npm scripts to remove temporary migration commands
6. Remove `fastapi_app/tests/` directory
7. Remove `bin/test-fastapi.py`
8. Update documentation

**Step 4: Verify Consolidation**

```bash
# All backend tests work from consolidated location
npm run test:backend

# Playwright tests still work
npm run test:e2e

# Smart test runner works with new structure
npm run test:changed

# Both local and container modes work
npm run test:backend:local
npm run test:backend:container
npm run test:e2e:local
npm run test:e2e:container
```

### CLI Evolution Across Phases

**Phase 8 (During Migration)**:

```bash
# Two separate backend test locations
node tests/backend-test-runner.js --test-dir fastapi_app/tests/backend  # FastAPI
node tests/backend-test-runner.js --test-dir tests/e2e/backend          # Flask

# Playwright tests (containerized only)
npm run test:e2e  # Uses container
```

**Phase 9 (Post-Migration)**:

```bash
# Single consolidated backend test location
npm run test:backend          # Uses tests/e2e/backend, local mode
npm run test:backend:container # Same tests, container mode

# Playwright tests (local or container)
npm run test:e2e              # Local mode (fast)
npm run test:e2e:container    # Container mode (CI)
```

### File Moves Checklist

- [ ] Move `fastapi_app/tests/backend/auth.test.js` → `tests/e2e/backend/auth.test.js`
- [ ] Move `fastapi_app/tests/backend/config.test.js` → `tests/e2e/backend/config.test.js`
- [ ] Move `fastapi_app/tests/backend/files_*.test.js` → `tests/e2e/backend/files_*.test.js`
- [ ] Move `fastapi_app/tests/backend/validation.test.js` → `tests/e2e/backend/validation.test.js`
- [ ] Move `fastapi_app/tests/backend/extraction.test.js` → `tests/e2e/backend/extraction.test.js`
- [ ] Move `fastapi_app/tests/backend/sync.test.js` → `tests/e2e/backend/sync.test.js`
- [ ] Move `fastapi_app/tests/backend/sse.test.js` → `tests/e2e/backend/sse.test.js`
- [ ] Move `fastapi_app/tests/py/*.py` → `tests/py/`
- [ ] Remove Flask tests from `tests/e2e/backend/` (basic-auth, extractor-api, file-locks-api, etc.)
- [ ] Remove `fastapi_app/tests/` directory
- [ ] Remove `bin/test-fastapi.py`
- [ ] Update `.gitignore` if needed
- [ ] Update `CLAUDE.md` test documentation

## Success Criteria

**Phase 8 Completion**:

- ✅ Server manager abstraction implemented and documented
- ✅ Local server manager works cross-platform (macOS, Linux, Windows)
- ✅ Container server manager supports Docker and Podman
- ✅ WebDAV server manager as standalone, reusable component
- ✅ Backend test runner discovers and executes tests in both modes
- ✅ Environment variable injection via `--env` and `--env-file`
- ✅ E2E runner uses shared server managers for Playwright tests
- ✅ All FastAPI backend tests pass in local mode
- ✅ All FastAPI backend tests pass in container mode
- ✅ Playwright tests work in both local and container modes
- ✅ Smart test runner delegates correctly to specialized runners
- ✅ WebDAV server starts independently in local and container modes
- ✅ Zero code duplication between server managers
- ✅ Clear, self-documenting CLI interface
- ✅ Comprehensive error messages and logging
- ✅ Legacy `test:fastapi:e2e` npm script removed

**Phase 9 Readiness**:

- ✅ All tests are backend-agnostic (use `E2E_BASE_URL`)
- ✅ Test directory parameter (`--test-dir`) implemented and tested
- ✅ Migration plan documented with step-by-step checklist
- ✅ Both test directory structures work during transition
- ✅ No breaking changes when consolidating tests

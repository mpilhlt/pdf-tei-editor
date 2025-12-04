# Testing Guide

This document provides comprehensive information about the testing infrastructure for the PDF-TEI-Editor project.

## Table of Contents

1. [Testing Architecture](#testing-architecture)
2. [Quick Reference](#quick-reference)
3. [Unit Tests](#unit-tests)
4. [API Integration Tests](#api-integration-tests)
5. [End-to-End Tests](#end-to-end-tests)
6. [Smart Test Runner](#smart-test-runner)
7. [Writing New Tests](#writing-new-tests)
8. [Debugging Tests](#debugging-tests)

## Testing Architecture

The project uses a multi-tiered testing approach:

- **Unit Tests**: JavaScript (Node.js test runner) and Python (pytest) for isolated component testing
- **API Integration Tests**: Node.js-based tests against local or containerized FastAPI backend
- **End-to-End Tests**: Playwright browser tests against containerized application
- **Smart Test Selection**: Dependency-aware test execution based on `@testCovers` annotations

### Test Directory Structure

```
tests/
├── unit/                        # Unit tests
│   ├── js/                      # JavaScript unit tests (*.test.js)
│   ├── fastapi/                 # FastAPI unit tests (test_*.py)
│   └── flask/                   # Legacy Flask unit tests (test_*.py)
├── api/                         # API integration tests
│   ├── v1/                      # API v1 tests (*.test.js)
│   ├── helpers/                 # Shared test utilities
│   └── fixtures/                # Test data fixtures
├── e2e/                         # End-to-end tests
│   ├── tests/                   # Playwright test specs (*.spec.js)
│   ├── tests/helpers/           # E2E test helpers
│   └── fixtures/                # E2E test fixtures
├── lib/                         # Test infrastructure
│   ├── local-server-manager.js  # Local server management
│   ├── container-server-manager.js  # Container management
│   └── ...                      # Other test utilities
├── backend-test-runner.js       # API test runner (local/container)
├── e2e-runner.js               # E2E test runner (local/container)
├── smart-test-runner.js        # Intelligent test selection
├── unit-test-runner.js         # JavaScript unit test runner
└── unit-test-runner.py         # Python unit test runner
```

## Quick Reference

### Common Test Commands

```bash
# Run all tests
npm test

# Run only changed tests (smart selection)
npm run test:changed

# Unit Tests
npm run test:unit              # All unit tests (JS + Python)
npm run test:unit:js           # JavaScript unit tests only
npm run test:unit:fastapi      # FastAPI Python unit tests

# API Integration Tests (FastAPI backend)
npm run test:api               # Local server (fastest)

# End-to-End Tests (Playwright)
npm run test:e2e               # Local server (fastest)
npm run test:e2e:headed        # Show browser UI
npm run test:e2e:debug         # Step-through debugging
npm run test:e2e:debug-failure # Capture debug artifacts on failure

# Container Tests (runs all tests inside container, same as CI)
npm run test:container                                  # Run with cache
npm run test:container -- --no-cache                    # Rebuild all layers
npm run test:container -- path/to/file.js               # Test specific files
npm run test:container -- --browser firefox             # Use specific browser
npm run test:container -- --browser chromium,firefox,webkit  # Test multiple browsers

# Run specific tests
npm run test:api -- --grep "save"
npm run test:e2e -- --grep "authentication"
```

### Test Runner Options

Local test runners (`test:api`, `test:e2e`) support:

```bash
# Filter tests by pattern
--grep <pattern>               # Run matching tests
--grep-invert <pattern>        # Exclude matching tests

# Database management
--clean-db                     # Wipe database (default for local)
--keep-db                      # Preserve database between runs

# Browser selection (E2E only)
--browser <name>               # Use specific browser (chromium, firefox, webkit)

# Other options
--verbose                      # Show detailed output
--no-cleanup                   # Keep server running after tests
```

Container test runner (`test:container`) options:

```bash
--no-cache                     # Rebuild all Docker layers (ignore cache)
--browser <browsers>           # Comma-separated list for E2E tests
--all                          # Run all tests (skip smart selection)
--grep <pattern>               # Filter tests by pattern
# Plus any other smart-test-runner.js options
```

## Unit Tests

Unit tests validate individual components in isolation without external dependencies.

### JavaScript Unit Tests

**Location**: `tests/unit/js/`
**Runner**: Node.js built-in test runner
**Command**: `npm run test:unit:js`

Example:

```javascript
import { test } from 'node:test';
import assert from 'node:assert';
import { PluginManager } from '../../app/src/modules/plugin-manager.js';

test('plugin manager registration', () => {
  const manager = new PluginManager();
  const plugin = { name: 'test-plugin', install: () => {} };

  manager.register(plugin);
  assert.strictEqual(manager.plugins.length, 1);
});
```

### Python Unit Tests

**Location**: `tests/unit/fastapi/` (FastAPI) and `tests/unit/flask/` (legacy)
**Runner**: pytest
**Command**: `npm run test:unit:fastapi`

Example:

```python
import pytest
from fastapi_app.lib.auth import verify_password, hash_password

def test_password_hashing():
    password = "test123"
    hashed = hash_password(password)
    assert verify_password(password, hashed)
    assert not verify_password("wrong", hashed)
```

## API Integration Tests

API integration tests validate backend endpoints without a browser. They run against a local FastAPI server.

**Location**: `tests/api/v1/`
**Naming**: `*.test.js`
**Runner**: `backend-test-runner.js`
**Command**: `npm run test:api`

### Key Features

- **Fast Iteration**: Local mode starts/stops server automatically
- **Database Management**: Auto-wipes DB between runs (configurable)
- **Fixture Support**: Load test data from `tests/api/fixtures/`
- **Authentication Helpers**: Built-in session management
- **Lock Management**: Automatic cleanup between tests

### Writing API Tests

API tests use Node.js built-in test runner with helper utilities:

```javascript
/**
 * @testCovers fastapi_app/routers/files_save.py
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

describe('Files Save API', () => {
  let session = null;

  test('Setup: login as reviewer', async () => {
    session = await login('reviewer', 'reviewer', BASE_URL);
    assert.ok(session?.sessionId);
  });

  test('should create new gold standard file', async () => {
    const response = await authenticatedApiCall(
      session.sessionId,
      '/files/save',
      'POST',
      {
        file_id: 'test-doc',
        xml_string: '<TEI>...</TEI>'
      },
      BASE_URL
    );

    assert.strictEqual(response.status, 'new_gold');
    assert.ok(response.file_id);
    logger.success(`Created file: ${response.file_id}`);
  });
});
```

### Authentication Helpers

```javascript
import { login, authenticatedApiCall, createTestSession } from '../helpers/test-auth.js';

// Login with specific user
const session = await login('reviewer', 'reviewer', BASE_URL);

// Make authenticated API call
const result = await authenticatedApiCall(
  session.sessionId,
  '/files/save',
  'POST',
  { file_id: 'test', xml_string: '<TEI/>' },
  BASE_URL
);

// Create session (uses default 'testuser')
const defaultSession = await createTestSession(BASE_URL);
```

### Lock Cleanup

Always clean up locks in test teardown:

```javascript
import { clearAllLocks } from '../helpers/test-cleanup.js';

test('Cleanup: release locks', async () => {
  await clearAllLocks(BASE_URL);
});
```

### Running API Tests

```bash
# Local server (fast iteration)
npm run test:api

# With database preservation
npm run test:api -- --keep-db

# Specific tests
npm run test:api -- --grep "save"

# In container (CI environment)
npm run test:container -- --grep "save"
```

## End-to-End Tests

E2E tests use Playwright to test the full application stack in a browser.

**Location**: `tests/e2e/tests/`
**Naming**: `*.spec.js`
**Runner**: `e2e-runner.js`
**Command**: `npm run test:e2e` (local) or `npm run test:container` (containerized)

### Key Features

- **Full Browser Testing**: Chromium, Firefox, WebKit support
- **Containerized Environment**: Isolated test instances
- **UI Navigation System**: Type-safe access via `window.ui`
- **Test Logging**: Structured state verification via `testLog()`
- **Headed Mode**: Visual debugging with `--headed`
- **Step-through Debugging**: Playwright debugger with `--debug`

### Writing E2E Tests

```javascript
/**
 * @testCovers app/src/plugins/authentication.js
 * @testCovers fastapi_app/routers/auth.py
 */
/** @import { namedElementsTree } from '../../app/src/ui.js' */
import { test, expect } from '../fixtures/debug-on-failure.js';
import { performLogin, performLogout } from './helpers/login-helper.js';

test.describe('Authentication Workflow', () => {
  test('should login successfully', async ({ page }) => {
    await page.goto('http://localhost:8000');

    await performLogin(page, 'testuser', 'testpass');

    // Verify login using UI navigation
    const username = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.toolbar.userMenu.textContent;
    });

    expect(username).toContain('testuser');
  });
});
```

### UI Navigation System

Access UI elements using the typed navigation system:

```javascript
await page.evaluate(() => {
  /** @type {namedElementsTree} */
  const ui = /** @type {any} */(window).ui;

  // Form interactions
  ui.loginDialog.username.value = 'testuser';
  ui.loginDialog.password.value = 'testpass';
  ui.loginDialog.submit.click();

  // Read state
  return ui.loginDialog.open; // boolean
});
```

### Test Logging System

Use `testLog()` for state verification instead of DOM queries:

```javascript
import { setupTestConsoleCapture, waitForTestMessage } from './helpers/test-logging.js';

// Set up console capture
const consoleLogs = setupTestConsoleCapture(page);

// Perform action...
await page.evaluate(() => {
  window.client.saveXml(/* ... */);
});

// Wait for and verify state change
const saveLog = await waitForTestMessage(consoleLogs, 'FILE_SAVED');
expect(saveLog.value.file_id).toBeTruthy();
expect(saveLog.value.status).toBe('saved');
```

### Running E2E Tests

```bash
# Local server (fastest)
npm run test:e2e

# Show browser UI
npm run test:e2e:headed

# Step-through debugging
npm run test:e2e:debug

# Specific browser
npm run test:e2e -- --browser firefox

# Specific tests
npm run test:e2e -- --grep "authentication"

# In container (CI environment)
npm run test:container -- --browser chromium
npm run test:container -- --browser chromium,firefox,webkit  # Multiple browsers
```

## Smart Test Runner

The smart test runner automatically selects tests based on file dependencies, dramatically reducing test execution time.

### How It Works

1. Scans test files for `@testCovers` annotations
2. Compares changed files against test dependencies
3. Runs only affected tests plus wildcard tests

### Usage

```bash
# Run tests for changed files (git diff) - local server
npm run test:changed

# Run tests for changed files - in container (CI environment)
npm run test:container

# Test specific files
npm run test:container -- app/src/plugins/auth.js fastapi_app/routers/auth.py

# Dry run (show which tests would run)
node tests/smart-test-runner.js --changed-files app/src/ui.js --dry-run

# Run all tests
npm test  # Local
npm run test:container -- --all  # Container
```

### Test Coverage Annotations

Add `@testCovers` comments to link tests to source files:

```javascript
/**
 * @testCovers app/src/plugins/authentication.js
 * @testCovers fastapi_app/routers/auth.py
 * @testCovers app/src/modules/api-client.js
 */
test('authentication workflow', async ({ page }) => {
  // Test code...
});

/**
 * @testCovers app/src/*
 */
test('frontend smoke test', async ({ page }) => {
  // Runs when any frontend file changes
});
```

Supported patterns:
- Exact: `app/src/ui.js`
- Wildcard: `app/src/*` (all files in directory)
- Recursive: `app/src/**/*.js` (all JS files recursively)

## Writing New Tests

### General Guidelines

1. **Add `@testCovers` annotations** for smart test selection
2. **Clean up after tests** - Release locks, delete test files
3. **Use helper functions** - Don't duplicate authentication/setup code
4. **Sequential vs Parallel** - Use `describe.serial()` for dependent tests
5. **Meaningful assertions** - Test behavior, not implementation details

### Test Organization

- **Unit tests**: Test single functions/classes in isolation
- **API tests**: Test endpoint behavior and business logic
- **E2E tests**: Test complete user workflows

### Naming Conventions

- Unit tests: `feature.test.js` or `test_feature.py`
- API tests: `resource_action.test.js` (e.g., `files_save.test.js`)
- E2E tests: `workflow-description.spec.js` (e.g., `auth-workflow.spec.js`)

### Example Test Structure

```javascript
describe('Feature Name', () => {
  // Setup
  test('Setup: create test data', async () => {
    // Initialize test state
  });

  // Main tests
  test('should handle success case', async () => {
    // Test implementation
  });

  test('should handle error case', async () => {
    // Test error handling
  });

  // Cleanup
  test('Cleanup: remove test data', async () => {
    // Clean up resources
  });
});
```

## Debugging Tests

### API Test Debugging

```bash
# Verbose output
npm run test:api -- --verbose --grep "save"

# Keep database for inspection
npm run test:api -- --keep-db --no-cleanup

# Check specific endpoint
curl -X POST http://localhost:8000/api/files/save \
  -H "Content-Type: application/json" \
  -d '{"file_id":"test","xml_string":"<TEI/>"}'
```

### E2E Test Debugging

```bash
# Show browser UI
npm run test:e2e:headed -- --grep "auth"

# Step-through debugging (Playwright debugger)
npm run test:e2e:debug -- --grep "auth"

# Capture debug artifacts on failure
npm run test:e2e:debug-failure -- --grep "auth"

# Add breakpoints in test code
await page.pause(); // Pauses execution
```

**Debug-on-Failure Mode**:
When using `npm run test:e2e:debug-failure`, failed tests will:

- Stop on first failure
- Capture console messages to `console-messages.json`
- Capture page errors to `page-errors.json`
- Take screenshots automatically
- Record video of the test execution
- Save all artifacts to `tests/e2e/test-results/<test-name>/`

This is particularly useful for debugging failures where you need to understand what happened during test execution.

**Implementation**: All E2E tests import from `../fixtures/debug-on-failure.js` by default, which enables this feature when the `--debug-on-failure` flag is used. During normal test runs, the fixture has no effect.

### Common Issues

**Lock Conflicts**:
- Use `--clean-db` to reset locks
- Ensure tests call cleanup helpers

**Port Conflicts**:
- Test runners auto-select available ports
- Check for stale server processes: `lsof -i :8000`

**Container Issues**:
- Rebuild image: remove `--no-rebuild` flag
- Check logs: `docker logs <container-id>`

**Test Timeouts**:
- Increase timeout: `--timeout 180` (seconds)
- Check server startup logs

### Debug Logging

Enable verbose output:

```bash
# API tests
npm run test:api -- --verbose

# E2E tests with debug messages
E2E_DEBUG=true npm run test:e2e
```

## Continuous Integration

### Pre-push Hooks

Smart test runner automatically runs on `git push`:

```bash
# Runs affected tests only (local server)
git push
```

### CI Pipeline (GitHub Actions)

The CI pipeline runs tests inside a container:

```bash
# GitHub Actions workflow runs:
# 1. Build CI container image (pdf-tei-editor:ci)
# 2. Run smart test runner inside container with changed files
# 3. Stream output in real-time
# 4. Report results as PR comment

# Local equivalent:
npm run test:container
```

**CI Architecture:**

- Tests run entirely inside container (not against it)
- All fixtures and code baked into image at build time
- Real-time streaming output (not a black box)
- Docker layer caching for fast builds
- Smart test selection based on changed files

## Test Fixtures

### API Test Fixtures

Located in `tests/api/fixtures/`:

- **minimal**: Bare minimum config for smoke tests
- **standard**: Full config with sample data

Fixtures are automatically loaded by `backend-test-runner.js`.

### E2E Test Fixtures

Located in `tests/e2e/fixtures/`:

- **minimal**: Basic setup for quick tests
- **standard**: Complete environment with sample files

Fixtures include:
- Config files (`config/`)
- Sample PDF/TEI files (`files/`)
- User credentials

## Additional Resources

- **Test Infrastructure**: See `tests/lib/` for server management utilities
- **Helper Functions**: Check `tests/*/helpers/` for shared test utilities
- **Example Tests**: Review existing tests in each category for patterns

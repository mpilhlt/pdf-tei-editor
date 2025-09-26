# Testing Guide

## Testing Architecture

**Smart Test Runner**: Automatically selects relevant tests based on file dependencies using `@testCovers` annotations. Supports wildcard patterns like `@testCovers app/src/*` for frontend-wide coverage.

**End-to-End Tests**: Unified cross-platform E2E testing using Node.js runner (`tests/e2e-runner.js`) that handles both Playwright browser tests and backend integration tests. Run `tests/e2e-runner.js --help` for a list of options. Features:

- **Containerized testing**: Docker/Podman with multi-stage builds and layer caching
- **Cross-platform support**: Works on Windows, macOS, and Linux (replaces Linux-only bash script)
- **Dual test modes**: Playwright browser tests (`--playwright` flag) and backend integration tests (`--backend` flag)
- **Automatic cleanup**: Containers cleaned up, images preserved for cache efficiency
- **Environment variables**: `E2E_HOST`, `E2E_PORT`, `E2E_CONTAINER_PORT` for flexible configuration
- **Test environment configuration**: Support for `@env` annotations and `--env` flags to pass environment variables to test containers
- **Integration**: Works with smart test runner via `@testCovers` annotations

## General Testing Principles

1. **Absolutely prefer adapting tests over changing source code to avoid costly rebuilds** - especially when debugging. Use the ":fast" variant of the `npm run test:*` commands when you have only added/changed test code.
2. **Always create/run isolated backend tests before creating/running complex UI workflow tests** - The UI tests should not depend on untested backend behavior that might break them - they must only test UI behavior.
3. **Clean up after each test** - Test suites **MUST NOT** change the application state - all locks must be released, all uploaded files deleted, etc. If tests depend on each other, they must be placed in the same suite and run sequentially.
4. **Test file organization** - Tests are organized by type: frontend tests (`*.spec.js`) in `tests/e2e/frontend/` use Playwright, backend tests (`*.test.js`) in `tests/e2e/backend/` use Node.js test runner. Helper files are in respective `helpers/` subdirectories to avoid duplication.
5. **Lock management in tests** - Always use `releaseAllLocks()` helper in finally blocks for frontend tests, and `cleanupSessionLocks()` for backend tests to prevent lock conflicts between tests.

## Backend Tests

Backend tests are Node.js-based integration tests that run against the containerized server API without a browser. They are used to validate API endpoints and server-side logic.

- **Location**: `tests/e2e/backend`
- **File Naming**: `*.test.js`
- **Test Runner**: Node.js built-in test runner (`node:test`)
- **Execution Command**: `npm run test:e2e:backend` or `node tests/e2e-runner.js --backend`
- **Dependency Tracking**: Use `@testCovers` annotations to link tests to the backend source files they cover (e.g., `server/api/auth.py`).

Tests make direct HTTP requests to the API endpoints exposed by the running container. The test runner provides the following environment variables to construct the base URL:

- `E2E_HOST`: The host where the container is exposed (e.g., `localhost`).
- `E2E_PORT`: The port on which the container is exposed (e.g., `8000`).

**Example Backend Test:**

```javascript
/**
 * @testCovers server/api/files/locks.py
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

describe('File Locks API', () => {
  test('should return active locks', async () => {
    // Assumes authentication helpers are available
    const response = await fetch(`${API_BASE}/files/locks`);
    assert.strictEqual(response.status, 200);
    const locks = await response.json();
    assert(typeof locks === 'object');
  });
});
```

- **Authentication**: For endpoints that require authentication, use the helpers provided in `tests/e2e/backend/helpers/test-auth.js` to create authenticated sessions and make API calls.
- **Session Management**: Use single session approach for sequential tests that depend on each other. Add `{ concurrency: 1 }` to describe blocks for tests that must run in sequence.
- **Lock Cleanup**: Use `cleanupSessionLocks()` helper to release all locks held by a session to prevent conflicts between tests.

## Frontend Tests

- **Location**: `tests/e2e/frontend`
- **File Naming**: `*.spec.js`
- **Test Runner**: Playwright (`@playwright/test`)
- **Execution Command**: `npm run test:e2e` or `node tests/e2e-runner.js --playwright`
- **Dependency Tracking**: Use `@testCovers` annotations to link tests to the frontend source files they cover (e.g., `app/src/plugins/xmleditor.js`).

### UI Testing Guidelines

- **Avoid to access client objects directly** - they are not exposed as globals on `window` by default. You can expose them specifically for testing purposes in `app/src/app.js`, especially to avoid to have to interact with the UI, unless the UI is explicitly the testing target.
- **E2E tests should use the UI navigation system** exposed via `window.ui` (see `app/src/ui.js:103`) to efficiently access UI parts documented via JSDoc. This provides type-safe access to named DOM elements like `ui.toolbar.pdf`, `ui.dialog.message`, etc. For custom selectors, the navigation system helps identify paths to named descendants.
- **Use testLog to pass state data** - Plugin code can pass `currentState` or specific values through console
- **Use helper functions from tests/e2e/helpers/test-logging.js** - Import `setupTestConsoleCapture` and `waitForTestMessage` for consistent parsing
- **Message names must match `[A-Z_][A-Z0-9_]*` pattern** - testLog enforces this with regex validation for reliable parsing
- **Wait for specific TEST messages** - More reliable than polling DOM or using fixed timeouts
- **Validate state transitions** - Check oldHash vs newHash to verify state changes occurred
- **Scope isolation** - Console logs captured in Node.js scope, browser state passed through testLog system
- **Self-contained testLog expressions** - All data must be computed within testLog() calls for easy bundle removal from production code

### Test Logging for E2E Tests

The application includes a structured test logging system for E2E tests that provides fast state and flow verification without relying on DOM queries:

- **Test Logger Factory**: `tests/e2e/frontend/helpers/test-logging.js` exports `createTestLogger(applicationMode)`
- **Application Integration**: `app/src/app.js` exports `testLog` function configured during startup
- **Configuration**: Only active when `application.mode === "testing"`
- **Docker Integration**: `docker/entrypoint-test.sh` automatically enables testing mode

Usage in Plugins:

```javascript
import { testLog } from '../app.js';

// Log state transitions and business logic flow
testLog('PDF_LOADED', { filename, user: this.state.user });
testLog('VALIDATION_STARTED', { documentVersion: this.state.documentVersion });
testLog('VALIDATION_COMPLETED', { errors: results.errors.length, warnings: results.warnings.length });
```

### E2E Test Best Practices

**Enhanced Console Log Handling with JSON Values (Recommended)**:

```javascript
// Import the test logging helper functions
import { setupTestConsoleCapture, waitForTestMessage } from './helpers/test-logging.js';

// Set up enhanced console log capture for TEST messages
const consoleLogs = setupTestConsoleCapture(page);

// Usage - wait for events and validate state data
const uploadLog = await waitForTestMessage(consoleLogs, 'PDF_UPLOAD_COMPLETED');
expect(uploadLog.value).toHaveProperty('filename');
expect(uploadLog.value).toHaveProperty('originalFilename');

const versionLog = await waitForTestMessage(consoleLogs, 'NEW_VERSION_CREATED');
expect(versionLog.value.newHash).not.toBe(versionLog.value.oldHash);
```

**In Plugin Code - Pass State Through testLog**:

```javascript
import { testLog } from '../app.js';

// Pass state data through console for test verification
// IMPORTANT: Message names must match pattern [A-Z_][A-Z0-9_]*
// (uppercase letters, numbers, underscores only, starting with letter or underscore)
testLog('NEW_VERSION_CREATED', { oldHash: state.xml, newHash: hash });
testLog('STATE_AFTER_LOGIN', currentState);
testLog('EXTRACTION_COMPLETED', { resultHash, pdfFilename, metadata });

// Format: "TEST: MESSAGE_NAME JSON_DATA"
// Parsed with regex: /^TEST:\s+([A-Z_][A-Z0-9_]*)\s*(.*)?$/
// Result: message=group1, value=parsed group2

// CRITICAL: All data must be computed within the testLog() expression
// This allows the entire testLog() call to be removed from production bundles
testLog('REVISION_IN_XML_VERIFIED', {
  changeDescription: dialog.changeDesc.value,
  xmlContainsRevision: xmlEditor.getXML().includes(dialog.changeDesc.value)
});

// NOT this - creates dependencies that can't be easily removed:
// const xmlContent = xmlEditor.getXML();
// const hasRevision = xmlContent.includes(description);
// testLog('REVISION_VERIFIED', { hasRevision });
```

**Use window.ui for UI Interactions (Required)**:

```javascript
// Import the UI type at the top of E2E test files
/** @import { namedElementsTree } from '../../app/src/ui.js' */

// Use JSDoc type casting for clean, typed access to window.ui
await page.evaluate(() => {
  /** @type {namedElementsTree} */
  const ui = /** @type {any} */(window).ui;
  ui.loginDialog.username.value = 'testuser';
  ui.loginDialog.password.value = 'testpass';
  ui.loginDialog.submit.click();
});

// Benefits: Full autocompletion, no null checks needed, clean syntax
// The typed UI structure guarantees child elements exist

// NOT this - avoid DOM selectors
// await page.locator('sl-input[name="username"]').fill('testuser');
```

**Enable debug output from test files with E2E_DEBUG environment variable:**

You can use debug output liberally in the test files themselves, but output must be suppressed unless the E2E_DEBUG environment variable is set. For example, create a little helper function at the beginning of the test files:

```javascript
//
const DEBUG = process.env.E2E_DEBUG === 'true';
const debugLog = (...args) => {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
};
```

When debugging test failures, you can then call tests with that variable set and analyze the output:

```shell
E2E_DEBUG=true npm run test:e2e -- --grep "extraction"
```

### E2E Test Authentication and API Access

When making API calls from E2E tests in the browser context:

1. **Never make direct fetch() calls to API endpoints** - Authentication requires the `X-Session-ID` header which must match the browser session
2. **Use the client API through window.client** - The client object handles proper authentication headers automatically. See `app/src/plugins/client.js` for the API.
3. **Example proper API usage**:

   ```javascript
   await page.evaluate(async () => {
     // CORRECT: Use client API with proper authentication
     await window.client.releaseLock(fileId);

     // WRONG: Direct fetch without proper session headers
     // await fetch('/api/files/release_lock', { ... })
   });
   ```

4. **Lock cleanup in frontend tests** - Always use `releaseAllLocks()` helper in finally blocks:

   ```javascript
   import { releaseAllLocks } from './helpers/login-helper.js';

   try {
     // Test logic here
   } finally {
     await releaseAllLocks(page);  // Cleanup locks before test ends
     await performLogout(page);
   }
   ```

### Debugging E2E Test Failures

When fixing failing E2E tests or creating new ones:

1. **Add temporary testLog() calls** to trace workflow execution and identify where tests are failing
2. **Use TEST_ prefix for debugging calls** - All debugging testLog() calls should use message names starting with "TEST_" (e.g., `testLog('TEST_BUTTON_STATE', {...})`) to make them easily identifiable and removable after debugging
3. **🚨 CRITICAL: Rebuild the image** using `npm run test:e2e` (not `npm run test:e2e:fast`) to include new testLog calls
   **ANY changes to source code (including adding testLog calls) REQUIRE a full rebuild - :fast will NOT pick up source changes!**
4. **Use extensive logging during debugging** to understand the exact failure point and state transitions
5. **Check saved logs**: When E2E tests fail, the test runner saves container and server logs to `tests/e2e/test-results/`. Inspect `container-logs-*.txt` for startup issues and `server-logs-*.txt` for backend errors.
6. **Clean up after success** - Once tests pass, remove all testLog() calls with "TEST_" prefix and keep only the minimum required for test validation
7. **Avoid source pollution** - Don't leave debugging testLog() calls in the source code permanently
8. **Use E2E_DEBUG environment variable in test files** Enable debug output in E2E tests (verbose logging)
9. **Temporary global exposure**: If needed for debugging, expose objects to global scope in `app/src/app.js` for E2E testing. If no test directly depends on that object, remove after debugging has been sucessfully concluded.

**Debugging Workflow:**

```bash
# 1. Add testLog() calls to plugin source files using TEST_ prefix
# Example: testLog('TEST_BUTTON_CLICKED', { buttonId, disabled })
# 2. Rebuild image with new logging
npm run test:e2e

# 3. Run specific failing test with full output
npm run test:e2e -- --grep "failing test name"

# 4. Once fixed, remove all testLog() calls with TEST_ prefix
# 5. Keep only essential testLog() calls for test assertions (no TEST_ prefix)
```

**Note**: HTML reports are disabled by default in this project, so no need to prepend `PLAYWRIGHT_HTML_REPORT=off` to E2E test commands.

**testLog() Call Categories:**

- **Essential calls**: Used by tests for validation (e.g., `PDF_UPLOAD_COMPLETED`, `NEW_VERSION_CREATED`) - keep these
- **Debugging calls**: Use `TEST_` prefix (e.g., `TEST_STATE_UPDATE`, `TEST_BUTTON_CLICKED`) - remove after debugging

**Note**: Adding `@env` annotations to test files does NOT require rebuilding the image - these are processed at runtime by the E2E runner. Only changes to application source code require rebuilding.

### Common Test Issues and Solutions

**Hash Lookup Table Issues**: If backend tests fail with "File path not found in lookup table" errors, the hash lookup cache may need rebuilding. The system automatically rebuilds the cache when the lookup table is missing, but if you encounter persistent issues:

- Delete `schema/cache/` directory to force cache refresh
- Ensure test data files exist in expected locations (`demo/data/`, `data/`)

**Import Path Errors**: After test reorganization, ensure import paths use correct relative paths:

- Frontend tests: Use `./helpers/helper-name.js` for same-level helpers
- Backend tests: Use `../helpers/helper-name.js` for parent directory helpers
- Don't duplicate helper files - use imports instead

**Lock Conflicts**: Tests may fail due to file locks not being released:

- Frontend: Always use `releaseAllLocks(page)` in finally blocks
- Backend: Use `cleanupSessionLocks(sessionId)` after each test suite
- Sequential tests: Add `{ concurrency: 1 }` to describe blocks for dependent tests

**Authentication Errors**: Backend tests getting 403/401 errors:

- Use `authenticatedApiCall()` helper instead of raw fetch()
- Ensure correct user role for operations (user/annotator/reviewer/admin)
- Check that session is properly created and passed between test calls

## Test Fixtures Configuration

When setting up test fixtures for E2E tests:

- **Database vs Config files**: You only need to prepare either `db/` directory OR `config/` directory, not both:
  - If you preconfigure `db/` directory with test data, files in `config/` will be ignored
  - If you prepare files in `config/`, they will be copied to an empty `db/` directory on startup
  - Choose the approach that makes most sense for your test scenario

- **Incremental testing**: When developing new tests, start with testing only the specific functionality you created:
  - Use `npm run test:e2e -- --grep "your-test-name"` to run specific tests
  - Verify individual test files work before running comprehensive test suites
  - Only run full `npm run test:e2e:backend` or `npm run test:e2e` after individual tests pass
  - This approach saves time and makes debugging easier

### Environment Variable Configuration for Tests

E2E tests can specify required environment variables using `@env` annotations, which are automatically passed to the test container:

```javascript
/**
 * E2E test requiring external services
 * @testCovers app/src/plugins/extraction.js
 * @testCovers server/extractors/grobid.py
 * @env GROBID_SERVER_URL
 * @env GEMINI_API_KEY
 */
test('should complete extraction workflow', async ({ page }) => {
  // Test extraction functionality that requires external APIs
});
```

**Command Line Usage:**

```bash
# Pass specific environment variables to test containers
npm run test:e2e -- --env GROBID_SERVER_URL --env GEMINI_API_KEY

# Combine with test filtering
npm run test:e2e -- --grep "extraction" --env GROBID_SERVER_URL

# Environment variables are read from host environment and passed to container
GROBID_SERVER_URL="https://api.example.com" npm run test:e2e

# Enable debug output in E2E tests (verbose logging)
E2E_DEBUG=true npm run test:e2e -- --grep "extraction"

# Configure parallel vs sequential test execution
npm run test:e2e -- --workers=1                    # Force sequential execution
npm run test:e2e -- --workers=4                    # Force parallel execution (4 workers)
```

**Supported Formats:**

- `@env VARIABLE_NAME` - Pass environment variable from host to container
- `--env VARIABLE_NAME` - Command line equivalent for manual testing
- Variables are automatically processed and injected into both Docker and Podman containers
- Missing environment variables are logged as warnings but don't fail the test setup

## Browser Automation and Testing

### MCP Browser Integration

Don't use MCP Browser Integration tools, they are too slow to be functional. Suggest to create a E2E test instead (see above)

## Annex

### e2e-runner.js CLI options

```shell

$ ./tests/e2e-runner.js --help
Unified Cross-platform E2E Test Runner
======================================

Usage:
  # Playwright browser tests
  node tests/e2e-runner.js --playwright [options]

  # Backend API tests (all *.test.js files in tests/e2e)
  node tests/e2e-runner.js --backend [options]


Common Options:
  --grep <pattern>     Run tests matching pattern
  --grep-invert <pattern> Exclude tests matching pattern
  --fail-fast          Abort on first test failure and skip remaining tests
  --no-rebuild         Use existing container image without rebuilding
  --build-only         Build container image only, do not run tests
  --env <var>          Environment variable to pass to container (can be used multiple times)
  --dotenv-path <path> Path to .env file to load (default: .env)

Playwright Options:
  --browser <name>     Browser to use (chromium|firefox|webkit) [default: chromium]
  --headed             Run tests in headed mode (show browser)
  --debug              Enable debug mode
  --mode <mode>        Environment mode (production|development) [default: production]
  --production         Use production mode
  --development        Use development mode
  --workers <number>   Number of workers (default:1, which runs the tests in sequence)

Environment Variables:
  E2E_HOST           Host to bind container (default: localhost)
  E2E_PORT           Port to expose container on host (default: 8000)
  E2E_CONTAINER_PORT Port inside container (default: 8000)

Examples:
  # Run Playwright tests
  node tests/e2e-runner.js --playwright
  node tests/e2e-runner.js --playwright --browser firefox --headed
  node tests/e2e-runner.js --playwright --grep-invert @dev-only

  # Run backend API tests
  node tests/e2e-runner.js --backend
  node tests/e2e-runner.js --backend --grep "file-locks"
  node tests/e2e-runner.js --backend --grep-invert "extractor"

  # Run with existing image (faster)
  node tests/e2e-runner.js --playwright --no-rebuild
  node tests/e2e-runner.js --backend --no-rebuild

  # Fail-fast mode (stop on first failure)
  node tests/e2e-runner.js --playwright --fail-fast
  node tests/e2e-runner.js --backend --fail-fast

  # Build image only (no tests)
  node tests/e2e-runner.js --build-only

  # Custom port
  E2E_PORT=8001 node tests/e2e-runner.js --playwright --debug

  # Custom environment file
  node tests/e2e-runner.js --backend --dotenv-path .env.testing

```

###

```shell

$ ./tests/smart-test-runner.js --help
🧠 Smart Test Runner - Intelligent test execution based on file dependencies

Usage:
  node tests/smart-test-runner.js [options]

Options:
  --all                    Run all tests regardless of changes
  --changed-files <files>  Comma-separated list of changed files to analyze
  --dry-run                Show which tests would run without executing them
  --dotenv-path <path>     Path to .env file for E2E tests (passed to e2e-runner.js)
  --tap                    Output results in TAP format
  --debug                  Enable debug logging
  --help, -h               Show this help message

Examples:
  node tests/smart-test-runner.js
  node tests/smart-test-runner.js --all
  node tests/smart-test-runner.js --changed-files app/src/ui.js,server/api/auth.py
  node tests/smart-test-runner.js --changed-files app/src/ui.js --dry-run --debug
  node tests/smart-test-runner.js --dotenv-path .env.testing
  node tests/smart-test-runner.js --tap

How it works:
  • Analyzes test files for @testCovers annotations
  • Detects JavaScript import dependencies automatically
  • Runs only tests affected by changed files
  • Always runs tests marked with @testCovers *

```

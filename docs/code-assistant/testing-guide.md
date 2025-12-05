# Testing Guide

Essential testing information for code assistants. For comprehensive testing documentation, see [../development/testing.md](../development/testing.md).

## Test Structure

```
tests/
├── unit/{js,fastapi}/         # Unit tests
├── api/v1/                     # API integration tests (*.test.js)
├── e2e/tests/                  # E2E Playwright tests (*.spec.js)
├── backend-test-runner.js      # API test runner
├── e2e-runner.js              # E2E test runner
└── smart-test-runner.js       # Intelligent test selection
```

## Quick Commands

```bash
# Run tests for changed files only (use this most often)
npm run test:changed

# Unit tests
npm run test:unit:js          # JavaScript units
npm run test:unit:fastapi     # Python units

# API tests (local FastAPI server, no containers)
npm run test:api              # All API tests
npm run test:api -- --grep "save"  # Specific tests

# E2E tests (Playwright)
npm run test:e2e              # All E2E tests with local server
npm run test:e2e:headed       # Show browser
npm run test:e2e:debug        # Step-through debugging
npm run test:e2e:debug-failure # Capture debug artifacts on failure (headless)

# Container tests (runs all tests inside container)
npm run test:container                                  # Run with cache
npm run test:container -- --no-cache                    # Rebuild all layers
npm run test:container -- path/to/file.js               # Test specific files
npm run test:container -- --browser firefox             # Use specific browser
npm run test:container -- --browser chromium,firefox,webkit  # Test multiple browsers
```

## Test Types

### Unit Tests

- **Location**: `tests/unit/{js,fastapi}/`
- **Purpose**: Test isolated functions/classes
- **Run**: `npm run test:unit`

### API Integration Tests

- **Location**: `tests/api/v1/`
- **Naming**: `*.test.js`
- **Purpose**: Test backend endpoints without browser
- **Run**: `npm run test:api`
- **Features**: Local server, auto-cleanup, fixtures from `tests/api/fixtures/`

#### Fixture System

API tests use a two-phase fixture loading system:

**Phase 1: Config Loading** (before server starts)

- Copies JSON config files from `tests/api/fixtures/{fixture-name}/config/` to `tests/api/runtime/config/`
- Config files: `users.json`, `groups.json`, `roles.json`, `collections.json`
- Server reads these during initialization to set up RBAC

**Phase 2: File Import** (after server starts)

- Imports PDF/XML files from `tests/api/fixtures/{fixture-name}/files/` using `bin/import_files.py`
- Files are imported into the `default` collection (matches default group access)
- Creates database entries and stores files in content-addressable hash-sharded structure
- TEI files in the fixture directory are detected as gold standard files and linked to their PDFs

**Available Fixtures**:

- `minimal`: Basic config with minimal users/groups (no files)
- `standard`: Standard config + sample PDF/TEI files for testing

**Access Control Considerations**:

- Fixture files are imported into the `default` collection
- Test users need appropriate group membership to access fixture files
- Standard fixture users (`reviewer`, `annotator`, `user`) are in the `default` group with access to `_inbox` and `default` collections
- `admin` user has wildcard access (`*`) to all collections

**CRITICAL:** Do not alter fixtures

- Tests should NOT permanently modify fixture files or delete them in cleanup - they're shared across tests and automatically cleaned up when the runtime directory is wiped.
- Ideally, make a copy of the fixture file or add new files to alter/delete, at a minimun restore altered files after the test.

### E2E Tests

- **Location**: `tests/e2e/tests/`
- **Naming**: `*.spec.js`
- **Purpose**: Test full workflows in browser
- **Run**: `npm run test:e2e`
- **Features**: Playwright, `window.ui` navigation, `testLog()` for state verification

#### Container Testing

**Run Tests Inside Container** (`npm run test:container`):

- **Purpose**: Run all tests in an isolated container environment (same as CI)
- **What it does**:
  - Builds the `ci` container image with all dependencies and test code
  - Runs tests inside the container (not against it)
  - Streams output in real-time to your terminal
  - Uses smart test runner with dependency analysis
  - Supports all test runner options (browsers, grep, specific files)
- **Use when**:
  - Testing changes that require a clean environment
  - Validating behavior in production-like container
  - Reproducing CI failures locally
  - Testing Dockerfile or dependency changes

**Examples:**

```bash
# Run all tests with caching (fastest for iterative testing)
npm run test:container

# Force rebuild (use after Dockerfile or dependency changes)
npm run test:container -- --no-cache

# Test specific files
npm run test:container -- app/src/plugins/authentication.js

# Run E2E tests with specific browser
npm run test:container -- --browser firefox

# Test multiple browsers
npm run test:container -- --browser chromium,firefox,webkit

# Run all tests (skip smart selection)
npm run test:container -- --all
```

**Technical Details:**

- Tests run inside container using `docker/entrypoint-ci.sh`
- All fixtures and test code baked into image at build time
- Real-time streaming via `PYTHONUNBUFFERED=1` and `stdio: 'inherit'`
- Playwright browsers installed early for optimal layer caching
- Exit code matches test results (0 = success, non-zero = failure)

## Writing Tests

### Always Add Coverage Annotations

```javascript
/**
 * @testCovers fastapi_app/routers/files_save.py
 * @testCovers app/src/plugins/filedata.js
 */
test('should save file', async () => {
  // Test code
});
```

### Suppressing Expected Log Output

When testing code that produces expected warnings or log messages, use `assertLogs` to suppress output and verify the messages:

**Python Tests:**

```python
import logging

def test_expected_warning(self):
    """Test that verifies expected warning is logged."""
    # Suppress and capture expected warnings
    with self.assertLogs('module.name', level='WARNING') as cm:
        result = function_that_warns()

    # Verify expected warning was logged
    self.assertTrue(any('expected message' in msg for msg in cm.output))

    # Continue with assertions
    self.assertEqual(result, expected_value)
```

This pattern:

- Suppresses console output during test runs (keeps test output clean)
- Captures log messages for verification
- Ensures expected warnings/errors are actually being logged
- Prevents test pollution when warnings are intentional

**When to use:**

- Testing error handling that logs warnings
- Testing validation that produces expected errors
- Testing deprecated functionality that warns
- Any scenario where log output is part of the expected behavior

### Ignoring Auto-Generated Files

The smart test runner automatically ignores certain files from change detection:

- `app/src/modules/api-client-v1.js` (auto-generated from OpenAPI schema)

To ignore additional files, configure in the test runner:

```javascript
const runner = new SmartTestRunner({
  ignoreChanges: [
    'app/src/modules/api-client-v1.js',  // Exact file path
    /.*-generated\.js$/                  // Regex pattern
  ]
});
```

This prevents unnecessary test runs when only metadata (like timestamps) changes in auto-generated files.

This enables smart test selection via `npm run test:changed`.

### API Test Template

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

describe('Feature Name', () => {
  let session;

  test('Setup: login', async () => {
    session = await login('reviewer', 'reviewer', BASE_URL);
  });

  test('should do something', async () => {
    const result = await authenticatedApiCall(
      session.sessionId,
      '/api/endpoint',
      'POST',
      { data: 'value' },
      BASE_URL
    );
    assert.strictEqual(result.status, 'success');
  });

  test('Cleanup: release locks', async () => {
    // Clean up resources
  });
});
```

### E2E Test Template

```javascript
/** @import { namedElementsTree } from '../../app/src/ui.js' */
import { test, expect } from '../fixtures/debug-on-failure.js';

test('should do something', async ({ page }) => {
  await page.goto('http://localhost:8000');

  // Use window.ui for interactions
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.someButton.click();
  });

  // Use testLog() for state verification (preferred over DOM queries)
  const result = await page.evaluate(() => window.someGlobalState);
  expect(result).toBeTruthy();
});
```

## Key Principles

1. **Use `@testCovers` annotations** - Enables smart test selection
2. **Clean up after tests** - Release locks, delete test files
3. **API tests run locally** - Fast iteration with `backend-test-runner.js`
4. **E2E tests use local server by default** - Isolation and speed
5. **ALWAYS use helper functions** - Never reimplement auth or API utilities

## Common Patterns

### Authentication in API Tests

```javascript
import { login, authenticatedApiCall, createAdminSession } from '../helpers/test-auth.js';

// Regular user login
const session = await login('reviewer', 'reviewer', BASE_URL);

// Admin session
const adminSession = await createAdminSession(BASE_URL);

// Authenticated API call
const result = await authenticatedApiCall(
  session.sessionId,
  '/api/endpoint',
  'POST',
  data,
  BASE_URL
);
```

### UI Navigation in E2E Tests

```javascript
await page.evaluate(() => {
  /** @type {namedElementsTree} */
  const ui = /** @type {any} */(window).ui;
  ui.loginDialog.username.value = 'testuser';
  ui.loginDialog.submit.click();
});
```

### Test Logging for State Verification

```javascript
import { setupTestConsoleCapture, waitForTestMessage } from './helpers/test-logging.js';

const consoleLogs = setupTestConsoleCapture(page);
// ... perform action ...
const log = await waitForTestMessage(consoleLogs, 'FILE_SAVED');
expect(log.value.file_id).toBeTruthy();
```

### Checking Disabled State for Shoelace Components

Playwright's `toBeDisabled()` and `toBeEnabled()` check the accessibility tree state, which doesn't always align with Shoelace web component's `disabled` attribute. Use attribute checks instead:

```javascript
// ❌ WRONG - May fail for Shoelace components
await expect(button).toBeDisabled();
await expect(button).toBeEnabled();

// ✅ CORRECT - Check disabled attribute directly
await expect(button).toHaveAttribute('disabled', '');  // Disabled
await expect(button).not.toHaveAttribute('disabled'); // Enabled
```

This applies to all Shoelace components (`<sl-button>`, `<sl-input>`, etc.) that use the `disabled` attribute.

## Critical: Always Use Helper Functions

**Never reimplement authentication, API calls, or common test utilities.** This causes maintenance burden and bugs.

❌ **WRONG** - Reimplementing login:

```javascript
async function loginAsAdmin() {
  const response = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    body: JSON.stringify({
      username: 'admin',
      password: 'admin'  // Wrong! Should be passwd_hash with hashing
    })
  });
}
```

✅ **CORRECT** - Use existing helper:

```javascript
import { createAdminSession } from '../helpers/test-auth.js';

async function loginAsAdmin() {
  const { sessionId } = await createAdminSession(API_BASE);
  return sessionId;
}
```

### Common Helper Locations

```javascript
// Authentication and API calls
import {
  login,
  createAdminSession,
  hashPassword,
  authenticatedApiCall
} from '../helpers/test-auth.js';

// Test logging and state verification
import {
  setupTestConsoleCapture,
  waitForTestMessage
} from './helpers/test-logging.js';
```

## Troubleshooting

### Missing Dependencies

If tests fail with "test failed" or module import errors, ensure all dependencies are installed:

```bash
npm install
```

This is particularly important for SSE tests which require the `eventsource-client` package.

## Debugging

### API Tests

```bash
# Verbose output
npm run test:api -- --verbose --grep "save"

# Keep server running for manual testing
npm run test:api -- --no-cleanup

# Keep database for inspection
npm run test:api -- --keep-db
```

### E2E Tests

```bash
# Show browser
npm run test:e2e:headed

# Step-through debugging (Playwright inspector)
npm run test:e2e:debug

# Post-mortem debugging (capture artifacts on failure, headless)
npm run test:e2e:debug-failure
npm run test:e2e:debug-failure -- --grep "new version"

# Combine with headed mode to watch test execution
npm run test:e2e -- --debug-on-failure --headed

# Add breakpoints in test code
await page.pause();
```

#### Debug-on-Failure Mode

When using `--debug-on-failure`, tests run in **headless mode** (faster) and capture comprehensive debug information on failure:

**Captured Artifacts:**

- Console messages → `console-messages.json`
- Page errors → `page-errors.json`
- **Network traffic → `network-log.json`** (all HTTP requests/responses with bodies)
- Screenshots (automatically via Playwright)
- Video recording of test execution

**Behavior:**

- Stops on first failure (`--max-failures=1`)
- Runs headless by default (use `--headed` flag to watch execution)
- All artifacts saved to `tests/e2e/test-results/<test-name>/`

**Network Log Format:**

```json
[
  {
    "type": "request",
    "timestamp": "2025-01-15T10:30:00.000Z",
    "method": "GET",
    "url": "http://localhost:8000/api/v1/files",
    "headers": {...},
    "postData": null
  },
  {
    "type": "response",
    "timestamp": "2025-01-15T10:30:00.100Z",
    "method": "GET",
    "url": "http://localhost:8000/api/v1/files",
    "status": 200,
    "statusText": "OK",
    "headers": {...},
    "body": "{\"files\": [...]}"
  }
]
```

**Note**: All E2E tests should import from the debug-on-failure fixture by default:

```javascript
import { test, expect } from '../fixtures/debug-on-failure.js';
```

This has no effect during normal test runs - it only activates when `--debug-on-failure` is used.

## Important Notes

- **API tests run against local server** - No containers needed, faster iteration
- **E2E tests use local server by default** - Containerized mode available but slower
- **Use `--keep-db`** - When debugging to preserve state between runs
- **Clean up locks** - Always release locks in test cleanup
- **Fixtures auto-load** - Defined in `tests/api/fixtures/` and `tests/e2e/fixtures/`
- **Check helpers first** - Look in `tests/*/helpers/` before implementing utilities

## Backend Authentication Requirements

When implementing FastAPI endpoints that require authentication:

```python
from ..lib.dependencies import get_current_user
from fastapi import Depends, HTTPException

def require_admin(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")
    # ... check admin role ...
    return current_user

@router.get("/endpoint")
def endpoint(current_user: dict = Depends(require_admin)):
    # Endpoint implementation
```

**Key Points**:

- Use `Depends(get_current_user)` to inject authentication
- FastAPI automatically handles session extraction from `X-Session-Id` header
- Session header is case-sensitive: `X-Session-Id`

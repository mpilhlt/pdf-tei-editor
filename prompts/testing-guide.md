# Testing Guide (For Claude Code)

This document provides Claude Code with essential testing information. For comprehensive human-facing documentation, see [docs/testing.md](../docs/testing.md).

## Test Structure

```
tests/
├── unit/{js,fastapi,flask}/  # Unit tests
├── api/v1/                    # API integration tests (*.test.js)
├── e2e/tests/                 # E2E Playwright tests (*.spec.js)
├── backend-test-runner.js     # API test runner
├── e2e-runner.js             # E2E test runner
└── smart-test-runner.js      # Intelligent test selection
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

# E2E tests (Playwright with containers)
npm run test:e2e              # All E2E tests
npm run test:e2e:headed       # Show browser
npm run test:e2e:debug        # Step-through debugging
```

## Test Types

### Unit Tests

- **Location**: `tests/unit/{js,fastapi,flask}/`
- **Purpose**: Test isolated functions/classes
- **Run**: `npm run test:unit`

### API Integration Tests

- **Location**: `tests/api/v1/`
- **Naming**: `*.test.js`
- **Purpose**: Test backend endpoints without browser
- **Run**: `npm run test:api`
- **Features**: Local server, auto-cleanup, fixtures from `tests/api/fixtures/`

### E2E Tests

- **Location**: `tests/e2e/tests/`
- **Naming**: `*.spec.js`
- **Purpose**: Test full workflows in browser
- **Run**: `npm run test:e2e`
- **Features**: Playwright, containerized, `window.ui` navigation, `testLog()` for state verification

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
import { test, expect } from '@playwright/test';

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
4. **E2E tests use containers** - Isolation via `e2e-runner.js`
5. **Use helper functions** - Check `tests/*/helpers/` for existing utilities

## Test Runners

### backend-test-runner.js (API Tests)

```bash
# Local server (fastest, auto-starts/stops)
npm run test:api

# Options
--grep <pattern>      # Filter tests
--keep-db            # Preserve database
--verbose            # Detailed output
--no-cleanup         # Keep server running
```

Features:

- Auto-starts local FastAPI server
- Auto-wipes database (use `--keep-db` to preserve)
- Loads fixtures from `tests/api/fixtures/`
- Runs Node.js test runner on `tests/api/v1/*.test.js`

### e2e-runner.js (E2E Tests)

```bash
# Local server (fastest)
npm run test:e2e

# Debugging
npm run test:e2e:headed    # Show browser
npm run test:e2e:debug     # Playwright debugger

# Options
--grep <pattern>      # Filter tests
--browser <name>      # chromium|firefox|webkit
--headed             # Show browser UI
--debug              # Step-through debugging
```

Features:

- Runs Playwright tests in `tests/e2e/tests/*.spec.js`
- Uses local server by default
- Containerized mode available with `--container`

## Common Patterns

### Authentication in API Tests

```javascript
import { login, authenticatedApiCall } from '../helpers/test-auth.js';

const session = await login('reviewer', 'reviewer', BASE_URL);
const result = await authenticatedApiCall(session.sessionId, '/api/endpoint', 'POST', data, BASE_URL);
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

## Debugging

### API Tests

```bash
# Verbose output
npm run test:api -- --verbose --grep "save"

# Keep server running for manual testing
npm run test:api -- --no-cleanup

# Manual API testing
curl -X POST http://localhost:8000/api/files/save \
  -H "Content-Type: application/json" \
  -d '{"file_id":"test","xml_string":"<TEI/>"}'
```

### E2E Tests

```bash
# Show browser
npm run test:e2e:headed

# Step-through debugging
npm run test:e2e:debug

# Add breakpoints in test code
await page.pause();
```

## Important Notes

- **API tests run against local server** - No containers needed, faster iteration
- **E2E tests can run local or containerized** - Local is default and faster
- **Use `--keep-db`** - When debugging to preserve state between runs
- **Clean up locks** - Always release locks in test cleanup
- **Fixtures auto-load** - Defined in `tests/api/fixtures/` and `tests/e2e/fixtures/`

## See Also

- [Full Testing Documentation](../docs/testing.md) - Comprehensive guide for humans
- [package.json](../package.json) - All test commands
- `tests/lib/` - Test infrastructure utilities
- `tests/*/helpers/` - Shared test helper functions

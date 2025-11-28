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

### E2E Tests

- **Location**: `tests/e2e/tests/`
- **Naming**: `*.spec.js`
- **Purpose**: Test full workflows in browser
- **Run**: `npm run test:e2e`
- **Features**: Playwright, `window.ui` navigation, `testLog()` for state verification

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

# Step-through debugging
npm run test:e2e:debug

# Add breakpoints in test code
await page.pause();
```

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

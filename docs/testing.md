# Testing Guide

This document provides comprehensive information about the testing infrastructure and best practices for the PDF-TEI-Editor project.

## Table of Contents

1. [Testing Architecture Overview](#testing-architecture-overview)
2. [Smart Test Runner](#smart-test-runner)
3. [End-to-End Testing](#end-to-end-testing)
4. [Unit Testing](#unit-testing)
5. [UI Testing Best Practices](#ui-testing-best-practices)
6. [Writing Tests](#writing-tests)
7. [Continuous Integration](#continuous-integration)

## Testing Architecture Overview

The project uses a multi-tiered testing approach:

- **Unit Tests**: JavaScript/Node.js tests using the built-in Node.js test runner
- **Integration Tests**: Python tests for backend functionality
- **End-to-End Tests**: Playwright tests running against containerized application instances
- **Smart Test Selection**: Dependency-aware test execution based on file changes

### Test Commands

```bash
# Run all tests (JS, Python, E2E)
npm test

# Alias for npm test
npm run test:all

# Run only tests for changed files
npm run test:changed

# Run all tests with TAP output
npm run test:tap

# Run all JavaScript unit tests
npm run test:js

# Run all Python integration tests
npm run test:py

# Run end-to-end tests in containerized environment
npm run test:e2e                    # Playwright browser tests (default)
npm run test:e2e:firefox            # Test with Firefox browser
npm run test:e2e:webkit             # Test with WebKit browser
npm run test:e2e:headed             # Show browser UI for debugging
npm run test:e2e:debug              # Debug mode with inspector
npm run test:e2e:headed-debug       # Headed mode with Playwright step-through debugging
npm run test:e2e:backend            # Backend integration tests only

# Run smart test selection (used by pre-push hooks)
node tests/smart-test-runner.js --changed-files <file1,file2>
```

## Smart Test Runner

The smart test runner automatically selects which tests to run based on file dependencies, dramatically reducing test execution time during development.

### How It Works

1. **Dependency Analysis**: Scans test files for `@testCovers` annotations
2. **Change Detection**: Compares changed files against test dependencies
3. **Pattern Matching**: Supports glob patterns and wildcard matching
4. **Parallel Execution**: Runs different test types concurrently

### Test Coverage Annotations

Use `@testCovers` comments to specify which files a test covers:

```javascript
/**
 * @testCovers app/src/plugins/authentication.js
 * @testCovers server/api/auth.py
 */
test('authentication workflow', async ({ page }) => {
  // Test authentication functionality
});

/**
 * @testCovers app/src/*
 */
test('frontend smoke test', async ({ page }) => {
  // Test covers all frontend files
});
```

#### Pattern Matching

- **Exact matches**: `app/src/ui.js`
- **Wildcards**: `app/src/*` (all files in directory)
- **Glob patterns**: `**/*.js` (all JavaScript files recursively)
- **Multiple dependencies**: Separate with commas or use multiple annotations

### Environment Variable Annotations

Use `@env` comments to specify environment variables required by E2E tests:

```javascript
/**
 * Extraction workflow test requiring external services
 * @testCovers app/src/plugins/extraction.js
 * @testCovers server/extractors/grobid.py
 * @env GROBID_SERVER_URL
 * @env GEMINI_API_KEY
 */
test('should complete extraction workflow', async ({ page }) => {
  // Test extraction functionality requiring external APIs
  // Environment variables are automatically passed to test container
});
```

**Key Features:**

- **Automatic Variable Passing**: Environment variables are read from the host environment and injected into test containers
- **Command Line Override**: Use `--env VARIABLE_NAME` flags to specify variables manually
- **Cross-Platform Support**: Works with both Docker and Podman containers
- **Missing Variable Handling**: Missing environment variables are logged as warnings but don't fail test setup
- **Integration with Test Selection**: Environment requirements are considered during smart test selection

### Usage Examples

```bash
# Run all tests
node tests/smart-test-runner.js --all 

# Test specific files
node tests/smart-test-runner.js --changed-files app/src/ui.js,server/api/auth.py

# Test from git changes 
node tests/smart-test-runner.js 
# same as:
node tests/smart-test-runner.js --changed-files $(git diff --name-only HEAD~1)

# Dry run (show which tests would run)
node tests/smart-test-runner.js --changed-files app/src/ui.js --dry-run
```

## End-to-End Testing

E2E tests use a unified cross-platform Node.js runner (`tests/e2e-runner.js`) that supports both Playwright browser tests and backend integration tests against containerized application instances.

### Architecture

- **Unified Runner**: Single Node.js tool handles both Playwright and backend tests 
- **Cross-platform Support**: Works on Windows, macOS, and Linux with Docker or Podman
- **Dual Test Modes**: Playwright browser tests (`--playwright` flag) and backend integration tests
- **Containerized Testing**: Tests run against Docker containers for complete isolation
- **Multi-stage Docker Builds**: Optimized for fast rebuilds with layer caching
- **Environment Configuration**: Flexible host/port configuration via environment variables
- **Automatic Cleanup**: Containers are cleaned up, images preserved for caching

### Container Strategy

The testing infrastructure uses optimized Docker builds:

```dockerfile
# Multi-stage build for optimal caching
FROM python:3.13-slim AS base        # Base system (rarely changes)
FROM base AS deps                    # Dependencies (changes when package files change)
FROM deps AS app                     # Application code (rebuilds when source changes)
FROM app AS test                     # Test-optimized variant
```

### Running E2E Tests

```bash
# Playwright Browser Tests
npm run test:e2e                    # All browsers (default: chromium)
npm run test:e2e:firefox            # Firefox browser
npm run test:e2e:webkit             # WebKit/Safari browser
npm run test:e2e:headed             # Show browser UI
npm run test:e2e:debug              # Debug mode with inspector
npm run test:e2e:headed-debug       # Headed mode with Playwright step-through debugging

# Backend Integration Tests
npm run test:e2e:backend            # All backend tests

# Advanced Options (direct runner usage)
node tests/e2e-runner.js --playwright --browser firefox --headed
node tests/e2e-runner.js --playwright --grep "test login dialog"
E2E_PORT=8001 node tests/e2e-runner.js --playwright --debug
node tests/e2e-runner.js --backend --grep "test login api"

# Environment Variable Configuration
npm run test:e2e -- --env GROBID_SERVER_URL --env GEMINI_API_KEY
npm run test:e2e -- --grep "extraction" --env GROBID_SERVER_URL
node tests/e2e-runner.js --playwright --env GROBID_SERVER_URL --env GEMINI_API_KEY
```

### Test Environment

- **Application URL**: `http://localhost:8000` (containerized, configurable via `E2E_PORT`)
- **Test Credentials**: `testuser` / `testpass` (auto-created in test container)
- **Browsers**: Chromium (default), Firefox, WebKit
- **Modes**: Headless (default) or headed for debugging
- **Environment Variables**:
  - `E2E_HOST`: Host to bind container (default: localhost)
  - `E2E_PORT`: Port to expose container on host (default: 8000)
  - `E2E_CONTAINER_PORT`: Port inside container (default: 8000)
- **Test-Specific Environment Variables**: Tests can specify required environment variables using `@env` annotations or `--env` command line flags. These are automatically passed from the host environment to the test container, enabling tests that require external services like GROBID servers or AI APIs.

### Backend Integration Tests

Backend integration tests validate server API endpoints and backend functionality without browser interaction. These tests assume the containerized backend is running and make HTTP requests directly to the API.

#### Writing Backend Integration Tests

Located in `tests/e2e/`, backend tests use standard Node.js testing with `@testCovers` annotations:

```javascript
/**
 * @testCovers server/api/extract.py
 * @testCovers bin/extractors/llamore.py
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

// Use environment variables set by e2e-runner.js
const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

describe('API Tests', () => {
  test('should return extractor list', async () => {
    const response = await fetch(`${API_BASE}/extract/list`);
    assert.strictEqual(response.status, 200);

    const extractors = await response.json();
    assert(Array.isArray(extractors));
  });
});
```

#### Backend Test Features

- **No server management**: Tests assume the backend container is already running
- **Environment configuration**: Use `E2E_HOST`/`E2E_PORT` for flexible deployment
- **Direct API testing**: Make HTTP requests directly to backend endpoints
- **Dependency tracking**: Use `@testCovers` annotations for smart test selection

## Unit Testing

Unit tests use Node.js built-in test runner for JavaScript and pytest for Python.

### JavaScript Unit Tests

Located in `tests/` directory, using Node.js test runner:

```javascript
import { test } from 'node:test';
import assert from 'node:assert';

test('plugin manager registration', () => {
  const manager = new PluginManager();
  const plugin = { name: 'test-plugin' };

  manager.register(plugin);
  assert.strictEqual(manager.plugins.length, 1);
});
```

### Python Integration Tests

Located in `tests/` directory:

```python
import pytest
from server.lib.file_operations import process_file

def test_file_processing():
    result = process_file("test.pdf")
    assert result["status"] == "success"
```

## UI Testing Best Practices

### Using the UI Navigation System

The application exposes a typed UI navigation system via `window.ui` that provides efficient access to DOM elements:

#### JSDoc Type Casting for E2E Tests

To get full TypeScript autocompletion and eliminate null checks in E2E tests, use JSDoc type casting:

```javascript
// 1. Import the UI type at the top of your E2E test file
/** @import { namedElementsTree } from '../../app/src/ui.js' */

// 2. Use JSDoc type casting inside page.evaluate()
test('should interact with UI elements', async ({ page }) => {
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;

    // Now you get full autocompletion and type safety
    ui.loginDialog.username.value = 'testuser';
    ui.loginDialog.password.value = 'testpass';
    ui.loginDialog.submit.click();

    // No null checks needed - the typed structure guarantees existence
    return ui.loginDialog.open; // TypeScript knows this exists
  });
});
```

#### Benefits of JSDoc Type Casting

- **Full autocompletion**: IDE knows the entire UI structure
- **Type safety**: Catch errors at development time
- **No null checks**: Typed structure guarantees element existence
- **Clean syntax**: No `@ts-ignore` comments cluttering the code
- **Maintainable**: UI structure changes are caught by TypeScript

```javascript
// Access UI elements through the navigation system
test('should open login dialog', async ({ page }) => {
  // Use the UI navigation system with type casting (preferred)
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.toolbar.loginButton.click();
    return ui.loginDialog.show();
  });

  // Verify dialog is open
  const isOpen = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    return ui.loginDialog.open;
  });
  expect(isOpen).toBe(true);
});
```

### Test Logging for State Verification

The application includes a specialized test logging system that provides fast, reliable state verification for E2E tests:

#### How It Works

When `application.mode` is set to `"testing"` (automatically configured in E2E test containers), plugins can log structured messages to the console using `testLog()`:

```javascript
// In plugin code
import { testLog } from '../app.js';

testLog('USER_AUTHENTICATED', { username: 'testuser', fullname: 'Test User' });
testLog('PDF_LOADED', { filename: 'document.pdf', pages: 10 });
testLog('VALIDATION_COMPLETED', { errors: 2, warnings: 5 });
```

#### Capturing Test Logs in E2E Tests

```javascript
test('should complete application startup', async ({ page }) => {
  // Set up console capture for test messages
  /** @type {string[]} */
  const testMessages = [];
  page.on('console', msg => {
    if (msg.text().startsWith('TEST:')) {
      testMessages.push(msg.text());
    }
  });

  // Perform test actions...
  await page.goto('http://localhost:8000');

  // Login using window.ui (preferred for UI interactions)
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.loginDialog.username.value = 'testuser';
    ui.loginDialog.password.value = 'testpass';
    ui.loginDialog.submit.click();
  });

  // Verify state transitions occurred (fast and reliable)
  expect(testMessages.find(msg => msg.includes('USER_AUTHENTICATED'))).toBeTruthy();

  // Parse and verify data structures
  const authMsg = testMessages.find(msg => msg.includes('USER_AUTHENTICATED'));
  if (authMsg) {
    const userData = JSON.parse(authMsg.match(/TEST: USER_AUTHENTICATED (.+)/)[1]);
    expect(userData.username).toBe('testuser');
  }
});
```

#### Benefits of Test Logging

- **Performance**: 10-100x faster than DOM queries for state verification
- **Reliability**: Not affected by UI timing issues or CSS changes
- **Debugging**: Clear insight into application flow and state transitions
- **Maintainability**: Tests don't break when UI styling changes

#### When to Use Each Approach

**Use testLog for** (Preferred):

- State transitions and business logic verification
- API call results and data flow
- Plugin lifecycle events
- Performance measurements

**Use window.ui for** (Required for UI):

- Form interactions and button clicks
- UI state verification (dialog open/closed)
- Navigation and user workflows

**Use CSS selectors only for** (Fallback):

- Elements not in the named UI system
- Dynamic content testing
- Styling and attribute verification

```javascript
// Fallback to selectors when needed
const dynamicElements = await page.$('.dynamic-content');
const errorMessage = await page.textContent('[data-testid="error-message"]');
```

### Error Handling in E2E Tests

Filter expected errors and warnings:

```javascript
test('application loading', async ({ page }) => {
  const consoleErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const errorText = msg.text();

      // Filter out expected/non-critical errors
      if (!errorText.includes('404') &&
          !errorText.includes('401') &&
          !errorText.includes('offsetParent is not set')) {
        consoleErrors.push(errorText);
      }
    }
  });

  await page.goto('http://localhost:8000');

  // Assert no critical errors
  expect(consoleErrors).toEqual([]);
});
```

## Writing Tests

### Test File Organization

```
tests/
├── js/                          # JavaScript unit tests
│   ├── application.test.js      # Core application tests
│   ├── plugin-manager.test.js   # Plugin system tests
│   ├── smart-test-runner.test.js # Smart test runner tests
│   └── sync-algorithm.test.js   # Synchronization algorithm tests
├── py/                          # Python integration tests
│   └── test_*.py               # Python test files
├── e2e/                         # End-to-end tests
│   ├── app-loading.spec.js      # Playwright: Application loading tests
│   ├── auth-workflow.spec.js    # Playwright: Authentication workflow tests
│   ├── extractor-api.test.js    # Backend: API endpoint tests
│   └── test-extractors.js       # Backend: Extractor functionality tests
└── smart-test-runner.js         # Smart test runner (moved from app/src/modules)
```

### Test Naming Conventions

- **JavaScript unit tests**: `tests/js/*.test.js`
- **Python integration tests**: `tests/py/test_*.py`
- **Playwright E2E tests**: `tests/e2e/*.spec.js`
- **Backend integration tests**: `tests/e2e/*.test.js` (uses Node.js test runner)
- **Test suites**: Organized in directories by type (js, py, e2e)

### Test Coverage Guidelines

1. **Use `@testCovers` annotations** for all tests
2. **Cover critical user workflows** in E2E tests
3. **Test plugin interactions** in unit tests
4. **Verify error handling** and edge cases
5. **Use UI navigation system** for DOM access

### Example E2E Test

```javascript
/**
 * @testCovers app/src/plugins/authentication.js
 * @testCovers server/api/auth.py
 */

/** @import { namedElementsTree } from '../../app/src/ui.js' */

test('complete authentication workflow', async ({ page }) => {
  // Navigate to application
  await page.goto('http://localhost:8000');

  // Open login dialog using UI navigation
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.toolbar.loginButton.click();
  });

  // Fill login form
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.loginDialog.username.value = 'testuser';
    ui.loginDialog.password.value = 'testpass';
    ui.loginDialog.submitBtn.click();
  });

  // Verify successful login
  await page.waitForSelector('[data-testid="user-menu"]');

  const isLoggedIn = await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    return ui.toolbar.userMenu.style.display !== 'none';
  });

  expect(isLoggedIn).toBe(true);
});
```

## Continuous Integration

### Pre-push Hooks

The smart test runner integrates with Git pre-push hooks:

```bash
# .git/hooks/pre-push (automatically installed)
#!/bin/bash
exec node tests/smart-test-runner.js
```

### CI Pipeline

1. **Smart Test Selection**: Run only tests affected by changes
2. **Parallel Execution**: Unit, integration, and E2E tests run concurrently
3. **Docker Layer Caching**: Fast E2E test builds in CI
4. **Test Reports**: Artifacts preserved for debugging

### Performance Optimizations

- **Layer Caching**: Docker images cached between CI runs
- **Dependency Analysis**: Tests run only when dependencies change
- **Parallel Execution**: Multiple test types run simultaneously
- **Selective Testing**: Skip unaffected test suites

## Troubleshooting

### Common Issues

**Docker Build Failures**:

```bash
# Clean and rebuild
docker system prune -f
npm run test:e2e
```

**Port Conflicts**:

```bash
# The test script automatically cleans up port conflicts
# If manual cleanup is needed:
docker stop $(docker ps -q --filter "publish=8000")
```

**Test Timeouts**:

- Increase timeout in `playwright.config.js`
- Check container startup logs
- Verify application health checks

**UI Element Not Found**:

- Use `window.ui` navigation system instead of selectors
- Check element names in UI type definitions
- Verify element is properly registered with `updateUi()`

### Debug Tips

1. **Use headed mode**: `npm run test:e2e:headed` or `npm run test:e2e -- --headed`
2. **Step-through debugging**: `npm run test:e2e:headed-debug` - enables Playwright's step-through debugger
3. **Enable debug logging**: `npm run test:e2e -- --debug`
4. **Check saved logs**: Container and server logs are saved to `tests/e2e/test-results/` when tests fail
5. **Inspect UI structure**: `console.log(window.ui)` in browser
6. **Use Playwright inspector**: `npx playwright test --debug`

### Configurable Debug Output

E2E tests support configurable debug output to reduce noise during test execution while providing detailed information when needed:

```bash
# Enable verbose debug output for E2E tests
E2E_DEBUG=true npm run test:e2e -- --grep "extraction workflow"

# Normal execution without debug output (default)
npm run test:e2e -- --grep "extraction workflow"

# Debug output with specific test patterns
E2E_DEBUG=true npm run test:e2e:headed -- --grep "test login dialog"

# Backend tests with debug output
E2E_DEBUG=true node tests/e2e-runner.js  --backend --grep "test login api"
```

**Debug Output Features:**

- **Conditional Logging**: Debug messages only appear when `E2E_DEBUG=true` is set
- **Clean Test Results**: Default execution shows minimal output for better readability
- **Detailed Diagnostics**: Debug mode shows document selection status, button states, and application flow
- **Test Helper Integration**: Debug logging available in all test helper modules (login-helper.js, extraction-helper.js)

### Parallel vs Sequential Test Execution

Control how tests execute relative to each other to optimize performance or avoid resource conflicts:

#### Sequential Execution (Use for Resource-Heavy Tests)

```bash
# Force all tests to run sequentially (1 worker)
npm run test:e2e -- --workers=1

# Force sequential execution with debug output
E2E_DEBUG=true npm run test:e2e -- --workers=1 --grep "extraction"

# Run specific test suites sequentially
npm run test:e2e -- --workers=1 --grep "Extraction Workflow"
```

#### Parallel Execution (Default, Better Performance)

```bash
# Default parallel execution (uses Playwright's default worker count)
npm run test:e2e

# Explicit parallel execution with custom worker count
npm run test:e2e -- --workers=4

# Parallel execution with specific browsers
npm run test:e2e:firefox -- --workers=2
```

#### Test Suite Level Configuration

Individual test suites can be configured for sequential execution using `test.describe.serial()`:

```javascript
// Sequential execution within this test suite
test.describe.serial('Extraction Workflow', () => {
  test('should complete PDF extraction workflow', async ({ page }) => {
    // This test runs first
  });

  test('should create new version from existing document', async ({ page }) => {
    // This test runs second, after the first completes
  });

  test('should save revision for existing document', async ({ page }) => {
    // This test runs third, after the second completes
  });
});

// Parallel execution (default behavior)
test.describe('Login Tests', () => {
  test('should login with valid credentials', async ({ page }) => {
    // These tests can run in parallel with other test suites
  });

  test('should reject invalid credentials', async ({ page }) => {
    // This runs in parallel with the test above
  });
});
```

**When to Use Sequential Execution:**

- **Resource conflicts**: Tests that compete for the same external services (GROBID, AI APIs)
- **State dependencies**: Tests that depend on previous test state or shared resources
- **Debugging**: Sequential execution makes debugging easier by reducing complexity
- **Heavy extraction workflows**: Tests that use significant CPU/memory/network resources

**When to Use Parallel Execution:**

- **Independent tests**: Tests that don't share resources or state
- **Fast unit-style tests**: Tests that complete quickly and don't need external services
- **Improved performance**: Parallel execution significantly reduces total test time
- **CI/CD pipelines**: Parallel execution optimizes build times in automated environments

### Debugging Modes Explained

**For keeping browser windows open on failures:**

- Use `npm run test:e2e:headed` - shows browser UI, windows close after tests complete
- Container stops after tests, so browser windows will close regardless of debug flags

**For interactive step-through debugging:**

- Use `npm run test:e2e:headed-debug` - activates Playwright's debugger with pause/step controls
- Use `await page.pause()` in test code to add breakpoints
- Use Playwright inspector: `npx playwright test --debug --headed`

**For log analysis:**

- Check `tests/e2e/test-results/container-logs-*.txt` for container startup logs
- Check `tests/e2e/test-results/server-logs-*.txt` for Flask application logs with DEBUG/INFO/ERROR messages


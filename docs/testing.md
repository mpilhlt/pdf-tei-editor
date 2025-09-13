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
# Run all tests (unit + integration)
npm test

# Run JavaScript unit tests only
npm run test:js

# Run Python integration tests only
npm run test:py

# Run end-to-end tests in containerized environment
npm run test:e2e                    # Playwright browser tests (default)
npm run test:e2e:firefox            # Test with Firefox browser
npm run test:e2e:webkit             # Test with WebKit browser
npm run test:e2e:headed             # Show browser UI for debugging
npm run test:e2e:debug              # Debug mode with inspector
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

### Pattern Matching

- **Exact matches**: `app/src/ui.js`
- **Wildcards**: `app/src/*` (all files in directory)
- **Glob patterns**: `**/*.js` (all JavaScript files recursively)
- **Multiple dependencies**: Separate with commas or use multiple annotations

### Usage Examples

```bash
# Test specific files
node tests/smart-test-runner.js --changed-files app/src/ui.js,server/api/auth.py

# Test from git changes
node tests/smart-test-runner.js --changed-files $(git diff --name-only HEAD~1)

# Dry run (show which tests would run)
node tests/smart-test-runner.js --changed-files app/src/ui.js --dry-run
```

## End-to-End Testing

E2E tests use a unified cross-platform Node.js runner (`tests/e2e-runner.js`) that supports both Playwright browser tests and backend integration tests against containerized application instances.

### Architecture

- **Unified Runner**: Single Node.js tool handles both Playwright and backend tests (replaces Linux-only bash script)
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

### Benefits:
- **Fast Builds**: Only application layer rebuilds when source code changes
- **Clean Isolation**: Each test run gets a fresh container
- **Optimal Caching**: Expensive dependency layers are reused across runs

### Running E2E Tests

```bash
# Playwright Browser Tests
npm run test:e2e                    # All browsers (default: chromium)
npm run test:e2e:firefox            # Firefox browser
npm run test:e2e:webkit             # WebKit/Safari browser
npm run test:e2e:headed             # Show browser UI
npm run test:e2e:debug              # Debug mode with inspector

# Backend Integration Tests
npm run test:e2e:backend            # All backend tests
node tests/e2e-runner.js tests/e2e/extractor-api.test.js  # Individual test

# Advanced Options (direct runner usage)
node tests/e2e-runner.js --playwright --browser firefox --headed
node tests/e2e-runner.js --playwright --grep "login"
E2E_PORT=8001 node tests/e2e-runner.js --playwright --debug
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

```javascript
// Access UI elements through the navigation system
test('should open login dialog', async ({ page }) => {
  // Use the UI navigation system (preferred)
  await page.evaluate(() => {
    window.ui.toolbar.loginButton.click();
    return window.ui.loginDialog.show();
  });

  // Verify dialog is open
  const isOpen = await page.evaluate(() => window.ui.loginDialog.open);
  expect(isOpen).toBe(true);
});
```

### UI Navigation Hierarchy

The UI system provides type-safe access to named elements:

```javascript
// Examples of available UI elements
window.ui.toolbar.pdf              // PDF selection dropdown
window.ui.toolbar.loginButton      // Login button
window.ui.dialog.message          // Dialog message element
window.ui.dialog.closeBtn          // Dialog close button
window.ui.pdfViewer.canvas         // PDF viewer canvas
window.ui.xmlEditor.editor         // XML editor instance
window.ui.floatingPanel.status     // Status display
```

### When to Use Selectors

Use CSS selectors when:
- Elements are not part of the named UI system
- Testing dynamic content
- Verifying specific styling or attributes

```javascript
// Fallback to selectors when needed
const dynamicElements = await page.$$('.dynamic-content');
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
test('complete authentication workflow', async ({ page }) => {
  // Navigate to application
  await page.goto('http://localhost:8000');

  // Open login dialog using UI navigation
  await page.evaluate(() => {
    window.ui.toolbar.loginButton.click();
  });

  // Fill login form
  await page.evaluate(() => {
    window.ui.loginDialog.username.value = 'testuser';
    window.ui.loginDialog.password.value = 'testpass';
    window.ui.loginDialog.submitBtn.click();
  });

  // Verify successful login
  await page.waitForSelector('[data-testid="user-menu"]');

  const isLoggedIn = await page.evaluate(() => {
    return window.ui.toolbar.userMenu.style.display !== 'none';
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

1. **Use headed mode**: `npm run test:e2e -- --headed`
2. **Enable debug logging**: `npm run test:e2e -- --debug`
3. **Check container logs**: `docker logs <container-id>`
4. **Inspect UI structure**: `console.log(window.ui)` in browser
5. **Use Playwright inspector**: `npx playwright test --debug`

## Best Practices Summary

1. ✅ **Use `@testCovers` annotations** for smart test selection
2. ✅ **Prefer `window.ui` navigation** over CSS selectors
3. ✅ **Write descriptive test names** and organize in logical suites
4. ✅ **Filter expected errors** in E2E tests
5. ✅ **Test critical user workflows** end-to-end
6. ✅ **Use containerized testing** for isolation
7. ✅ **Leverage Docker layer caching** for fast builds
8. ✅ **Run smart test selection** during development

This testing infrastructure provides fast, reliable, and comprehensive coverage while minimizing maintenance overhead and maximizing developer productivity.
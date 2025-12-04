# Fix E2E tests

The End-to-End (E2E) tests for our application are currently failing due to recent changes in the codebase. This document outlines the steps needed to identify and fix the issues causing the failures.

## Test Results Summary (2025-11-29)

**Initial Status:** 7 failed, 6 passed (out of 13 tests)
**Current Status:** 2 failed, 11 passed (out of 13 tests) ✅

### Failing Tests

All 7 failing tests are related to **404 (Not Found) errors** occurring during the tests. The error message is:

```
Failed to load resource: the server responded with a status of 404 (Not Found)
```

This error is not in the allowed error patterns list, causing tests to fail.

#### List of Failing Tests

1. **[chromium] › tests/e2e/tests/document-actions.spec.js:44:3**
   - Test: "Document Actions › should create new version from existing document"

2. **[chromium] › tests/e2e/tests/document-actions.spec.js:132:3**
   - Test: "Document Actions › should save revision for existing document"

3. **[chromium] › tests/e2e/tests/extraction-workflow.spec.js:197:3**
   - Test: "Extraction Workflow › should complete PDF extraction workflow"

4. **[chromium] › tests/e2e/tests/role-permissions-ui.spec.js:33:3**
   - Test: "Role-based UI Permissions › User role: Can login and access application"

5. **[chromium] › tests/e2e/tests/role-permissions-ui.spec.js:76:3**
   - Test: "Role-based UI Permissions › Annotator role: Can login and access application"

6. **[chromium] › tests/e2e/tests/role-permissions-ui.spec.js:125:3**
   - Test: "Role-based UI Permissions › Reviewer role: Can login and access application"

7. **[chromium] › tests/e2e/tests/role-permissions-ui.spec.js:168:3**
   - Test: "Role-based UI Permissions › Admin role: Can login and access application"

### Root Cause Analysis

The issue appears to be that the application is making requests that result in 404 responses, which are not currently allowed in the test's error validation logic (in [tests/helpers/test-logging.js:187](tests/helpers/test-logging.js#L187)).

Current allowed error patterns:

- `Failed to load resource.*401.*UNAUTHORIZED`
- `Failed to load resource.*400.*BAD REQUEST`
- `Failed to load autocomplete data.*No schema location found`
- `api/validate/autocomplete-data.*400.*BAD REQUEST`
- `offsetParent is not set.*cannot scroll`
- `Failed to load resource.*403.*FORBIDDEN`
- `Failed to load resource.*423.*LOCKED`

## Issues Fixed

### 1. E2E Test Runner Syntax Errors

**Files Changed:**

- `tests/e2e-runner.js`

**Issues:**

- Duplicate logger imports (4x on lines 32-35)
- Template literal using single quotes instead of backticks (lines 207, 231)
- Incorrect import path for test-logger (using 'api/helpers/test-logger.js' instead of './api/helpers/test-logger.js')

**Fix:** Removed duplicate imports, fixed template literals, corrected import path

### 2. Missing Fixture Files

**Files Added:**

- `tests/e2e/fixtures/standard/config/collections.json`
- `tests/e2e/fixtures/minimal/config/collections.json`
- `tests/e2e/fixtures/standard/config/groups.json`
- `tests/e2e/fixtures/minimal/config/groups.json`

**Issue:** The application was throwing errors about missing `collections.json` file during test execution

**Fix:** Copied default collections.json and groups.json from `config/` to test fixtures

### 3. Shoelace Icon 404 Errors ✅ FIXED

**Files Changed:**

- `app/src/plugins/rbac-manager.js` - Added icon hint comments for build system
- `tests/e2e-runner.js` - Added `ensureApplicationBuilt()` to verify build before tests
- `tests/e2e/tests/role-permissions-ui.spec.js` - Removed 404 workaround (no longer needed)
- `tests/e2e/tests/document-actions.spec.js` - Removed 404 workaround (no longer needed)

**Issue:** Shoelace icons (`plus`, `trash`, `shield`, `shield-lock`, `people`, `person`, `check`) were returning 404 errors because they weren't being copied to `app/web/assets/icons/` during the build process.

**Root Cause:** The build script (`bin/compile-sl-icons.py`) scans for `<sl-icon name="...">` literals in `.js` and `.html` files under `app/src/` to know which icons to copy. However, icons used in **template files** (`app/src/templates/*.html`) were not being found because:

1. Templates are bundled separately by `bin/bundle-templates.js`
2. The template HTML is not directly scanned - only the JS files that register them
3. The coding standard requires adding `// <sl-icon name="icon-name"></sl-icon>` comments in JS files when icons are used programmatically or in templates

**Fix:** Added icon hint comments in `app/src/plugins/rbac-manager.js` near the template registration, following the pattern documented in `docs/code-assistant/coding-standards.md`:

```javascript
// Icons used in rbac-manager templates (needed for build system to include them)
// <sl-icon name="person"></sl-icon>
// <sl-icon name="people"></sl-icon>
// <sl-icon name="shield"></sl-icon>
// <sl-icon name="shield-lock"></sl-icon>
// <sl-icon name="plus"></sl-icon>
// <sl-icon name="check"></sl-icon>
// <sl-icon name="trash"></sl-icon>
```

**Result:** After rebuilding, all icons are now properly copied (50/52 icons vs 43/45 before), and E2E tests pass without any 404 errors.

**Build Check Added:** Added `ensureApplicationBuilt()` to `tests/e2e-runner.js` to ensure the app is built before running E2E tests, and to rebuild if source files have changed.

## Remaining Failing Tests (2)

### 1. Document Actions › should create new version from existing document

**Error:** `TimeoutError: page.waitForSelector: Timeout 5000ms exceeded` waiting for `sl-dialog[name="newVersionDialog"][open]`

### 2. Document Actions › should save revision for existing document

**Error:** `TimeoutError: page.waitForSelector: Timeout 5000ms exceeded` waiting for `sl-dialog[name="newRevisionChangeDialog"][open]`

**Investigation (2025-12-02):**

Root cause identified: Users cannot see any files after login because of two backend bugs:

**Bug 1: Missing `groups` field in test users** ✅ FIXED
- **Location:** `tests/e2e/fixtures/standard/config/users.json`, `tests/e2e/fixtures/minimal/config/users.json`
- **Problem:** Test users lacked the `groups` field required for collection-based access control
- **Fix:** Added `groups: ["default"]` to all non-admin test users, `groups: ["admin"]` to admin user

**Bug 2: TEI files not assigned to collections** ✅ FIXED
- **Location:** `fastapi_app/lib/file_importer.py`
- **Problem:** The `_import_tei()` method didn't accept or assign collections to TEI files. Only PDF files got `doc_collections`. The files list API filters by collections (line 166 in `files_list.py`), checking if ANY document collection matches user's accessible collections. TEI files with empty `doc_collections: []` failed this check.
- **Fix:**
  - Modified `_import_tei()` to accept `collection` parameter (line 464)
  - Pass collection from `_import_document()` to `_import_tei()` (line 407)
  - Added `doc_collections=[collection] if collection else []` to TEI FileCreate (line 553)

**Test Debug Output:**
```json
{
  "pdfOptionsCount": 0,
  "xmlOptionsCount": 0,
  "pdfValue": "",
  "xmlValue": "",
  "createNewVersionDisabled": true,
  "saveRevisionDisabled": true,
  "stateXml": null,
  "statePdf": null
}
```

**Backend Verification:**
- Files ARE in database with correct collections: `SELECT id, filename, doc_collections FROM files;`
  - PDF: `["default"]` ✓
  - TEI: `["default"]` ✓ (after fix)
- User has correct groups: `testreviewer.groups = ["default"]` ✓
- User can access collections: `get_user_collections()` returns `['_inbox', 'default']` ✓
- API calls succeed: `GET /api/v1/files/list` returns 200 OK ✓

**Remaining Issue:**

Despite backend fixes, files still don't appear in UI after login (0 files in dropdowns). The authentication plugin correctly calls `FiledataPlugin.getInstance().reload({ refresh: true })` after login ([authentication.js:159](app/src/plugins/authentication.js#L159)), and the file-selection plugin should repopulate dropdowns when `fileData` state changes ([file-selection.js:159-170](app/src/plugins/file-selection.js#L159-L170)).

**Next Steps:**
1. Debug why fileData state isn't propagating to UI after authentication reload
2. Check timing: Does reload complete before test checks for files?
3. Verify file-selection plugin's `update()` is being called with new fileData
4. Check if there's a race condition between authentication reload and test execution
5. Consider adding wait for fileData to be populated in test helper

## Debug-on-Failure Feature (2025-12-02) ✅

Implemented a comprehensive debugging feature for E2E test failures:

**Files Changed:**

- [tests/e2e-runner.js](tests/e2e-runner.js) - Added `--debug-on-failure` CLI option, stops on first failure, captures debug artifacts
- [tests/e2e/fixtures/debug-on-failure.js](tests/e2e/fixtures/debug-on-failure.js) - Captures console messages and page errors to JSON files
- [playwright.config.js](playwright.config.js) - Enables screenshot/video capture on failure when debug-on-failure is active
- [tests/e2e/tests/docker-infrastructure.spec.js](tests/e2e/tests/docker-infrastructure.spec.js) - Skip container tests in local mode using `E2E_MODE` env var

**How It Works:**

When `--debug-on-failure` is enabled:

1. Tests stop after first failure (`--max-failures=1`)
2. Debug artifacts are captured automatically:
   - Console messages saved to `console-messages.json`
   - Page errors saved to `page-errors.json`
   - Screenshots captured by Playwright
   - Video recording captured by Playwright
3. All artifacts saved to: `tests/e2e/test-results/<test-name>/`
4. Server and test runner shut down cleanly

**Usage:**

```bash
npm run test:e2e:debug-failure                              # Run all tests, stop on first failure
npm run test:e2e:debug-failure -- --grep "test name"       # Run specific test with debug capture
```

**Debug Artifacts Generated:**

- `console-messages.json` - All browser console output with timestamps and locations
- `page-errors.json` - JavaScript errors with stack traces
- `test-failed-1.png` - Screenshot at time of failure (Playwright)
- `video.webm` - Video recording of entire test (Playwright)

**Note:** For interactive debugging with Inspector, use:

```bash
npm run test:e2e:debug -- --grep "test name"  # Opens Playwright Inspector
```

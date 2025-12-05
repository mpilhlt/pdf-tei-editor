# Re-enable Export Collection Filter Test

## Issue

Test isolation issue in [tests/api/v1/files_export.test.js:47](tests/api/v1/files_export.test.js#L47)

**Symptom:**
- Test "GET /api/v1/export - should filter by collection" passes when run in isolation: `npm run test:api -- --grep "export"`
- Same test fails when run with full test suite: `npm run test:api`
- Error: `AssertionError: Zip should contain files` - the exported zip is empty

## Root Cause

Test state pollution. When all tests run together, something between test startup and this test is removing/deleting the fixture files from the "default" collection.

## Investigation Details

### What We Know

1. **Fixture files are imported into "default" collection** ([tests/lib/fixture-loader.js:121](tests/lib/fixture-loader.js#L121))
   - During test setup, `importFixtureFiles()` imports files from `tests/api/fixtures/standard/files/` into the "default" collection
   - Fixture files: `10.5771__2699-1284-2024-3-149.pdf` and `10.5771__2699-1284-2024-3-149.tei.xml`

2. **Test execution order** (alphabetical by filename):
   - `auth.test.js`
   - `config.test.js`
   - `extraction.test.js`
   - `extraction_rng.test.js`
   - `files_copy.test.js`
   - `files_delete.test.js` ← runs immediately before the failing test
   - `files_export.test.js` ← contains the failing test
   - ... (more tests)

3. **Suspect tests examined:**
   - `files_delete.test.js`: Creates and deletes its own test files, doesn't touch fixture files
   - `files_copy.test.js`: Has comment "Don't delete fixture files - they may be used by other tests" ([tests/api/v1/files_copy.test.js:173](tests/api/v1/files_copy.test.js#L173))
   - `files_garbage_collect.test.js`: Creates its own test files for deletion

4. **The failing test expects:**
   - Export endpoint with `collections=default` filter
   - Non-empty zip file containing files from "default" collection
   - Files organized under `default/` directory when `group_by=collection` (the default)

## Next Steps to Fix

1. **Add debug logging to identify culprit:**
   - Add logging at start of `files_export.test.js` to query database and check if files in "default" collection exist
   - Run full test suite and capture output to see exactly when files disappear

2. **Possible causes to investigate:**
   - Does any test delete files by collection?
   - Does any test modify `doc_collections` JSON array in the database?
   - Are there any tests that use the fixture files and then delete them?
   - Is there a database cleanup operation that runs between tests?

3. **Potential fixes:**
   - Add `before()` hook to `files_export.test.js` to verify fixture files exist, re-import if needed
   - Modify problematic test to not delete fixture files
   - Move export tests to run earlier in the sequence (rename file to run before delete tests)
   - Make export tests create their own test files rather than relying on fixtures

## Files Involved

- [tests/api/v1/files_export.test.js](tests/api/v1/files_export.test.js) - Contains disabled test
- [tests/lib/fixture-loader.js](tests/lib/fixture-loader.js) - Imports fixture files into "default" collection
- [tests/api/fixtures/standard/files/](tests/api/fixtures/standard/files/) - Source fixture files
- [tests/api/fixtures/standard/config/collections.json](tests/api/fixtures/standard/config/collections.json) - Defines "default" collection

## Temporary Workaround

Test is disabled using `test.skip()` to unblock CI pipeline. Must re-enable once root cause is identified and fixed.

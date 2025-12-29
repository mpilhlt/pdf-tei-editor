# UI to edit file metadata

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/131

## Current state

- TEI metadata is read from parsing output, is then stored in the database
- TEI header can be manually changed but this won't update the metadata in the database

## Goal

- Implement a UI to edit TEI metadata. The updated values will be written to the header and updated in the database.
- This will allow to rename a file, change "gold" status, etc.

## Implementation details

- new dialog with all the metadata properties currently parsed from the TEI, plus other properties that are only in the database.
- when submitted updates the xml locally and saves it, and calls an API endpoint to update the database.

## Special case: gold status

- "Gold" status should not be configured here, but in the "Revision Change" dialog. Users with the "reviewer" role should see an additional  button "Save as Gold Version" which, after a confirmation, will make the current version the Gold version (and remove the status from the current "gold")

## Implementation

**Note:** This feature was implemented as part of the document-actions plugin refactoring. See [refactor-document-actions.md](refactor-document-actions.md) for details on the plugin separation.

### Frontend

**File:** `app/src/plugins/document-actions.js`

- Added "Edit Metadata" button to document actions button group
- Created `editFileMetadata()` function that:
  - Opens dialog pre-filled with current metadata (fileref, title, DOI, variant)
  - Updates TEI header elements (title, DOI) when changed
  - Saves XML file with updated header
  - Calls backend API to update database metadata
  - Reloads file data to reflect changes

**Template:** `app/src/templates/edit-metadata-dialog.html`
- Dialog with inputs for fileref, title, DOI, and variant

**Template:** `app/src/templates/document-action-buttons.html`
- Added edit metadata button with pencil-square icon

### Backend

**Router:** `fastapi_app/routers/files_metadata.py`
- `PATCH /api/v1/files/{stable_id}/metadata` endpoint
- Accepts fileref, title, DOI, variant fields
- Validates user access via collection membership
- Updates database via FileRepository

**Repository:** `fastapi_app/lib/file_repository.py`
- Added `update_file_metadata()` method
- Updates specified fields in files table
- Sets local_modified_at and updated_at timestamps

**Registration:** `fastapi_app/main.py`
- Registered files_metadata router in API v1

### Access Control

- Only annotators and reviewers can edit metadata
- Button disabled when:
  - No XML file loaded
  - Editor is read-only
  - User lacks annotator/reviewer role
- Backend validates collection access before allowing updates

### Limitations

- fileref changes affect database only, not actual filename on disk

## Gold Version Feature Implementation

**Note:** Gold status changes are now implemented in the save revision dialog as specified in the requirements.

### Backend Implementation

**Repository Method:** [fastapi_app/lib/file_repository.py:1145-1214](fastapi_app/lib/file_repository.py#L1145-L1214)

- Added `set_gold_standard()` method
- Unsets `is_gold_standard` for all other files with same `doc_id` and variant
- Sets `is_gold_standard = 1` for the specified file
- Updates timestamps for all affected files

**API Endpoint:** [fastapi_app/routers/files_metadata.py:101-159](fastapi_app/routers/files_metadata.py#L101-L159)

- `POST /api/v1/files/{stable_id}/gold-standard`
- Restricted to users with reviewer or admin role
- Validates collection access before allowing update
- Calls `FileRepository.set_gold_standard()`

### Frontend Implementation

**Save Revision Dialog:** [app/src/templates/save-revision-dialog.html:7](app/src/templates/save-revision-dialog.html#L7)

- Added "Save as Gold Version" checkbox
- Only visible to users with reviewer/admin role

**Plugin Implementation:** [app/src/plugins/document-actions.js:434-437](app/src/plugins/document-actions.js#L434-L437)

- Shows/hides checkbox based on user role
- [app/src/plugins/document-actions.js:490-504](app/src/plugins/document-actions.js#L490-L504): Calls API endpoint when checkbox is checked
- Reloads file data to update UI with new gold status
- Provides user feedback via notifications

**API Client:** [app/src/modules/api-client-v1.js:1303-1306](app/src/modules/api-client-v1.js#L1303-L1306)

- Auto-generated `filesGoldStandard(stable_id)` method

### Gold Version Access Control

- Only reviewers and admins can set gold standard
- Backend validates user role before allowing update
- Frontend shows checkbox only to authorized users
- Collection access is validated before update

## Tests

### API Tests

**File:** [tests/api/v1/files_metadata.test.js:248-362](tests/api/v1/files_metadata.test.js#L248-L362)

- Test 7: Create version for gold standard test
- Test 8: Verify initial gold standard state
- Test 9: Set version as gold standard (success case)
- Test 10: Deny access to non-reviewers (403 error)
- Test 11: Handle non-existent file (404 error)

### E2E Tests

**File:** [tests/e2e/tests/document-actions.spec.js:242-409](tests/e2e/tests/document-actions.spec.js#L242-L409)

- Test: Save revision as gold version (reviewer only)
  - Verifies checkbox is visible and unchecked initially
  - Fills form and checks gold checkbox
  - Verifies REVISION_SAVED and GOLD_STANDARD_SET test logs
  - Confirms file is marked as gold by checking `is_gold_standard` property directly from fileData
- Test: Hide gold checkbox for non-reviewers
  - Logs in as annotator
  - Verifies checkbox exists but is hidden (display: none)

**Note:** The gold status verification uses direct property access (`artifact.is_gold_standard`) instead of importing helpers to avoid module resolution issues in Playwright's browser context.

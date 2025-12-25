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

- Gold status changes not implemented (per requirements - should be handled in revision dialog)
- fileref changes affect database only, not actual filename on disk
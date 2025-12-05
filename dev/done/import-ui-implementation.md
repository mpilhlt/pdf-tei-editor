# File Import UI Implementation

## Overview

Implement a file import feature that allows users to upload ZIP archives containing PDF and TEI files in the expected directory structure. The feature mirrors the export functionality and includes:

1. Backend API endpoint (`/api/v1/import`) that accepts ZIP uploads
2. Utility module for ZIP extraction and import logic
3. Frontend UI button in the file selection drawer
4. Integration with existing FileImporter for file processing

## Architecture

### Backend Components

1. **File ZIP Importer** ([fastapi_app/lib/file_zip_importer.py](../../fastapi_app/lib/file_zip_importer.py))
   - Extract ZIP to temporary directory
   - Validate directory structure
   - Use FileImporter for actual import
   - Clean up temporary files

2. **Import Router** ([fastapi_app/routers/files_import.py](../../fastapi_app/routers/files_import.py))
   - POST `/api/v1/import` endpoint
   - Session-based authentication
   - Collection-based access control
   - File upload handling
   - Progress/status response

3. **CLI Integration** ([bin/import_files.py](../../bin/import_files.py))
   - Update to optionally use FileZipImporter
   - Add `--zip` flag for ZIP file imports

### Frontend Components

1. **File Selection Drawer** ([app/src/plugins/file-selection-drawer.js](../../app/src/plugins/file-selection-drawer.js))
   - Add import button to UI
   - File upload dialog
   - Progress indication
   - Success/error feedback

2. **Template Updates** ([app/src/templates/file-selection-drawer.html](../../app/src/templates/file-selection-drawer.html))
   - Add import button element
   - File input element (hidden)

3. **API Client** ([app/src/modules/api-client-v1.js](../../app/src/modules/api-client-v1.js))
   - Regenerate to include new import endpoint

## Implementation Steps

### Phase 1: Backend Utility Module

Create `fastapi_app/lib/file_zip_importer.py`:
- Extract ZIP to temporary directory
- Validate directory structure (pdf/, tei/, versions/)
- Call FileImporter.import_directory()
- Return statistics
- Clean up temporary files

### Phase 2: Backend API Endpoint

Create `fastapi_app/routers/files_import.py`:
- POST endpoint with file upload
- Session authentication
- Collection-based access control (assign imported files to collections user has access to)
- Use FileZipImporter
- Return import statistics

Register router in `fastapi_app/main.py`.

### Phase 3: CLI Integration

Update `bin/import_files.py`:
- Add optional `--zip` flag
- When specified, use FileZipImporter instead of direct directory import

### Phase 4: Frontend UI

Update file selection drawer:
- Add import button in template
- Wire up click handler
- Trigger hidden file input
- Upload file via API
- Show progress/feedback
- Reload file data on success

### Phase 5: Testing

Create tests:
- Unit tests: `tests/unit/fastapi/test_file_zip_importer.py`
- API tests: `tests/api/v1/files_import.test.js`
- E2E test: `tests/e2e/tests/import-workflow.spec.js`

## API Endpoint Design

### POST /api/v1/import

**Request:**
```
POST /api/v1/import
Content-Type: multipart/form-data
X-Session-ID: <session_id>

file: <zip file>
collection: <optional collection name>
recursive_collections: <optional boolean>
```

**Response:**
```json
{
  "files_scanned": 42,
  "files_imported": 40,
  "files_skipped": 2,
  "files_updated": 0,
  "errors": []
}
```

**Error Responses:**
- 400: Invalid ZIP structure
- 401: Authentication required
- 403: No access to collections
- 500: Import failed

## Directory Structure Validation

The ZIP importer will validate that the uploaded archive contains a recognized structure:

**Type grouping:**
```
export/
├── pdf/
├── tei/
└── versions/
```

**Collection grouping:**
```
export/
├── collection1/
│   ├── pdf/
│   ├── tei/
│   └── versions/
└── collection2/
    ├── pdf/
    ├── tei/
    └── versions/
```

**Variant grouping:**
```
export/
├── pdf/
├── grobid-0.8.1/
└── metatei-1.0/
```

The root directory name is flexible (doesn't have to be "export/").

## Access Control

When importing files:
- If user has wildcard collection access (`*`), files can be imported to any collection
- If user has limited access, files can only be imported to accessible collections
- If `--recursive-collections` is used, validate that all detected collections are accessible
- If `--collection` is specified, validate user has access to that collection

## UI Integration

Add import button to file selection drawer footer, next to export button:

```html
<sl-button name="importButton" variant="default" size="small">
  <sl-icon name="upload"></sl-icon>
  Import
</sl-button>
<input type="file" name="importFileInput" accept=".zip" style="display: none;">
```

Workflow:
1. User clicks "Import" button
2. Hidden file input is triggered
3. User selects ZIP file
4. File is uploaded via API
5. Progress indicator shown
6. On success: reload file data, show success message
7. On error: show error message with details

## Error Handling

Import errors:
- Invalid ZIP format
- Unrecognized directory structure
- Individual file import failures (collected and reported)
- Access control violations
- Disk space issues

Frontend should display:
- Success count and any errors
- Option to download detailed error log if errors occurred

## Future Enhancements

Potential improvements:
1. **Progress streaming**: WebSocket or SSE for real-time progress updates
2. **Conflict detection**: Check for existing files before import, prompt for resolution
3. **Partial imports**: Allow importing specific collections from multi-collection archives
4. **Drag-and-drop**: Support dropping ZIP files directly on the file drawer
5. **Validation-only mode**: Preview import without actually importing files

## Implementation Progress

### Completed Implementation

All planned phases have been implemented and tested:

**Backend Components:**
- [fastapi_app/lib/file_zip_importer.py](../../fastapi_app/lib/file_zip_importer.py) - ZIP extraction and import utility
- [fastapi_app/routers/files_import.py](../../fastapi_app/routers/files_import.py) - POST `/api/v1/import` endpoint
- [fastapi_app/main.py:179](../../fastapi_app/main.py#L179) - Router registration

**CLI Integration:**
- [bin/import_files.py](../../bin/import_files.py) - Added `--zip` flag for ZIP file imports

**Frontend Components:**
- [app/src/templates/file-selection-drawer.html](../../app/src/templates/file-selection-drawer.html) - Import button UI
- [app/src/plugins/file-selection-drawer.js:187-198](../../app/src/plugins/file-selection-drawer.js#L187-L198) - Event handlers
- [app/src/plugins/file-selection-drawer.js:697-779](../../app/src/plugins/file-selection-drawer.js#L697-L779) - handleImport function

**Testing:**
- [tests/unit/fastapi/test_file_zip_importer.py](../../tests/unit/fastapi/test_file_zip_importer.py) - Unit tests (11 tests, all passing)
- [tests/api/v1/files_import.test.js](../../tests/api/v1/files_import.test.js) - API integration tests (8 tests, all passing)

### Key Features

**ZIP Structure Support:**
- Type-grouped structure (`pdf/`, `tei/`, `versions/`)
- Collection-grouped structure (`collection1/pdf/`, `collection1/tei/`)
- Variant-grouped structure (`pdf/`, `grobid-0.8.1/`)
- ZIP with single root directory or files at root

**Import Options:**
- Collection assignment via `--collection` parameter
- Recursive collections via `--recursive-collections` flag
- Gold standard detection via directory or filename patterns
- Version pattern stripping for file matching

**Error Handling:**
- Invalid ZIP file detection
- Empty ZIP rejection
- Non-existent file validation
- Collection access control enforcement

**Frontend Integration:**
- Import button in file selection drawer
- File upload via hidden file input
- Progress indication with loading state
- Success/error toast notifications
- Automatic file data reload after import

### Usage Examples

**CLI Import:**
```bash
# Import from ZIP file
python bin/import_files.py --zip export.zip

# Import with collection assignment
python bin/import_files.py --zip export.zip --collection corpus1

# Import with recursive collections
python bin/import_files.py --zip export.zip --recursive-collections
```

**API Import:**
```bash
# Upload ZIP via API
curl -X POST "http://localhost:8000/api/v1/import?sessionId=<session>" \
  -F "file=@export.zip"

# With collection assignment
curl -X POST "http://localhost:8000/api/v1/import?sessionId=<session>&collection=corpus1" \
  -F "file=@export.zip"
```

**UI Import:**
1. Click "Import" button in file selection drawer
2. Select ZIP file from file system
3. Wait for upload and import to complete
4. Files automatically appear in the file tree

### Test Results

**Unit Tests:** 11/11 passed
- Basic ZIP import
- ZIP structure validation
- Collection assignment
- Recursive collections
- Error handling
- Cleanup verification
- Dry run mode

**API Integration Tests:** 8/8 passed
- Authentication enforcement
- Basic structure import
- Collection assignment
- Non-ZIP file rejection
- Empty ZIP rejection
- Recursive collections
- Invalid ZIP handling

All tests passing with no errors.

### Auto-Collection Creation

Added support for automatic collection creation during import:

**Implementation:**

- Modified [fastapi_app/lib/file_importer.py:425-471](../../fastapi_app/lib/file_importer.py#L425-L471) to auto-create collections
- Added imports for `add_collection`, `load_entity_data` from collection_utils
- Added collection existence check in `_import_document()` method
- Collections are created with ID and name derived from directory name
- Empty description by default

**Behavior:**

- When importing with `recursive_collections=True`, parent directory names determine collection IDs
- If collection doesn't exist, it's automatically created before importing files
- Collection creation failures are logged but don't stop the import process
- Special directories (pdf, tei, versions) are skipped via `skip_dirs` parameter

**Testing:**

- Added unit test `test_auto_create_collections` in test_file_zip_importer.py
- Test verifies collection is created and files are assigned correctly
- All 12 unit tests passing (11 existing + 1 new)
- All 8 API integration tests passing

**Example:**

```bash
# Import ZIP with structure: collection1/pdf/doc.pdf, collection2/tei/doc.xml
# Collections "collection1" and "collection2" will be auto-created if they don't exist
python bin/import_files.py --zip export.zip --recursive-collections
```

**UI Integration:**

The frontend import button passes `recursive_collections=true` by default in [file-selection-drawer.js:727](../../app/src/plugins/file-selection-drawer.js#L727), enabling automatic collection creation for UI-based imports.

### Bug Fixes

**macOS Metadata Filtering:**

- Fixed issue where ZIP files created on macOS contain `__MACOSX` directories and `._*` resource fork files
- Modified [file_zip_importer.py:165](../../fastapi_app/lib/file_zip_importer.py#L165) to ignore `__MACOSX` when detecting import root
- Modified [file_importer.py:270-271](../../fastapi_app/lib/file_importer.py#L270-L271) to skip files in `__MACOSX` directories and files starting with `._`
- This prevents metadata files from being imported and ensures correct collection detection

**Form vs Query Parameters:**

- Fixed issue where `recursive_collections` parameter wasn't being recognized
- Changed from `Form()` to `Query()` parameter in [files_import.py:40-41](../../fastapi_app/routers/files_import.py#L40-L41)
- Frontend sends parameters as query string (`?recursive_collections=true`), not form data
- This ensures collections are properly detected and assigned during import

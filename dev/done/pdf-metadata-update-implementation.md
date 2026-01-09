# PDF Metadata Update Implementation

## Summary

Implemented automatic PDF metadata updates when saving gold standard TEI files. When a TEI file with metadata (title, authors, date, publisher, journal) is saved, the corresponding PDF file's metadata is now automatically updated.

## Changes

### 1. Shared Utility Functions ([fastapi_app/lib/tei_utils.py](fastapi_app/lib/tei_utils.py))

Added two new functions to centralize PDF metadata update logic:

- **`build_pdf_label_from_metadata(doc_metadata)`** (lines 484-521)
  - Builds human-readable PDF label from TEI metadata
  - Format: "Author (Year) Title" with fallbacks to partial formats
  - Returns None if no title available

- **`update_pdf_metadata_from_tei(pdf_file, tei_metadata, file_repo, logger, doc_collections)`** (lines 524-582)
  - Updates PDF file metadata from extracted TEI metadata
  - Updates: `doc_metadata`, `label`, and optionally `doc_collections`
  - Uses `build_pdf_label_from_metadata()` for consistent label formatting
  - Returns True if update attempted, False if no updates needed
  - Handles errors gracefully with warning logs

### 2. Extraction Endpoint ([fastapi_app/routers/extraction.py](fastapi_app/routers/extraction.py))

Refactored to use the new shared function:

- Replaced inline metadata update logic (lines 321-372) with call to `update_pdf_metadata_from_tei()`
- Simplified code from ~52 lines to ~7 lines
- Maintains same behavior as before

### 3. Files Save Endpoint ([fastapi_app/routers/files_save.py](fastapi_app/routers/files_save.py))

Added PDF metadata updates for gold standard TEI saves:

- **Update existing gold standard** (lines 404-415)
  - When saving an existing gold standard TEI file, PDF metadata is updated
  - Checks `existing_file.is_gold_standard` before updating

- **Create new gold standard** (lines 512-521)
  - When creating a new gold standard TEI file, PDF metadata is updated
  - Only runs if PDF file exists and TEI has metadata

**Important:** Version files (non-gold) do NOT update PDF metadata - only gold standard files trigger PDF updates.

## Testing

### Unit Tests ([tests/unit/test_tei_metadata_update.py](tests/unit/test_tei_metadata_update.py))

Created comprehensive unit tests (14 tests, all passing):

**TestBuildPdfLabelFromMetadata** (8 tests):
- Full metadata (author + year + title)
- Partial metadata combinations (author+title, date+title, title-only)
- Edge cases (no title, empty metadata, author without family name)
- Multiple authors (uses first author)

**TestUpdatePdfMetadataFromTei** (5 tests):
- Update with full metadata and label
- Update with collections sync
- Fallback to doc_id for label when no title
- No update when metadata is empty
- Graceful error handling

**TestExtractTeiMetadataIntegration** (1 test):
- End-to-end flow: extract metadata from TEI XML, then update PDF
- Verifies integration between `extract_tei_metadata()` and `update_pdf_metadata_from_tei()`

### API Integration Tests ([tests/api/v1/files_save.test.js](tests/api/v1/files_save.test.js))

Added two new E2E tests:

1. **PDF metadata updates when saving gold standard TEI** (lines 647-751)
   - Uploads PDF file
   - Saves gold standard TEI with full metadata
   - Verifies PDF label updated to "Smith (2023) Machine Learning in Digital Humanities"
   - Verifies PDF doc_metadata includes title, date, publisher, journal

2. **Version files do NOT update PDF metadata** (lines 754-871)
   - Uploads PDF and creates gold standard TEI
   - Creates version TEI with different metadata
   - Verifies PDF metadata remains unchanged after version save

Also added helper function `createTeiXmlWithMetadata()` (lines 62-110) for creating sample TEI with full metadata.

## Behavior

### When PDF Metadata is Updated

PDF metadata is automatically updated when:
- **Creating new gold standard TEI** with metadata
- **Updating existing gold standard TEI** with metadata

The update includes:
- `doc_metadata`: Dictionary with title, authors, date, journal, publisher (only if non-empty)
- `label`: Formatted as "Author (Year) Title" or fallback formats
- `doc_collections`: Optionally synced from TEI file

### When PDF Metadata is NOT Updated

PDF metadata is NOT updated when:
- **Saving version (non-gold) TEI files** - versions don't affect PDF metadata
- **TEI has no metadata** - no update if doc_metadata is empty (preserves existing PDF metadata)
- **No corresponding PDF exists** - update silently skipped

### Important: Preserving Existing Metadata

If a TEI file has no metadata (empty `doc_metadata`), the existing PDF metadata is **preserved** and not overwritten. The function uses `bool(doc_metadata)` to check if the dict is non-empty before including it in the update, preventing accidental erasure of existing information.

## Example Usage

When a user edits a TEI file in the editor and saves it:

```python
# Before save: PDF has no metadata
pdf_file.label = None
pdf_file.doc_metadata = {}

# User saves gold standard TEI with metadata
save_file(xml_string=tei_with_metadata, file_id=doc_id, new_version=False)

# After save: PDF metadata automatically updated
pdf_file.label = "Smith (2023) Machine Learning in Digital Humanities"
pdf_file.doc_metadata = {
    'title': 'Machine Learning in Digital Humanities',
    'authors': [{'given': 'Jane', 'family': 'Smith'}],
    'date': '2023',
    'publisher': 'Academic Press',
    'journal': 'Digital Humanities Quarterly'
}
```

## Code Reuse

The refactoring successfully eliminated code duplication:
- **Before**: Metadata update logic duplicated in extraction.py (~52 lines)
- **After**: Single shared implementation in tei_utils.py (~100 lines for both functions)
- **Benefit**: Both extraction and save endpoints now use the same logic, ensuring consistent behavior

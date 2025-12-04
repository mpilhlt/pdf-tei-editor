# Import Identical Files with Different Names

## Current Behavior

The import script ([bin/import_files.py](../../bin/import_files.py)) currently checks for duplicates **only by content hash** (SHA-256).

### Implementation Details

1. **In `_import_pdf`** ([file_importer.py:409-426](../../fastapi_app/lib/file_importer.py#L409-L426)):
   - Generates content hash from file bytes
   - Checks if a file with this hash already exists: `self.repo.get_file_by_id(file_hash)`
   - If exists, skips import and increments `files_skipped` counter
   - **Does not check filename** - only content hash

2. **In `_import_tei`** ([file_importer.py:459-477](../../fastapi_app/lib/file_importer.py#L459-L477)):
   - Same logic: generates hash, checks existence by hash only
   - If exists, skips import

### Implications

✅ **Idempotent for same source**: Running the import multiple times on the same directory will not create duplicates, as files with the same content will be skipped.

❌ **Not filename-aware**: If you import a file with:
- Same content hash
- Different filename

The current code will **skip the import entirely**, NOT create a new metadata entry. This means:
- You cannot have two different filenames referencing the same content hash
- The script treats identical content as a duplicate regardless of filename

## Desired Behavior

If a file with the same content hash but a different filename is imported, it should:
1. Reuse the existing storage location (don't save duplicate content)
2. Create a new metadata entry with the different filename
3. Only skip if both content hash AND filename match exactly

## Implementation Plan

Modify both `_import_pdf` and `_import_tei` methods in [file_importer.py](../../fastapi_app/lib/file_importer.py) to:

1. Check for existing file by content hash
2. If content exists:
   - Check if filename also matches
   - If filename differs:
     - Skip storage write (file already stored)
     - Create new metadata entry pointing to existing content hash
     - Increment `files_imported` counter
   - If filename matches:
     - Skip entirely (true duplicate)
     - Increment `files_skipped` counter
3. If content doesn't exist:
   - Save file to storage
   - Create metadata entry
   - Increment `files_imported` counter

### Code Changes Required

1. Modify `_import_pdf()` and `_import_tei()` to distinguish between:
   - Content-only duplicate (reuse storage, create metadata)
   - Complete duplicate (skip entirely)

2. May need to add repository method to check for existing file by both hash and filename, or query all files with same hash and check filenames.

3. Update logging to distinguish between:
   - "File skipped (identical content and filename)"
   - "File imported with existing content (new filename reference)"

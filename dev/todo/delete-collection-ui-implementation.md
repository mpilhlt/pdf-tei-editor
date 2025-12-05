# Delete Collection UI Implementation

## Overview

Add UI for deleting collections with proper file handling and role-based access control.

## Technical Requirements

### Backend Changes

1. **Enhance `delete_collection` endpoint** ([fastapi_app/routers/collections.py:243-272](fastapi_app/routers/collections.py#L243-L272))
   - Remove collection from all files' metadata
   - Mark files as deleted if they have no other collections
   - Return statistics about affected files

2. **Update `remove_collection` function** ([fastapi_app/lib/collection_utils.py](fastapi_app/lib/collection_utils.py))
   - Add file metadata cleanup logic
   - Use metadata.db to find all files in collection
   - Update collection arrays in file records
   - Mark orphaned files as deleted

### Frontend Changes

1. **Add delete button** to file-selection-drawer.js
   - Add button in footer next to export/import
   - Show only for users with "reviewer" role or higher
   - Trigger confirmation dialog before deletion

2. **Role-based visibility**
   - Import, Export, Delete buttons visible only for reviewer/admin roles
   - Check `current_user.roles` array for "reviewer", "admin", or "*"

3. **Confirmation dialog**
   - Use native `confirm()` or Shoelace dialog
   - Show collection name in message
   - Call DELETE endpoint on confirmation

### API Endpoint

```
DELETE /api/v1/collections/{collection_id}
Response: {
  "success": true,
  "collection_id": "...",
  "files_updated": 5,
  "files_deleted": 2
}
```

## Implementation Steps

1. Update backend collection deletion logic
2. Add tests for file cleanup behavior
3. Add delete button to file drawer UI
4. Implement role-based button visibility
5. Add confirmation dialog
6. Test complete workflow

## Implementation Progress

### Backend Changes

1. **Added `get_files_by_collection` method** ([fastapi_app/lib/file_repository.py:598-622](fastapi_app/lib/file_repository.py#L598-L622))
   - Queries files by collection using JSON array search
   - Returns list of FileMetadata models
   - Filters deleted files by default

2. **Enhanced `remove_collection` function** ([fastapi_app/lib/collection_utils.py:130-198](fastapi_app/lib/collection_utils.py#L130-L198))
   - Uses FileRepository API instead of raw SQL
   - Removes collection from each file's doc_collections array
   - Marks files as deleted if no other collections remain
   - Returns statistics: files_updated and files_deleted

3. **Updated `delete_collection` endpoint** ([fastapi_app/routers/collections.py:243-296](fastapi_app/routers/collections.py#L243-L296))
   - Added CollectionDeleteResponse model with statistics
   - Changed from 204 to 200 response with JSON body
   - Logs deletion statistics
   - Returns files_updated and files_deleted counts

4. **Added comprehensive tests** ([tests/unit/fastapi/test_collection_utils.py:142-276](tests/unit/fastapi/test_collection_utils.py#L142-L276))
   - Test file metadata updates when collection removed
   - Test orphaned files marked as deleted
   - Test mixed scenario with both updated and deleted files
   - All tests passing

### Frontend Changes

1. **Added delete button** ([app/src/templates/file-selection-drawer.html:55-60](app/src/templates/file-selection-drawer.html#L55-L60))
   - Danger variant with trash icon
   - Initially disabled
   - Positioned between export and close buttons

2. **Updated typedef** ([app/src/plugins/file-selection-drawer.js:32](app/src/plugins/file-selection-drawer.js#L32))
   - Added deleteButton to fileDrawerPart

3. **Implemented handleDelete function** ([app/src/plugins/file-selection-drawer.js:837-925](app/src/plugins/file-selection-drawer.js#L837-L925))
   - Shows confirmation dialog with collection name
   - Calls DELETE endpoint with session authentication
   - Displays success/error notifications
   - Reloads file data after deletion
   - Handles loading state

4. **Updated button state management** ([app/src/plugins/file-selection-drawer.js:698-707](app/src/plugins/file-selection-drawer.js#L698-L707))
   - Delete button enabled only for exactly one selected collection
   - Export button enabled for one or more collections

5. **Implemented role-based visibility** ([app/src/plugins/file-selection-drawer.js:274-300](app/src/plugins/file-selection-drawer.js#L274-L300))
   - Import, export, delete buttons hidden for users without reviewer role
   - Checks for '*', 'admin', or 'reviewer' roles
   - Updates visibility on state change

### Documentation

Updated CLAUDE.md with database access guidelines:
- Always use API methods from repository modules
- Avoid raw SQL queries except in exceptional cases
- Add missing operations to repositories rather than using ad-hoc SQL


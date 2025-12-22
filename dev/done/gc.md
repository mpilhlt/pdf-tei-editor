# Garbage Collection API

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/135

Depends on `dev/todo/setting-menu.md`

## Implementation Status

✅ **Backend Complete** - API endpoint fully implemented and tested

✅ **Frontend Complete** - Integrated into toolbar menu as admin-only menu item

## Frontend Implementation

Implemented as Option 1 (UI Integration) via the toolbar menu:

- Added "Garbage Collection" menu item to toolbar menu in [app/src/plugins/filedata.js](app/src/plugins/filedata.js)
- Menu item is admin-only (hidden for non-admin users)
- Clicking the menu item shows a confirmation dialog
- On confirmation, calls `/api/v1/files/garbage_collect` with `deleted_before` timestamp (current time)
- Shows success notification with results: records purged, files deleted, storage freed
- Automatically reloads file data after successful garbage collection
- Also cleans up orphaned files (files in storage with no database entry)
- Created [app/src/templates/gc-menu-item.html](app/src/templates/gc-menu-item.html) with tooltip explaining the function

**Files Modified:**

**Frontend:**
- [app/src/plugins/filedata.js](app/src/plugins/filedata.js) - Added menu item, dialog handler, and state update logic
- [app/src/templates/gc-menu-item.html](app/src/templates/gc-menu-item.html) - Menu item template with tooltip
- [app/src/plugins/toolbar.js](app/src/plugins/toolbar.js) - Updated typedef to document gcMenuItem
- [app/src/plugins.js](app/src/plugins.js) - Positioned FiledataPlugin in menu item order
- [app/src/plugins/dialog.js](app/src/plugins/dialog.js) - Added confirm() method for confirmation dialogs
- [app/src/templates/dialog.html](app/src/templates/dialog.html) - Added cancel/confirm buttons

**Backend:**

- [fastapi_app/lib/file_storage.py](fastapi_app/lib/file_storage.py) - Added find_orphaned_files() method
- [fastapi_app/routers/files_gc.py](fastapi_app/routers/files_gc.py) - Added orphan cleanup to GC process

### Orphaned File Cleanup

The garbage collection now includes automatic cleanup of orphaned files. An orphaned file is one that exists in the content-addressable storage but has no corresponding entry in the database. This can occur due to:

- Failed database operations during file deletion
- System crashes or interruptions
- Manual database modifications
- Database rollbacks after file writes

The cleanup process:

1. Scans all shard directories in the storage
2. For each file, extracts the hash and checks for a database entry
3. Deletes files with no database entry (including soft-deleted entries)
4. Removes empty shard directories
5. Cleans up reference count entries

This ensures the storage directory stays clean and frees space from truly orphaned files.

## API Endpoint

**POST** `/api/v1/files/garbage_collect`

### Request

```json
{
  "deleted_before": "2025-01-15T00:00:00Z",  // ISO timestamp (required)
  "sync_status": "pending_delete"             // Optional filter
}
```

### Response

```json
{
  "purged_count": 15,      // Database records deleted
  "files_deleted": 12,     // Physical files removed
  "storage_freed": 4567890 // Bytes freed
}
```

### Security

- **Admin required** for timestamps < 24 hours old (prevents accidental deletion)
- All authenticated users can purge files > 24 hours old
- Returns 403 if non-admin attempts recent purge

### Behavior

- Permanently deletes soft-deleted files (`deleted=1`) matching filters
- Uses reference counting - only deletes physical files when `ref_count=0`
- Filters are additive (all conditions must match)
- Handles deduplication correctly

## Integration Options

### Option 1: UI Integration

Add to admin panel or file management UI:

- Show deleted files count
- Allow admin to trigger GC with date picker
- Display results (files purged, storage freed)

**Files to modify:**

- `app/src/plugins/services.js` - Add GC service method
- `app/src/ui.js` - Add UI element definitions
- Create new admin panel or add to existing file management UI

### Option 2: Lifecycle Integration

Add automatic GC to application startup/maintenance:

- Run GC on server startup (configurable)
- Scheduled task (cron-style)
- Admin-only CLI command

**Files to modify:**

- `fastapi_app/main.py` - Add startup event handler
- Add configuration for GC schedule/age threshold

### Option 3: Manual CLI

Admin runs GC via direct API call or management script:

```bash
curl -X POST http://localhost:8000/api/v1/files/garbage_collect \
  -H "Cookie: session_id=..." \
  -H "Content-Type: application/json" \
  -d '{"deleted_before":"2025-01-01T00:00:00Z"}'
```

## Implementation Files

### Backend (Complete)

- `fastapi_app/routers/files_gc.py` - Endpoint implementation
- `fastapi_app/lib/file_repository.py` - Database queries
- `fastapi_app/lib/models_files.py` - Request/response models
- `fastapi_app/main.py` - Router registration

### Tests (Complete)

- `tests/unit/fastapi/test_garbage_collection.py` - 8 unit tests
- `tests/api/v1/files_garbage_collect.test.js` - 14 integration tests

## Next Steps

1. **Decide integration approach** (UI, lifecycle, or manual)
2. **For UI integration:**
   - Add client method to `services.js`
   - Create admin UI component
   - Add to navigation/admin panel
3. **For lifecycle integration:**
   - Add config option for GC threshold (default: 30 days)
   - Add startup/scheduled task
   - Add logging for automatic runs

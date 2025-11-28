# Garbage Collection API - TODO

## Implementation Status

✅ **Backend Complete** - API endpoint fully implemented and tested

⏳ **Frontend Integration Needed** - Not yet integrated into UI or application lifecycle

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

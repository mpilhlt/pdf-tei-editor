# Reference Counting Implementation

## Status: 90% Complete - Needs Double-Counting Fix

## Problem Solved

When file content changes during save, the old file becomes orphaned:
- New hash created → new file saved
- Database updated with new hash
- **Old file remains in storage with no references**

Without cleanup strategy, orphaned files accumulate indefinitely.

## Solution: Reference Counting

Track how many database entries reference each physical file. Delete physical files only when ref_count reaches 0.

### Benefits:
✅ **Safe deduplication** - Same content = same file = shared references
✅ **Automatic cleanup** - Old files deleted when no longer referenced
✅ **No orphans** - Every file tracked
✅ **Self-healing** - Garbage collection catches edge cases

## Implementation

### 1. Storage References Table

```sql
CREATE TABLE storage_refs (
    file_hash TEXT PRIMARY KEY,
    file_type TEXT NOT NULL,  -- 'pdf', 'tei', 'rng'
    ref_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    CHECK(ref_count >= 0)
);
```

### 2. Files Created

- `fastapi_app/lib/storage_references.py` - Reference counting manager
- `fastapi_app/lib/storage_gc.py` - Garbage collection utilities
- `fastapi_app/cli_storage_gc.py` - CLI tool for GC
- `fastapi_app/tests/backend/storage_refcounting.test.js` - Tests

### 3. Files Modified

- `fastapi_app/lib/file_storage.py` - Added ref counting to save/delete
- `fastapi_app/lib/dependencies.py` - Pass db_path to FileStorage
- `fastapi_app/routers/files_save.py` - Handle ref counting on content change
- `fastapi_app/routers/files_delete.py` - Decrement refs on delete

## Current Issue: Double-Counting

**Problem**: Reference count is 2 when it should be 1

**Root Cause**: References incremented twice:
1. Once in `FileStorage.save_file()` (auto-increment)
2. Once when database entry created

**Where It Happens**:
- `files_save.py` calls `file_storage.save_file()` which increments ref
- Then calls `file_repo.insert_file()` which should also increment
- Result: ref_count = 2 instead of 1

## Fix Needed

### Option A: Repository Handles References (Recommended)

**Change**: FileRepository insert/update/delete methods handle reference counting

```python
# In FileRepository
def insert_file(self, file_data: FileCreate) -> FileMetadata:
    # Insert into database
    ...
    # Increment storage reference
    self.ref_manager.increment_reference(file_data.id, file_data.file_type)
    return file

def delete_file(self, file_id: str) -> None:
    file = self.get_file_by_id(file_id)
    # Soft delete in database
    ...
    # Decrement storage reference
    self.ref_manager.decrement_reference(file_id)
```

**Pros**:
- Clean separation: DB layer manages references
- API layer doesn't worry about ref counting
- Automatic for all database operations

**Cons**:
- Repository needs ref_manager dependency
- Slightly couples storage and database

### Option B: API Layer Manages References

**Change**: Remove auto-increment from FileStorage, explicit calls in API

```python
# In files_save.py
saved_hash, _ = file_storage.save_file(xml_bytes, 'tei', increment_ref=False)
file_repo.insert_file(...)
file_storage.ref_manager.increment_reference(saved_hash, 'tei')
```

**Pros**:
- Explicit control
- Clear what's happening

**Cons**:
- Easy to forget
- Duplicate code across APIs
- Error-prone

### Recommendation: **Option A**

Move reference counting to FileRepository layer for automatic, consistent handling.

## Testing Status

**Existing Tests**: ✅ All passing (7/7 in files_delete.test.js)

**Reference Counting Tests**: ❌ Failing due to double-counting
- Test expects ref_count = 1, gets 2
- Tests are correct, implementation needs fix

## Next Steps

1. **Fix double-counting**:
   - Set `increment_ref=False` in all `save_file()` calls
   - Add reference increment to `FileRepository.insert_file()`
   - Add reference decrement to `FileRepository.delete_file()`

2. **Update FileRepository**:
   - Add `ref_manager` parameter to `__init__`
   - Increment ref in `insert_file`
   - Decrement ref in `delete_file` (after soft delete)
   - Handle ref counting in `update_file` when hash changes

3. **Test thoroughly**:
   - Run `storage_refcounting.test.js`
   - Verify deduplication works
   - Verify cleanup on content change
   - Verify cleanup on delete

4. **Run garbage collection**:
   ```bash
   # Dry run
   uv run python fastapi_app/cli_storage_gc.py --dry-run

   # Verify
   uv run python fastapi_app/cli_storage_gc.py --verify

   # Actual cleanup
   uv run python fastapi_app/cli_storage_gc.py
   ```

## CLI Tools

###  Garbage Collection

```bash
# See what would be deleted
uv run python fastapi_app/cli_storage_gc.py --dry-run

# Verify integrity
uv run python fastapi_app/cli_storage_gc.py --verify

# Rebuild references from database (migration)
uv run python fastapi_app/cli_storage_gc.py --rebuild-refs

# Actually clean up
uv run python fastapi_app/cli_storage_gc.py
```

## Migration Path

For existing installations:

1. **Rebuild references from database**:
   ```bash
   uv run python fastapi_app/cli_storage_gc.py --rebuild-refs
   ```

2. **Verify integrity**:
   ```bash
   uv run python fastapi_app/cli_storage_gc.py --verify
   ```

3. **Clean up orphans** (if any):
   ```bash
   uv run python fastapi_app/cli_storage_gc.py --dry-run  # Check first
   uv run python fastapi_app/cli_storage_gc.py            # Actually delete
   ```

## Maintenance

**Periodic GC**: Run garbage collection weekly/monthly:
```bash
uv run python fastapi_app/cli_storage_gc.py
```

**After bulk operations**: If doing bulk imports/deletes, run GC after:
```bash
uv run python fastapi_app/cli_storage_gc.py --verify  # Check for issues
uv run python fastapi_app/cli_storage_gc.py            # Clean up
```

## Related Documents

- [Save API Completion](./SESSION-2025-10-11-save-api-completion.md)
- [Phase 4B Final Status](./phase-4b-final-status.md)
- [Phase 4 File Management](./phase-4-file-management.md)

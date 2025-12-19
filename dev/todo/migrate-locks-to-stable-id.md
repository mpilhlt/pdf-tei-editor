# Migrate File Locks to Use stable_id Instead of Content Hash

## Problem

The file locking system currently uses content hashes (`file.id`) as lock identifiers instead of stable IDs (`file.stable_id`). This creates several issues:

1. **Lock Transfer Required**: When a file's content changes during save, the content hash changes, requiring lock transfer from the old hash to the new hash
2. **Complexity**: The `transfer_lock()` function adds unnecessary complexity to work around the root issue
3. **Conceptual Mismatch**: Locks represent "user X is editing file Y", not "user X is editing content hash Z"
4. **Fragility**: Lock transfer can fail or be missed in edge cases, causing locks to be orphaned

## Current Working Solution

A `transfer_lock()` function was added in [fastapi_app/lib/locking.py:187-246](fastapi_app/lib/locking.py#L187-L246) to atomically move locks from old content hashes to new ones when file content changes. This is called from [fastapi_app/routers/files_save.py:364](fastapi_app/routers/files_save.py#L364) when `saved_hash != existing_file.id`.

**Status**: ✅ **Implemented and tested** - This solution fixes the immediate bug where files weren't being saved properly when processing instructions or other content changes occurred. The lock is now correctly transferred when the content hash changes during save operations.

## Root Cause

The locking system was designed for content-addressed storage where files are identified by their content hash. However:

- **Content hash is transient**: Changes every time file content changes
- **stable_id is permanent**: Never changes for a file, even across edits

Locks should use the permanent identifier.

## Proposed Solution

Migrate the locking system to use `stable_id` as the lock identifier:

### 1. Database Schema (Minimal Change)

**Option A - No Schema Change (Recommended)**:
- Keep the `file_hash` column name for backward compatibility
- Store `stable_id` values in it instead of content hashes
- No migration script needed, old locks will naturally expire

**Option B - Schema Migration**:
- Rename `file_hash` column to `file_id` in locks table
- Add migration script to rename column and clear stale locks
- More explicit but requires migration handling

### 2. Code Changes

Update all lock-related functions to use `stable_id`:

**fastapi_app/lib/locking.py**:
- Change `acquire_lock(file_hash, ...)` to `acquire_lock(file_id, ...)`
- Update parameter documentation to indicate `file_id` should be `stable_id`
- Update all SQL queries to use the new parameter name
- Update log messages to reflect `stable_id` instead of hash
- **Remove** `transfer_lock()` function (no longer needed)

**Call Sites** (update to pass `stable_id` instead of `id`):
- [fastapi_app/routers/files_save.py:367](fastapi_app/routers/files_save.py#L367): `acquire_lock(existing_file.stable_id, ...)`
- [fastapi_app/routers/files_save.py:364](fastapi_app/routers/files_save.py#L364): Remove `transfer_lock()` call entirely
- [fastapi_app/routers/files_save.py:439](fastapi_app/routers/files_save.py#L439): `acquire_lock(created_file.stable_id, ...)`
- [fastapi_app/routers/files_save.py:446](fastapi_app/routers/files_save.py#L446): `acquire_lock(created_file.stable_id, ...)`
- [fastapi_app/routers/files_save.py:491](fastapi_app/routers/files_save.py#L491): `acquire_lock(created_file.stable_id, ...)`
- [fastapi_app/routers/files_locks.py:133](fastapi_app/routers/files_locks.py#L133): `acquire_lock(file_metadata.stable_id, ...)`
- [fastapi_app/routers/files_heartbeat.py:59](fastapi_app/routers/files_heartbeat.py#L59): `acquire_lock(file_metadata.stable_id, ...)`

All `release_lock()`, `check_lock()`, and related function calls should also pass `stable_id`.

### 3. Implementation Steps

1. **Update locking.py function signatures**:
   - Rename `file_hash` parameter to `file_id` in all functions
   - Update docstrings to specify `file_id` should be the file's `stable_id`
   - Update all internal SQL queries to use the new parameter
   - Update log messages

2. **Update all call sites**:
   - Find all `acquire_lock()`, `release_lock()`, `check_lock()` calls
   - Change from passing `file_metadata.id` to `file_metadata.stable_id`
   - Remove the `transfer_lock()` call in files_save.py
   - Remove the import of `transfer_lock` from files_save.py

3. **Remove transfer_lock function**:
   - Delete the entire `transfer_lock()` function definition
   - Search for any other references and remove them

4. **Update tests**:
   - Update any tests that use locks to pass `stable_id` values
   - Remove tests for `transfer_lock()` if any exist

5. **Handle existing locks database**:
   - **Option 1 (Simple)**: Just start using stable_id, old locks with content hashes will expire naturally (90 seconds)
   - **Option 2 (Clean)**: Clear the locks table on deployment: `DELETE FROM locks;`
   - **Option 3 (Thorough)**: Create migration to identify and update active locks

### 4. Benefits

After migration:
- ✅ **No lock transfer needed** - stable_id never changes
- ✅ **Simpler code** - Remove ~60 lines of transfer logic
- ✅ **More intuitive** - Locks tied to files, not content snapshots
- ✅ **More robust** - No edge cases where transfer might fail
- ✅ **Better performance** - One less database operation per save

### 5. Risks and Considerations

**Backward Compatibility**:
- Existing locks in the database use content hashes
- After migration, these locks won't match stable_ids
- **Mitigation**: Locks expire after 90 seconds, so brief overlap period where locks might not work as expected

**Atomic Migration**:
- All code changes must be deployed together
- Partial deployment could cause lock acquisition failures
- **Mitigation**: Deploy during low-traffic period, locks auto-recover quickly

**Testing**:
- Need to test lock acquisition, refresh, release, and stale lock takeover
- Test concurrent edits to same file
- Test file save with content changes (no transfer should occur)

### 6. Alternative Considered

**Keep transfer_lock() workaround**:
- ✅ Minimal risk (already implemented and tested)
- ✅ Works correctly
- ❌ Technical debt remains
- ❌ Adds complexity
- ❌ Doesn't fix root cause

## Implementation Checklist

- [ ] Update `acquire_lock()` signature and implementation
- [ ] Update `release_lock()` signature and implementation
- [ ] Update `check_lock()` signature and implementation
- [ ] Update `get_locked_file_ids()` function
- [ ] Update all call sites in files_save.py
- [ ] Update all call sites in files_locks.py
- [ ] Update all call sites in files_heartbeat.py
- [ ] Remove `transfer_lock()` function
- [ ] Remove `transfer_lock` import from files_save.py
- [ ] Update lock-related tests
- [ ] Add test verifying no transfer happens during file save
- [ ] Update documentation/comments
- [ ] Decide on locks database migration strategy
- [ ] Test lock functionality end-to-end

## Estimated Effort

- **Code changes**: 2-3 hours
- **Testing**: 1-2 hours
- **Total**: ~4 hours

## Priority

**Medium** - The current `transfer_lock()` workaround is functional, but this refactoring would improve code quality and reduce complexity. Can be addressed in a dedicated technical debt sprint.

## Implementation Summary

Migration from content hash-based locking to stable_id-based locking was completed successfully with Option B (schema migration with generic migration infrastructure).

### Completed Work

1. **Generic Database Migration Infrastructure** - [fastapi_app/lib/migrations/](fastapi_app/lib/migrations/)
   - [MigrationManager](fastapi_app/lib/migrations/manager.py): Versioned migration manager with automatic backups, rollback support, transactional migrations
   - [Migration base class](fastapi_app/lib/migrations/base.py): Abstract base for creating migrations with upgrade/downgrade methods
   - Features: version tracking, automatic backups, conditional migrations via `check_can_apply()`, rollback support
   - Fully tested with [test_migrations.py](tests/unit/fastapi/test_migrations.py) (12 test cases)

2. **Lock Table Schema Migration** - [Migration 001](fastapi_app/lib/migrations/versions/m001_locks_file_id.py)
   - Renames `file_hash` column to `file_id` in locks table
   - Clears existing locks (acceptable since they expire in 90 seconds)
   - Idempotent via `check_can_apply()` - safe to run multiple times

3. **Locking System Updates** - [fastapi_app/lib/locking.py](fastapi_app/lib/locking.py)
   - Updated all lock functions to use `file_id` parameter (accepts stable_id values)
   - Removed `transfer_lock()` function (no longer needed!)
   - Migrations run automatically on first lock operation per process
   - Updated functions: `acquire_lock()`, `release_lock()`, `check_lock()`, `get_all_active_locks()`, `get_locked_file_ids()`

4. **API Endpoints Updated**
   - [files_save.py:367](fastapi_app/routers/files_save.py#L367): Uses `stable_id` for lock acquisition and removed transfer_lock call
   - [files_locks.py:133](fastapi_app/routers/files_locks.py#L133): Lock acquisition endpoint uses `stable_id`
   - [files_heartbeat.py:59](fastapi_app/routers/files_heartbeat.py#L59): Heartbeat uses `stable_id`
   - All release and check operations updated to use `stable_id`

5. **Testing**
   - Migration infrastructure: 12 unit tests covering all migration scenarios
   - Locking with stable_id: 12 unit tests verifying correct behavior
   - All existing API integration tests pass (37/37)
   - Tests verify locks persist across content changes without transfer

### Key Benefits Achieved

- **No lock transfers needed** - stable_id never changes, so locks remain valid across file content updates
- **Simpler code** - Removed ~60 lines of transfer logic
- **More robust** - No edge cases where transfer might fail
- **Better performance** - One less database operation per save
- **Reusable infrastructure** - Generic migration system for future schema changes

### Migration Behavior

On server startup:
1. Locks database is initialized with current schema (file_id column)
2. Migration manager checks if migration 001 needs to run
3. If `file_hash` column exists, migration renames it to `file_id` and clears old locks
4. If `file_id` column already exists, migration is skipped
5. Migration history is tracked in `migration_history` table

The migration is safe to run multiple times and does not require manual intervention.

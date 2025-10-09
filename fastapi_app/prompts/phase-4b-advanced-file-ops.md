# Phase 4B: Advanced File Operations

**Status**: Not Started (Deferred from Phase 4A)
**Goal**: Implement complex file operations, migration tools, and comprehensive testing.

## Overview

Phase 4B implements the remaining file management functionality that was deferred from Phase 4A:

- Complex file save logic with versioning, gold standards, and variants
- File deletion and moving between collections
- File locking endpoints and heartbeat
- File importer for migrating from Flask
- CLI tools for migration and database management
- Comprehensive test coverage

**Prerequisites**: Phase 4A must be complete and tested.

## Deferred Tasks from Phase 4A

### Core APIs

1. **File Save API** (`routers/files_save.py`)
   - Most complex endpoint (~400 lines)
   - Version vs gold file determination
   - Variant handling
   - File promotion (version → gold)
   - Role-based access control (reviewer can edit gold, annotator can edit versions)
   - Lock acquisition
   - Metadata extraction and updates

2. **File Delete API** (`routers/files_delete.py`)
   - Soft delete (set `deleted = 1`)
   - Access control checks
   - No physical file removal (for sync tracking)

3. **File Move API** (`routers/files_move.py`)
   - Update `doc_collections` array (multi-collection support)
   - No physical file move (hash-sharded storage is collection-agnostic)
   - Access control checks

4. **File Locks API** (`routers/files_locks.py`)
   - `GET /api/files/locks` - List all locks
   - `POST /api/files/check_lock` - Check lock status
   - `POST /api/files/acquire_lock` - Acquire lock for editing
   - `POST /api/files/release_lock` - Release lock

5. **Heartbeat API** (`routers/files_heartbeat.py`)
   - `POST /api/files/heartbeat` - Refresh file lock (keep-alive)
   - No cache_status in response (deprecated)

### Migration & Import Tools

6. **File Importer** (`lib/file_importer.py`)
   - Import from Flask directory structure
   - Import from arbitrary directories
   - Reconstruction from hash-sharded storage
   - Dry-run mode
   - Metadata extraction from TEI
   - Document grouping (PDF + multiple TEI files)

7. **Migration CLI** (`bin/migrate_to_fastapi.py`)
   - One-time migration from Flask `data/` directory
   - Creates SQLite database from Flask JSON cache
   - Copies files to hash-sharded storage
   - Preserves all metadata

8. **Import CLI** (`bin/import_files.py`)
   - Import PDFs/XMLs from arbitrary directories
   - Specify collection name
   - Recursive directory scanning

9. **Rebuild Database CLI** (`bin/rebuild_database.py`)
   - Reconstruct database from hash-sharded storage
   - Recovery tool after database corruption

### Testing & Documentation

10. **Python Unit Tests**
    - `test_file_importer.py` - Importer functionality
    - `test_hash_abbreviation.py` - Collision detection
    - `test_file_save.py` - Complex save logic

11. **JavaScript E2E Tests**
    - `files_save.test.js` - Save operations
    - `files_delete.test.js` - Delete operations
    - `files_move.test.js` - Move operations
    - `files_locks.test.js` - Lock operations

12. **Migration Guide**
    - Step-by-step Flask → FastAPI migration
    - Data validation steps
    - Rollback procedures

## Implementation Order

### Stage 1: Locking & Save Logic

1. Implement file save API (most critical deferred feature)
2. Test save scenarios (new version, update existing, promote to gold)
3. Verify role-based access control

### Stage 2: File Operations

4. Implement delete API
5. Implement move API
6. Implement locks API endpoints
7. Implement heartbeat API

### Stage 3: Migration Tools

8. Implement file importer
9. Test importer with Flask test data
10. Create migration CLI tool
11. Create import CLI tool
12. Create rebuild database CLI tool

### Stage 4: Testing & Documentation

13. Write comprehensive Python unit tests
14. Write comprehensive JavaScript E2E tests
15. Write migration guide
16. Verify all Flask endpoints have FastAPI equivalents

## Success Criteria

Phase 4B is complete when:

- ✅ All file APIs implemented (save, delete, move, locks, heartbeat)
- ✅ File importer works with Flask directory structure
- ✅ CLI migration tool successfully migrates test data
- ✅ All Python unit tests pass
- ✅ All JavaScript E2E tests pass
- ✅ Migration guide written and tested
- ✅ Full functional equivalence with Flask verified

## Next Phase

After Phase 4B completion:

→ **[Phase 5: Validation and Extraction APIs](phase-5-validation-extraction.md)**

## Reference Files

- Phase 4A completion: [phase-4a-core-file-apis.md](phase-4a-core-file-apis.md)
- Original Phase 4 plan: [phase-4-file-management.md](phase-4-file-management.md)
- Flask implementations: `server/api/files/*.py`

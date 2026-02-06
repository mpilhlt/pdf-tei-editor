# Database Schema Refactoring: Change Primary Key from Content Hash to Stable ID

## Problem

The `files` table currently uses `id` (SHA-256 content hash) as the PRIMARY KEY. This creates a fundamental limitation: multiple file records cannot share the same content, even when they represent different documents or versions.

### Current Schema

```sql
CREATE TABLE files (
    id TEXT PRIMARY KEY,               -- Content hash (SHA-256) - PROBLEM: must be unique
    stable_id TEXT UNIQUE NOT NULL,    -- Stable short ID for URLs
    ...
)
```

### Why This Is Wrong

1. **Legitimate content sharing**: Different documents can have identical content (e.g., boilerplate text, identical annotations)
2. **Version management**: Multiple versions of different documents might temporarily have identical content during editing
3. **Import failures**: Local sync plugin cannot import files when content hash already exists for a different document
4. **Conceptual mismatch**: `id` represents physical storage (content-addressed), not logical identity (file record)

### Real-World Impact

From local sync plugin ([#178](https://github.com/mpilhlt/pdf-tei-editor/issues/178)):

```
ERROR: UNIQUE constraint failed: files.id
Cannot import - content already exists for different document.
Existing: 10.19164__ijple.v6i1.1295/grobid.training.segmentation
New: 10.5771__2699-1284-2020-1-83/grobid.training.segmentation
```

The content is legitimately identical between two different documents, but the database schema prevents storing both records.

## Solution: Make `stable_id` the Primary Key

### Proposed Schema

```sql
CREATE TABLE files (
    stable_id TEXT PRIMARY KEY,        -- Stable short ID (unique identifier for each file record)
    id TEXT NOT NULL,                  -- Content hash (SHA-256, can be shared across records)
    filename TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    file_type TEXT NOT NULL,
    ...
)

-- Index for efficient content-based lookups
CREATE INDEX idx_files_content_hash ON files(id);

-- Composite index for finding all records with same content
CREATE INDEX idx_files_content_doc ON files(id, doc_id, variant);
```

### Rationale

- **`stable_id`**: Uniquely identifies each file record (logical identity)
- **`id` (content hash)**: References physical storage (can be shared)
- **Separation of concerns**: Logical identity vs. physical storage
- **Content deduplication**: Storage layer continues to work via `id` index
- **Reference counting**: Storage references remain tied to `id`, multiple records can reference same physical file

## Implementation Plan

### Phase 1: Analysis

1. **Audit code references** (29 found):
   ```bash
   grep -r "get_file_by_id\|WHERE id =" fastapi_app/lib/*.py
   ```

2. **Document all assumptions**:
   - Which code assumes `id` is PRIMARY KEY?
   - Which queries use `id` for lookups?
   - Where is `id` used for joins?

3. **Check foreign key constraints**:
   ```sql
   SELECT sql FROM sqlite_master WHERE sql LIKE '%FOREIGN KEY%' AND sql LIKE '%files%';
   ```

### Phase 2: Migration Script

Create migration: `fastapi_app/lib/migrations/versions/m00X_change_primary_key.py`

```python
"""
Change files table PRIMARY KEY from id (content hash) to stable_id.

Migration: m00X_change_primary_key
Date: 2026-01-XX
"""

def upgrade(db_path: str, logger=None):
    """
    Migrate files table to use stable_id as PRIMARY KEY.

    Steps:
    1. Create backup of files table
    2. Create new files_new table with correct schema
    3. Copy all data from files to files_new
    4. Verify data integrity (row counts, spot checks)
    5. Drop old files table
    6. Rename files_new to files
    7. Recreate all indexes
    8. Verify foreign key integrity
    """
    import sqlite3

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        # 1. Create backup
        cursor.execute("CREATE TABLE files_backup AS SELECT * FROM files")

        # 2. Create new table with correct schema
        cursor.execute("""
            CREATE TABLE files_new (
                stable_id TEXT PRIMARY KEY,
                id TEXT NOT NULL,
                filename TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                doc_id_type TEXT DEFAULT 'doi',
                file_type TEXT NOT NULL,
                mime_type TEXT,
                file_size INTEGER,
                label TEXT,
                variant TEXT,
                version INTEGER DEFAULT 1,
                is_gold_standard BOOLEAN DEFAULT 0,
                deleted BOOLEAN DEFAULT 0,
                local_modified_at TIMESTAMP,
                remote_version INTEGER,
                sync_status TEXT DEFAULT 'synced',
                sync_hash TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                doc_collections TEXT,
                doc_metadata TEXT,
                file_metadata TEXT
            )
        """)

        # 3. Copy all data (preserving all columns)
        cursor.execute("""
            INSERT INTO files_new
            SELECT * FROM files
        """)

        # 4. Verify row counts match
        old_count = cursor.execute("SELECT COUNT(*) FROM files").fetchone()[0]
        new_count = cursor.execute("SELECT COUNT(*) FROM files_new").fetchone()[0]

        if old_count != new_count:
            raise Exception(f"Row count mismatch: {old_count} != {new_count}")

        # 5. Drop old table
        cursor.execute("DROP TABLE files")

        # 6. Rename new table
        cursor.execute("ALTER TABLE files_new RENAME TO files")

        # 7. Create indexes
        cursor.execute("CREATE INDEX idx_files_content_hash ON files(id)")
        cursor.execute("CREATE INDEX idx_files_doc_id ON files(doc_id)")
        cursor.execute("CREATE INDEX idx_files_content_doc ON files(id, doc_id, variant)")
        cursor.execute("CREATE INDEX idx_files_type_deleted ON files(file_type, deleted)")
        cursor.execute("CREATE INDEX idx_files_collections ON files(doc_collections)")

        conn.commit()

        if logger:
            logger.info("Successfully migrated files table PRIMARY KEY to stable_id")

    except Exception as e:
        conn.rollback()
        if logger:
            logger.error(f"Migration failed: {e}")
        raise
    finally:
        conn.close()

def downgrade(db_path: str, logger=None):
    """
    Rollback to use id (content hash) as PRIMARY KEY.

    This will FAIL if duplicate content hashes exist after migration.
    Only safe to run immediately after upgrade, before any new data is added.
    """
    import sqlite3

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        # Check for duplicate content hashes
        duplicates = cursor.execute("""
            SELECT id, COUNT(*) as count
            FROM files
            GROUP BY id
            HAVING count > 1
        """).fetchall()

        if duplicates:
            raise Exception(
                f"Cannot downgrade: {len(duplicates)} content hashes are shared by multiple records. "
                "Downgrade is only safe immediately after upgrade, before new data is added."
            )

        # Recreate old schema (same steps as upgrade, but reversed)
        cursor.execute("CREATE TABLE files_old AS SELECT * FROM files")
        cursor.execute("DROP TABLE files")

        # Recreate with old schema (id as PRIMARY KEY)
        cursor.execute("""
            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                stable_id TEXT UNIQUE NOT NULL,
                ... (rest of schema)
            )
        """)

        cursor.execute("INSERT INTO files SELECT * FROM files_old")
        cursor.execute("DROP TABLE files_old")

        conn.commit()

        if logger:
            logger.info("Successfully rolled back PRIMARY KEY change")

    except Exception as e:
        conn.rollback()
        if logger:
            logger.error(f"Downgrade failed: {e}")
        raise
    finally:
        conn.close()
```

### Phase 3: Code Updates

Update all code that queries by `id`:

**Pattern 1: Direct PRIMARY KEY lookups** (no change needed)
```python
# Before and after - lookup by content hash still works via index
file = file_repo.get_file_by_id(content_hash)
```

**Pattern 2: Insert operations** (no change needed)
```python
# FileRepository.insert_file() already handles stable_id generation
# PRIMARY KEY constraint now on stable_id instead of id
file_repo.insert_file(FileCreate(...))
```

**Pattern 3: Duplicate content detection** (update logic)
```python
# Before: Duplicate id causes PRIMARY KEY violation
# After: Can insert multiple records with same id (different stable_id)

# New pattern: Check for existing content for same document/variant
existing = file_repo.get_file_by_content_and_doc(content_hash, doc_id, variant)
if existing:
    logger.info("Version with this content already exists")
    return existing
```

**Files requiring updates**:
- `fastapi_app/lib/file_repository.py` - Add helper methods for content-based queries
- `fastapi_app/plugins/local_sync/plugin.py` - Remove content hash collision error handling
- `fastapi_app/routers/*.py` - Verify all routes work correctly
- Tests - Update to verify content can be shared across documents

### Phase 4: Testing

1. **Unit tests**:
   - Insert multiple records with same content hash
   - Verify lookups by stable_id work
   - Verify lookups by content hash return all matching records
   - Test storage reference counting with shared content

2. **Integration tests**:
   - Import identical content for different documents
   - Create versions with temporarily identical content
   - Verify file serving works correctly
   - Test soft delete with shared content

3. **Migration tests** (in `fastapi_app/lib/migrations/tests/`):
   - Test upgrade with existing data
   - Verify data integrity after migration
   - Test downgrade immediately after upgrade
   - Verify error handling for failed migration

### Phase 5: Deployment

1. **Backup requirement**: Database backup is MANDATORY before migration
2. **Migration timing**: Run during low-traffic period (migration locks table)
3. **Verification**: Query record counts and spot-check file data after migration
4. **Rollback plan**: Keep backup for 24-48 hours, test downgrade procedure

## Benefits After Refactoring

1. **Local sync works correctly**: Can import identical content for different documents
2. **Content deduplication**: Storage layer continues to deduplicate via content hash
3. **Flexible versioning**: Versions can temporarily have identical content
4. **Cleaner schema**: PRIMARY KEY represents logical identity, not physical storage
5. **Future-proof**: Supports any workflow requiring content sharing

## Risks and Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration failure mid-process | Data loss | Atomic transaction with rollback; require backup |
| Foreign key violations | Migration fails | Verify constraints before migration; test on copy |
| Queries break after change | Application errors | Comprehensive test suite; staged rollout |
| Performance regression | Slower queries | Index on `id`; benchmark before/after |
| Content deduplication breaks | Storage bloat | Verify storage_refs table logic; test reference counting |

## Timeline Estimate

- Phase 1 (Analysis): 2-4 hours
- Phase 2 (Migration script): 4-6 hours
- Phase 3 (Code updates): 4-8 hours
- Phase 4 (Testing): 6-8 hours
- Phase 5 (Deployment): 1-2 hours

**Total**: 17-28 hours (2-4 days)

## Related Issues

- [#178](https://github.com/mpilhlt/pdf-tei-editor/issues/178) - Database schema: Change files table PRIMARY KEY from id to stable_id
- Local sync plugin: `fastapi_app/plugins/local_sync/plugin.py:361-373`

## References

- Database schema: `data/db/metadata.db`
- File repository: `fastapi_app/lib/file_repository.py`
- Storage management: `fastapi_app/lib/file_storage.py`
- Reference counting: `fastapi_app/lib/storage_references.py`

## Implementation Summary

Implementation completed. Changes:

1. **Migration script**: [m008_change_primary_key.py](fastapi_app/lib/migrations/versions/m008_change_primary_key.py)
   - Recreates files table with `stable_id` as PRIMARY KEY
   - `id` (content hash) becomes NOT NULL with index for lookups
   - Creates backup before migration, verifies row counts

2. **Schema update**: [db_schema.py](fastapi_app/lib/db_schema.py)
   - Column order changed: `stable_id` first, `id` second
   - Replaced `idx_stable_id` with `idx_content_hash`
   - Schema version bumped to 3.0.0

3. **FileRepository helpers**: [file_repository.py](fastapi_app/lib/file_repository.py)
   - `get_file_by_content_and_doc()`: Find file by content hash for specific doc/variant
   - `get_files_by_content_hash()`: Find all files with a given content hash

4. **Local sync plugin**: [plugin.py](fastapi_app/plugins/local_sync/plugin.py)
   - Changed duplicate detection to use `get_file_by_content_and_doc()` instead of `get_file_by_id()`
   - Prevents incorrect skipping when different documents share content

5. **Migration tests**: [test_migration_008.py](fastapi_app/lib/migrations/tests/test_migration_008.py)
   - Tests for PRIMARY KEY change, data preservation, duplicate content support
   - Tests for downgrade behavior (fails with duplicates, succeeds without)

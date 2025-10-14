# Phase 2: SQLite File Metadata System

**Goal**: Implement database-backed file metadata before migrating file endpoints

## Database Design Principles

- **Reconstructable**: The database does not contain information that cannot be reconstructed from the filesystem (TEI/PDF content). In case of corruption or being outdated after WebDAV sync, it can be rebuilt.
- **Atomic updates**: Costly full rebuilds should be avoided - use atomic updates to keep information current.
- **Sync-ready**: While sync implementation is Phase 6, the schema includes sync tracking columns now:
  - `deleted` - Soft delete marker (replaces `.deleted` files)
  - `local_modified_at` - Change tracking for delta sync
  - `sync_status` - Sync state machine
  - `sync_hash` - Conflict detection
  - See [phase-6-completion.md](phase-6-completion.md) for how this enables 1000x faster sync

**Key Design**: Document-centric model with metadata inheritance. See [schema-design.md](schema-design.md) for complete details.

## Overview

Replace JSON-based file caching with SQLite database:

- Document metadata stored only with PDF files
- TEI files inherit via JOIN
- Multi-collection support via JSON arrays
- Git-style hash-sharded file storage

## Tasks

### 2.1 Database Schema

- [ ] Create `fastapi/lib/db_schema.py`
  - Define `CREATE_FILES_TABLE` SQL (includes sync tracking columns)
  - Define `CREATE_SYNC_METADATA_TABLE` SQL
  - Define `CREATE_INDEXES` list (includes sync indexes)
  - Implement `initialize_database(conn)` function

See [schema-design.md](schema-design.md) for complete schema with sync columns.

### 2.2 Database Manager

- [ ] Create `fastapi/lib/database.py`

```python
class DatabaseManager:
    def __init__(self, db_path: Path, logger=None):
        self.db_path = db_path
        self.logger = logger
        self._ensure_db_exists()

    @contextmanager
    def get_connection(self):
        """Context manager for database connections"""

    @contextmanager
    def transaction(self):
        """Context manager for transactions with auto-commit/rollback"""
```

### 2.3 File Repository

- [ ] Create `fastapi/lib/file_repository.py`

Core methods:

```python
class FileRepository:
    def __init__(self, db_manager: DatabaseManager, logger=None)

    # Basic CRUD (all queries filter deleted = 0 by default)
    def insert_file(self, file_data: Dict[str, Any]) -> str
    def update_file(self, file_id: str, updates: Dict[str, Any])
    def get_file_by_id(self, file_id: str) -> Optional[Dict[str, Any]]
    def delete_file(self, file_id: str)  # Sets deleted = 1 (soft delete)

    # List and filter (exclude deleted files)
    def list_files(self, collection=None, variant=None, file_type=None) -> List[Dict]

    # Document-centric queries (exclude deleted files)
    def get_files_by_doc_id(self, doc_id: str) -> List[Dict]
    def get_pdf_for_document(self, doc_id: str) -> Optional[Dict]
    def get_latest_tei_version(self, doc_id: str) -> Optional[Dict]
    def get_gold_standard(self, doc_id: str) -> Optional[Dict]
    def get_all_versions(self, doc_id: str) -> List[Dict]

    # With metadata inheritance
    def get_file_with_doc_metadata(self, file_id: str) -> Optional[Dict]

    # Sync support (Phase 6, stub now)
    def get_sync_metadata(self, key: str) -> Optional[str]
    def set_sync_metadata(self, key: str, value: str)
    def get_deleted_files(self) -> List[Dict]  # For sync: include deleted = 1
    def mark_deleted(self, file_id: str)  # Soft delete with sync tracking
```

Key implementation details:

- Serialize/deserialize JSON fields (`doc_collections`, `doc_metadata`, `file_metadata`)
- Handle NULL values for inherited fields
- Use JOINs for metadata inheritance queries
- **Always filter `deleted = 0`** in standard queries
- Set `local_modified_at = CURRENT_TIMESTAMP` on insert/update
- Set `sync_status = 'modified'` on content changes

### 2.4 Hash-Based File Storage

- [ ] Update `fastapi/lib/hash_utils.py` (from Phase 1)
  - Already includes `get_file_extension()` and `get_storage_path()`

- [ ] Create `fastapi/lib/file_storage.py`

```python
class FileStorage:
    def __init__(self, data_root: Path, logger=None)

    def save_file(self, content: bytes, file_type: str) -> tuple[str, Path]:
        """Save file, return (hash, path)"""

    def get_file_path(self, file_hash: str, file_type: str) -> Optional[Path]

    def read_file(self, file_hash: str, file_type: str) -> Optional[bytes]

    def delete_file(self, file_hash: str, file_type: str) -> bool
        """Delete file, cleanup empty shard dirs"""

    def get_storage_stats(self) -> dict:
        """Return storage statistics"""
```

Storage pattern: `{data_root}/{hash[:2]}/{hash}{extension}`

Example: `data/ab/abcdef123....tei.xml`

### 2.5 Integration Test

- [ ] Create `fastapi/tests/database.test.js`
  - Test database creation and schema
  - Test file insertion (PDF + TEI)
  - Test document-centric queries
  - Test metadata inheritance via JOIN
  - Test multi-collection support

Python test script approach:

```javascript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

test('should handle document-centric workflow', async () => {
    const { stdout } = await execAsync(`
        python3 -c "
from pathlib import Path
from fastapi.lib.database import DatabaseManager
from fastapi.lib.file_repository import FileRepository
import tempfile

db_dir = Path(tempfile.mkdtemp())
db = DatabaseManager(db_dir)
repo = FileRepository(db)

# Insert PDF with doc metadata
repo.insert_file({
    'id': 'pdf123',
    'filename': 'pdf123.pdf',
    'doc_id': '10.1234/test',
    'file_type': 'pdf',
    'doc_collections': ['corpus1', 'corpus2'],
    'doc_metadata': {'author': 'Test', 'title': 'Paper'}
})

# Insert TEI (inherits metadata)
repo.insert_file({
    'id': 'tei456',
    'filename': 'tei456.tei.xml',
    'doc_id': '10.1234/test',
    'file_type': 'tei',
    'version': 1
})

# Query with inheritance
file = repo.get_file_with_doc_metadata('tei456')
assert 'doc_metadata' in file
assert file['doc_metadata']['author'] == 'Test'

print('OK')
"
    `);

    assert.ok(stdout.includes('OK'));
});
```



## Completion Criteria

Phase 2 is complete when:

- ✅ Database schema creates successfully (files + sync_metadata tables)
- ✅ All indexes created (including sync indexes)
- ✅ File repository can CRUD file metadata
- ✅ Soft delete works (`deleted = 1`, not hard delete)
- ✅ All queries filter `deleted = 0` by default
- ✅ Document-centric queries work correctly
- ✅ Metadata inheritance via JOIN works
- ✅ Hash-based storage saves files correctly
- ✅ Multi-collection support validated
- ✅ Sync tracking columns populated on insert/update
- ✅ Integration test passes

## Sync Benefits (Phase 6)

The sync-ready schema enables dramatic performance improvements in Phase 6:

### Current File-Based Sync Problems
- **O(n) filesystem scan** - Must walk entire directory tree
- **4-8 seconds** to detect "no changes" in 10,000 files
- **30-60 seconds** for 100,000 files
- **.deleted marker files** clutter filesystem

### Database-Driven Sync Benefits
- **O(1) change detection** - Single query: `SELECT COUNT(*) WHERE sync_status != 'synced'`
- **1-5ms** to detect "no changes" (1000x faster)
- **Delta sync** - Only process changed files, not all files
- **Instant conflict detection** - Compare `sync_hash` vs current hash
- **No marker files** - `deleted = 1` column instead

See [phase-6-completion.md](phase-6-completion.md) for complete algorithm and implementation.

## Examples

See [schema-design.md](schema-design.md) for:

- Complete schema with rationale
- Example data (PDF + TEI versions + variants + gold)
- Common query patterns

## Next Phase

→ [Phase 3: Authentication and Configuration APIs](phase-3-auth-config.md)

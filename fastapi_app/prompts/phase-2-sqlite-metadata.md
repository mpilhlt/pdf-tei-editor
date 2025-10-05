# Phase 2: SQLite File Metadata System

**Goal**: Implement database-backed file metadata before migrating file endpoints

- The sqlite database does not contain information that cannot be reconstructed from the TEI in the filesystem, i.e. in case of corruption, deletion or just being outdated after a synchronization with the WebDAv backend, the database can be recreated from scratch.
- this of course is costly and should be avoided - atomic updates should be preferred in order to keep information updated.

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
  - Define `CREATE_FILES_TABLE` SQL
  - Define `CREATE_INDEXES` list
  - Implement `initialize_database(conn)` function

See [schema-design.md](schema-design.md) for complete schema.

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

    # Basic CRUD
    def insert_file(self, file_data: Dict[str, Any]) -> str
    def update_file(self, file_id: str, updates: Dict[str, Any])
    def get_file_by_id(self, file_id: str) -> Optional[Dict[str, Any]]
    def delete_file(self, file_id: str)

    # List and filter
    def list_files(self, collection=None, variant=None, file_type=None) -> List[Dict]

    # Document-centric queries
    def get_files_by_doc_id(self, doc_id: str) -> List[Dict]
    def get_pdf_for_document(self, doc_id: str) -> Optional[Dict]
    def get_latest_tei_version(self, doc_id: str) -> Optional[Dict]
    def get_gold_standard(self, doc_id: str) -> Optional[Dict]
    def get_all_versions(self, doc_id: str) -> List[Dict]

    # With metadata inheritance
    def get_file_with_doc_metadata(self, file_id: str) -> Optional[Dict]
```

Key implementation details:

- Serialize/deserialize JSON fields (`doc_collections`, `doc_metadata`, `file_metadata`)
- Handle NULL values for inherited fields
- Use JOINs for metadata inheritance queries

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

- ✅ Database schema creates successfully
- ✅ File repository can CRUD file metadata
- ✅ Document-centric queries work correctly
- ✅ Metadata inheritance via JOIN works
- ✅ Hash-based storage saves files correctly
- ✅ Multi-collection support validated
- ✅ Integration test passes

## Examples

See [schema-design.md](schema-design.md) for:

- Complete schema with rationale
- Example data (PDF + TEI versions + variants + gold)
- Common query patterns

## Next Phase

→ [Phase 3: Authentication and Configuration APIs](phase-3-auth-config.md)

# Database Architecture

This document describes the database architecture and file metadata management system in the PDF-TEI Editor.

## Overview

The application uses **SQLite** for file metadata storage with a document-centric design. The database stores metadata about PDF and TEI files, their relationships, and sync tracking information. The filesystem contains the actual file content, while the database provides fast querying and relationship management.

## Key Design Principles

### 1. Reconstructable Database

The database does not contain information that cannot be reconstructed from the filesystem (TEI/PDF content). In case of corruption or being outdated after WebDAV sync, it can be rebuilt from the files.

### 2. Document-Centric Model

- **PDF files** store document metadata (collections, metadata, etc.)
- **TEI files** inherit metadata from their associated PDF via `doc_id`
- All files sharing a `doc_id` represent artifacts of the same document

### 3. Soft Deletes

Files are marked as deleted (`deleted = 1`) rather than removed from the database. This:
- Enables sync tracking (know what was deleted since last sync)
- Preserves history for debugging
- Allows undelete operations

### 4. Sync-Ready Schema

While sync implementation is complete, the schema was designed from the start to support efficient synchronization:
- `local_modified_at` - Change tracking for delta sync
- `sync_status` - Sync state machine
- `sync_hash` - Conflict detection
- `deleted` - Soft delete marker (replaces `.deleted` files)

## Database Location

- **Development**: `data/metadata.db`
- **Production**: `data/metadata.db` (configurable via settings)
- **Tests**: Temporary directory for isolation

## Configuration Management

The application uses a two-tier configuration system:

### Default Configuration

Location: `config/` directory (version-controlled)

- `config.json` - Application configuration defaults
- `users.json` - Default user accounts
- `groups.json` - Default user groups
- `collections.json` - Default collections
- `roles.json` - Role definitions

### Runtime Configuration

Location: `data/db/` directory (gitignored)

- `config.json` - Runtime configuration (copied from `config/` on startup)
- `users.json` - User accounts (copied from `config/` on startup)
- `groups.json` - User groups (copied from `config/` on startup)
- `collections.json` - Collections (copied from `config/` on startup)
- `roles.json` - Roles (copied from `config/` on startup)

### Initialization Pattern

On server startup ([fastapi_app/lib/db_init.py](../../fastapi_app/lib/db_init.py)):

1. Check if `data/db/*.json` files exist
2. If missing, copy from `config/*.json`
3. Merge missing keys into `data/db/config.json` (preserves existing values)
4. SQLite databases created on first access (on-demand)

This ensures:
- **Clean branches** - No database file conflicts in git
- **Easy reset** - Delete `data/db/`, restart server
- **Default recovery** - Missing files auto-restore
- **Safe updates** - Preserves user customizations

## Database Schema

### Files Table

The `files` table stores all file metadata:

```sql
CREATE TABLE files (
    -- Primary key
    id TEXT PRIMARY KEY,                -- SHA-256 content hash (64 chars)

    -- Stable ID for API responses
    stable_id TEXT,                     -- Short stable identifier (6-12 chars)

    -- File identity
    file_type TEXT NOT NULL,            -- 'pdf' | 'tei-xml'
    doc_id TEXT NOT NULL,               -- Document identifier (groups related files)

    -- Document metadata (stored only on PDF files)
    doc_collections TEXT,               -- JSON array: ["collection1", "collection2"]
    doc_metadata TEXT,                  -- JSON object: document-level metadata

    -- File-specific metadata
    file_metadata TEXT,                 -- JSON object: file-specific metadata
    variant_id TEXT,                    -- Variant identifier (e.g., "translation-fr")
    is_gold_standard INTEGER DEFAULT 0, -- Boolean: 1 for gold standard TEI files

    -- Filesystem location
    storage_path TEXT NOT NULL,         -- Relative path in data directory

    -- Sync tracking
    deleted INTEGER DEFAULT 0,          -- Soft delete: 1 = deleted
    local_modified_at TEXT,             -- ISO timestamp of last local change
    sync_status TEXT,                   -- Sync state: 'synced'|'pending'|'conflict'
    sync_hash TEXT,                     -- Hash for conflict detection

    -- Audit timestamps
    created_at TEXT NOT NULL,           -- ISO timestamp
    updated_at TEXT NOT NULL            -- ISO timestamp
)
```

**Indexes:**

```sql
CREATE INDEX idx_files_doc_id ON files(doc_id);
CREATE INDEX idx_files_file_type ON files(file_type);
CREATE INDEX idx_files_deleted ON files(deleted);
CREATE INDEX idx_files_sync_status ON files(sync_status);
CREATE INDEX idx_files_stable_id ON files(stable_id);
```

### Sync Metadata Table

Stores WebDAV sync state:

```sql
CREATE TABLE sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
```

Used for tracking:
- Last sync timestamp
- Sync server URL
- Sync credentials (encrypted)

### Storage References Table

Tracks filesystem references for safe cleanup:

```sql
CREATE TABLE storage_references (
    hash_prefix TEXT,               -- First 2 chars of hash (sharding)
    content_hash TEXT,              -- Full SHA-256 hash
    reference_count INTEGER,        -- Number of files referencing this hash
    PRIMARY KEY (hash_prefix, content_hash)
)
```

Enables safe deletion:
- Only delete filesystem files when `reference_count = 0`
- Multiple database records can reference same file content
- Git-style hash-sharded storage (`data/files/ab/cd/abcd...`)

## Database Components

### DatabaseManager

Location: [fastapi_app/lib/database.py](../../fastapi_app/lib/database.py)

Provides connection management and transactions:

```python
class DatabaseManager:
    def __init__(self, db_path: Path, logger=None):
        """Initialize database manager and ensure schema exists."""

    @contextmanager
    def get_connection(self) -> sqlite3.Connection:
        """Context manager for database connections."""

    @contextmanager
    def transaction(self) -> sqlite3.Connection:
        """Context manager for transactions with auto-commit/rollback."""
```

**Features:**
- Thread-safe connection management
- Automatic schema initialization
- Row factory for dict-like access
- Foreign keys enabled
- Write-Ahead Logging (WAL) mode for better performance

**Usage:**

```python
# Simple query
with db_manager.get_connection() as conn:
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM files WHERE deleted = 0")
    files = cursor.fetchall()

# Transaction
with db_manager.transaction() as conn:
    cursor = conn.cursor()
    cursor.execute("INSERT INTO files ...")
    cursor.execute("UPDATE files ...")
    # Auto-commit on exit, rollback on exception
```

### FileRepository

Location: [fastapi_app/lib/file_repository.py](../../fastapi_app/lib/file_repository.py)

Provides high-level CRUD operations with Pydantic models:

```python
class FileRepository:
    def __init__(self, db_manager: DatabaseManager, logger=None):
        """Initialize repository with storage reference counting."""
```

#### Core CRUD Operations

All queries **filter `deleted = 0` by default** unless explicitly requesting deleted files.

```python
# Create
def insert_file(self, file_data: FileCreate) -> FileMetadata:
    """Insert new file record. Returns created FileMetadata."""

# Read
def get_file_by_id(self, file_id: str) -> Optional[FileMetadata]:
    """Get file by full SHA-256 hash (64 chars)."""

def get_file_by_stable_id(self, stable_id: str) -> Optional[FileMetadata]:
    """Get file by short stable ID (6-12 chars)."""

def get_file_by_id_or_stable_id(self, file_id: str) -> Optional[FileMetadata]:
    """Get file by either stable_id or full hash."""

# Update
def update_file(self, file_id: str, updates: FileUpdate) -> FileMetadata:
    """Update file record. Returns updated FileMetadata."""

# Delete (soft)
def delete_file(self, file_id: str) -> None:
    """Mark file as deleted (sets deleted = 1)."""
```

#### Document-Centric Queries

```python
def get_files_by_doc_id(self, doc_id: str) -> List[FileMetadata]:
    """Get all files for a document (excludes deleted)."""

def get_pdf_for_document(self, doc_id: str) -> Optional[FileMetadata]:
    """Get the PDF file for a document."""

def get_latest_tei_version(self, doc_id: str) -> Optional[FileMetadata]:
    """Get most recent TEI version (excludes gold standard)."""

def get_gold_standard(self, doc_id: str) -> Optional[FileMetadata]:
    """Get gold standard TEI file for document."""

def get_all_versions(self, doc_id: str) -> List[FileMetadata]:
    """Get all TEI versions (excludes gold standard and deleted)."""
```

#### Metadata Inheritance

TEI files inherit `doc_collections` and `doc_metadata` from their PDF:

```python
def get_file_with_doc_metadata(
    self,
    file_id: str
) -> Optional[FileWithDocMetadata]:
    """
    Get file with inherited document metadata.

    For TEI files, returns both:
    - doc_collections/doc_metadata (NULL for TEI)
    - inherited_doc_collections/inherited_doc_metadata (from PDF via JOIN)
    """
```

**SQL Implementation:**

```sql
SELECT
    f.*,
    pdf.doc_collections as inherited_doc_collections,
    pdf.doc_metadata as inherited_doc_metadata
FROM files f
LEFT JOIN files pdf ON f.doc_id = pdf.doc_id AND pdf.file_type = 'pdf'
WHERE f.id = ? AND f.deleted = 0
```

#### List and Filter

```python
def list_files(
    self,
    collection: Optional[str] = None,
    variant: Optional[str] = None,
    file_type: Optional[str] = None,
    include_deleted: bool = False
) -> List[FileMetadata]:
    """
    List files with optional filters.

    Args:
        collection: Filter by collection ID
        variant: Filter by variant_id
        file_type: Filter by file_type ('pdf' | 'tei-xml')
        include_deleted: Include soft-deleted files
    """
```

#### Sync Support

```python
def get_deleted_files(self) -> List[FileMetadata]:
    """Get files marked as deleted (for sync reconciliation)."""

def mark_deleted(self, file_id: str) -> None:
    """Soft delete with sync tracking."""

def update_sync_status(self, file_id: str, updates: SyncUpdate) -> None:
    """Update sync tracking fields."""

def get_sync_metadata(self, key: str) -> Optional[str]:
    """Get sync metadata value."""

def set_sync_metadata(self, key: str, value: str) -> None:
    """Set sync metadata value."""
```

### StorageReferenceManager

Location: [fastapi_app/lib/storage_references.py](../../fastapi_app/lib/storage_references.py)

Manages reference counting for safe filesystem cleanup:

```python
class StorageReferenceManager:
    def increment_reference(self, content_hash: str) -> None:
        """Increment reference count when file is added."""

    def decrement_reference(self, content_hash: str) -> bool:
        """
        Decrement reference count when file is deleted.
        Returns True if safe to delete file from filesystem.
        """
```

**Usage:**

```python
# When creating file
file_repo.insert_file(file_data)
ref_manager.increment_reference(file_data.id)

# When deleting file
file_repo.delete_file(file_id)
can_delete = ref_manager.decrement_reference(file_id)
if can_delete:
    # Safe to delete from filesystem
    os.remove(storage_path)
```

## Pydantic Models

Location: [fastapi_app/lib/models.py](../../fastapi_app/lib/models.py)

Type-safe models for database operations:

```python
class FileMetadata(BaseModel):
    """Complete file record from database."""
    id: str
    stable_id: Optional[str]
    file_type: Literal['pdf', 'tei-xml']
    doc_id: str
    doc_collections: List[str]
    doc_metadata: dict
    file_metadata: dict
    variant_id: Optional[str]
    is_gold_standard: bool
    storage_path: str
    deleted: bool
    local_modified_at: Optional[datetime]
    sync_status: Optional[str]
    sync_hash: Optional[str]
    created_at: datetime
    updated_at: datetime

class FileCreate(BaseModel):
    """Model for creating new file records."""
    id: str  # SHA-256 hash
    stable_id: Optional[str]
    file_type: Literal['pdf', 'tei-xml']
    doc_id: str
    # ... (subset of FileMetadata)

class FileUpdate(BaseModel):
    """Model for updating file records (all fields optional)."""
    doc_collections: Optional[List[str]]
    doc_metadata: Optional[dict]
    file_metadata: Optional[dict]
    # ...

class FileWithDocMetadata(FileMetadata):
    """File with inherited document metadata from PDF."""
    inherited_doc_collections: List[str]
    inherited_doc_metadata: dict
```

## File Storage Layout

Files are stored using Git-style hash sharding:

```
data/
├── files/
│   ├── ab/
│   │   ├── cd/
│   │   │   └── abcd1234...5678  # Full SHA-256 hash
│   │   └── ef/
│   │       └── abef9876...4321
│   └── 12/
│       └── 34/
│           └── 1234abcd...ef56
└── metadata.db
```

**Benefits:**
- Prevents directory with too many files (filesystem limits)
- Fast lookups using hash prefix
- Content-addressable storage (deduplication)

## Database Initialization

### Application Startup

Location: [fastapi_app/main.py](../../fastapi_app/main.py)

```python
from .lib.db_init import ensure_db_initialized

# Initialize configuration and database
ensure_db_initialized()
```

### For Tests

Tests use isolated temporary directories:

```python
import tempfile
from pathlib import Path
from fastapi_app.lib.db_init import initialize_db_from_config

# Create temporary database
with tempfile.TemporaryDirectory() as tmpdir:
    db_dir = Path(tmpdir) / "db"
    config_dir = Path("config")

    initialize_db_from_config(config_dir, db_dir)

    # Run tests with isolated database
    db_manager = DatabaseManager(db_dir / "metadata.db")
```

## Query Patterns

### Document Grouping

Get all files for a document with inherited metadata:

```python
files = file_repo.get_files_by_doc_id("doc123")
pdf = file_repo.get_pdf_for_document("doc123")
gold = file_repo.get_gold_standard("doc123")
versions = file_repo.get_all_versions("doc123")
```

### Collection Filtering

Find all documents in a collection:

```python
files = file_repo.list_files(collection="manuscripts")

# Documents appear if ANY collection matches
# doc_collections = ["manuscripts", "letters"] matches collection="manuscripts"
```

### Metadata Inheritance Example

```python
# PDF file stores metadata
pdf = FileMetadata(
    id="abc123...",
    file_type="pdf",
    doc_id="doc1",
    doc_collections=["manuscripts"],
    doc_metadata={"title": "Medieval Text"}
)

# TEI file inherits metadata
tei = file_repo.get_file_with_doc_metadata("def456...")
# tei.doc_collections = None (TEI doesn't store)
# tei.inherited_doc_collections = ["manuscripts"] (from PDF)
# tei.inherited_doc_metadata = {"title": "Medieval Text"}
```

## Performance Considerations

### Indexes

Critical indexes for common queries:
- `idx_files_doc_id` - Document grouping
- `idx_files_file_type` - File type filtering
- `idx_files_deleted` - Exclude deleted files
- `idx_files_stable_id` - API lookups

### WAL Mode

Write-Ahead Logging enables:
- Concurrent readers with single writer
- Better performance for write-heavy workloads
- Crash recovery

### Connection Pooling

Single DatabaseManager instance per application:
- **Connection Pooling**: Implemented using `queue.Queue` to reuse connections and reduce file open/close overhead.
- **Singleton Pattern**: `_DatabaseManagerSingleton` ensures one pool per database file.
- **Concurrency**: Optimized for high concurrency with WAL mode and explicit transaction management.
- **Thread-safe**: Context managers handle connection checkout/return and transaction boundaries.

## Migration and Maintenance

### Database Rebuild

If database becomes corrupted or outdated:

```bash
# Remove database
rm data/metadata.db

# Restart server (auto-recreates from filesystem)
npm run start:dev
```

### Schema Updates

Schema changes require:
1. Update `fastapi_app/lib/db_schema.py`
2. Add migration logic in `initialize_database()`
3. Test with clean database and existing database

### Backup

```bash
# Backup database
cp data/metadata.db data/metadata.db.backup

# Backup configuration
cp -r data/db/ data/db.backup/
```

## Testing

### Unit Tests

Location: `tests/unit/fastapi/`

```bash
# Database initialization tests
uv run python -m pytest tests/unit/fastapi/test_db_init.py -v

# File repository tests
uv run python -m pytest tests/unit/fastapi/test_file_repository.py -v
```

### Test Isolation

Tests use temporary directories:

```python
def test_file_operations():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        db_manager = DatabaseManager(db_path)
        file_repo = FileRepository(db_manager)

        # Test operations in isolation
        # ...
```

## Related Documentation

- [Architecture Overview](architecture.md) - Complete system architecture
- [Configuration Management](configuration.md) - Config files and CLI
- [Access Control](access-control.md) - RBAC and collection-based access
- [Collections](collections.md) - Collection management system
- [Testing](testing.md) - Testing infrastructure

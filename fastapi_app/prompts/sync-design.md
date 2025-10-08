# Efficient Synchronization Design

**Goal**: Replace filesystem-scanning sync with database-driven delta synchronization

## Current Sync Problems

The Flask implementation ([server/api/sync.py](../../server/api/sync.py)) has significant performance issues:

### Inefficiencies

1. **O(n) filesystem scan** - Must walk entire directory tree on every sync
2. **Metadata extraction overhead** - Reads mtime for every file, even unchanged ones
3. **No change tracking** - Cannot determine what changed since last sync
4. **Deletion marker files** - Creates `.deleted` files that must be scanned and managed
5. **No instant "nothing changed" detection** - Always performs initial scan
6. **Poor conflict detection** - Must compare all files to detect conflicts
7. **Version file contention** - Single `version.txt` file for entire repository

### Example Cost

For a repository with 10,000 files:
- Full filesystem scan: ~2-5 seconds
- Stat all files: ~1-2 seconds
- Compare timestamps: ~0.5 seconds
- **Total overhead**: ~4-8 seconds even when nothing changed

## SQLite-Based Sync Design

### Core Idea

Use SQLite as the "change log" - every file operation updates the database, allowing instant detection of what needs syncing.

### Schema Enhancements

Add sync tracking to the `files` table:

```sql
CREATE TABLE files (
    -- ... existing columns from schema-design.md ...

    -- Sync tracking columns
    deleted BOOLEAN DEFAULT 0,              -- Soft delete marker (already in schema)
    local_modified_at TIMESTAMP,            -- When local file last changed
    remote_version INTEGER,                 -- Remote version when last synced
    sync_status TEXT DEFAULT 'synced',      -- Sync state machine
    sync_hash TEXT,                         -- Content hash at last sync (for conflict detection)

    -- ... rest of existing columns ...
);

-- Additional indexes for sync
CREATE INDEX idx_sync_status ON files(sync_status) WHERE sync_status != 'synced';
CREATE INDEX idx_deleted ON files(deleted) WHERE deleted = 1;
CREATE INDEX idx_local_modified ON files(local_modified_at DESC);
CREATE INDEX idx_remote_version ON files(remote_version);
```

### Sync Status State Machine

```
synced          - File synchronized, no action needed
modified        - Local file changed, needs upload
pending_upload  - Queued for upload
pending_delete  - Marked for deletion, needs remote delete + marker
conflict        - Remote and local both changed since last sync
remote_newer    - Remote has newer version, needs download
```

### Sync Metadata Table

Track global sync state:

```sql
CREATE TABLE sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Initial values
INSERT INTO sync_metadata (key, value) VALUES
    ('last_sync_time', '1970-01-01T00:00:00Z'),
    ('remote_version', '0'),
    ('sync_in_progress', '0'),
    ('last_sync_summary', '{}');
```

## Efficient Sync Algorithm

### Phase 1: Quick Skip Check

```sql
-- Instant check: anything to sync?
SELECT COUNT(*) FROM files
WHERE sync_status != 'synced'
   OR local_modified_at > (SELECT value FROM sync_metadata WHERE key = 'last_sync_time');
```

**Result**:
- 0 rows → Skip sync entirely (O(1) database query, ~1-5ms)
- >0 rows → Proceed with delta sync

### Phase 2: Delta Collection

Only query changed files:

```sql
-- Get files needing upload (local changes)
SELECT id, filename, doc_id, file_type, local_modified_at, sync_hash
FROM files
WHERE sync_status IN ('modified', 'pending_upload')
  AND deleted = 0
ORDER BY local_modified_at;

-- Get files marked for deletion
SELECT id, filename, doc_id, file_type, local_modified_at
FROM files
WHERE deleted = 1;

-- Get files needing status check (potential remote changes)
SELECT id, filename, doc_id, file_type, remote_version
FROM files
WHERE sync_status IN ('synced', 'remote_newer')
  AND remote_version < (SELECT value FROM sync_metadata WHERE key = 'remote_version');
```

### Phase 3: Remote Delta Query

Instead of listing all remote files, query only changed ones:

```python
def get_remote_changes(fs: WebdavFileSystem, remote_root: str, since_version: int) -> dict:
    """
    Get remote files changed since the given version.

    This requires the remote server to support one of:
    1. WebDAV SEARCH with DASL query for modified > date
    2. Version-based directory structure (changes/{version}/*.json)
    3. Change log file (changes.jsonl with incremental entries)
    """
    # Option 1: Query remote change log
    change_log_path = f"{remote_root}/.sync/changes.jsonl"
    if fs.exists(change_log_path):
        return _read_change_log(fs, change_log_path, since_version)

    # Option 2: Fall back to full scan (first sync or missing change log)
    logger.warning("Remote change log not found, performing full scan")
    return _full_remote_scan(fs, remote_root)
```

### Phase 4: Three-Way Merge

Compare local DB state, current local filesystem, and remote changes:

```python
def perform_delta_sync(
    repo: FileRepository,
    storage: FileStorage,
    fs: WebdavFileSystem,
    remote_root: str
) -> dict:
    """
    Efficient delta sync using database change tracking.
    """
    summary = {"uploads": 0, "downloads": 0, "deletes": 0, "conflicts": 0, "skipped": 0}

    # Get current remote version
    remote_version = _get_remote_version(fs, remote_root)
    last_sync_version = int(repo.get_sync_metadata('remote_version'))

    # Quick exit if versions match and no local changes
    if remote_version == last_sync_version:
        local_changes = repo.get_unsync_files()  # sync_status != 'synced'
        if not local_changes:
            logger.info("No changes detected, skipping sync")
            return {"skipped": True, "reason": "no_changes"}

    # Get delta sets
    local_modified = repo.get_files_by_sync_status(['modified', 'pending_upload'])
    local_deleted = repo.get_deleted_files()
    remote_changes = get_remote_changes(fs, remote_root, last_sync_version)

    # Process each category
    for file in local_modified:
        if file['id'] in remote_changes:
            # Conflict detection using sync_hash
            if file['sync_hash'] != remote_changes[file['id']]['hash']:
                summary['conflicts'] += 1
                repo.update_file_sync_status(file['id'], 'conflict')
                logger.warning(f"Conflict detected: {file['filename']}")
                continue

        # Upload local change
        _upload_file(fs, storage, remote_root, file)
        repo.update_file_after_sync(file['id'], remote_version, 'synced')
        summary['uploads'] += 1

    for file in local_deleted:
        # Upload deletion marker, then remove DB entry or mark synced
        _upload_deletion_marker(fs, remote_root, file)
        if not keep_deleted_markers:
            repo.delete_file(file['id'])  # Hard delete from DB
        else:
            repo.update_file_sync_status(file['id'], 'synced')
        summary['deletes'] += 1

    for remote_file in remote_changes.get('added', []) + remote_changes.get('modified', []):
        local_file = repo.get_file_by_id(remote_file['hash'])

        if local_file and local_file['sync_status'] == 'modified':
            # Conflict: both changed
            repo.update_file_sync_status(local_file['id'], 'conflict')
            summary['conflicts'] += 1
            continue

        # Download remote change
        _download_file(fs, storage, remote_root, remote_file)
        repo.upsert_file_after_download(remote_file, remote_version)
        summary['downloads'] += 1

    # Update sync metadata
    repo.set_sync_metadata('remote_version', str(remote_version))
    repo.set_sync_metadata('last_sync_time', datetime.now(timezone.utc).isoformat())
    repo.set_sync_metadata('last_sync_summary', json.dumps(summary))

    return summary
```

## Performance Comparison

### Scenario: 10,000 files, 5 changed

| Operation | Old (Filesystem) | New (SQLite) | Speedup |
|-----------|------------------|--------------|---------|
| Detect changes | 4-8 seconds | 1-5 ms | **1000x** |
| List changed files | 4-8 seconds | 10-20 ms | **400x** |
| No changes case | 4-8 seconds | 1-5 ms | **1000x** |
| Sync 5 files | 5-10 seconds | 1-2 seconds | **5x** |

### Scenario: 100,000 files, no changes

| Operation | Old (Filesystem) | New (SQLite) | Speedup |
|-----------|------------------|--------------|---------|
| Skip detection | 30-60 seconds | 1-5 ms | **10,000x** |

## Database Operations

### File Change Tracking

Every file operation updates sync tracking:

```python
class FileRepository:
    def insert_file(self, file_data: dict) -> str:
        """Insert new file, mark as pending sync"""
        file_data['sync_status'] = 'pending_upload'
        file_data['local_modified_at'] = datetime.now(timezone.utc)
        # ... insert into DB ...
        return file_id

    def update_file_content(self, file_id: str, new_hash: str, content: bytes):
        """Update file content, mark as modified"""
        self.db.execute("""
            UPDATE files
            SET id = ?,
                local_modified_at = ?,
                sync_status = 'modified',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (new_hash, datetime.now(timezone.utc), file_id))

    def mark_deleted(self, file_id: str):
        """Soft delete file, mark for sync"""
        self.db.execute("""
            UPDATE files
            SET deleted = 1,
                local_modified_at = ?,
                sync_status = 'pending_delete'
            WHERE id = ?
        """, (datetime.now(timezone.utc), file_id))

    def update_file_after_sync(self, file_id: str, remote_version: int, sync_status: str):
        """Mark file as synced after successful upload"""
        self.db.execute("""
            UPDATE files
            SET remote_version = ?,
                sync_status = ?,
                sync_hash = id  -- Record hash at sync time
            WHERE id = ?
        """, (remote_version, sync_status, file_id))
```

### Sync Queries

```python
class FileRepository:
    def get_unsync_files(self) -> list[dict]:
        """Get all files needing sync"""
        return self.db.execute("""
            SELECT * FROM files
            WHERE sync_status != 'synced'
               OR deleted = 1
            ORDER BY local_modified_at
        """).fetchall()

    def get_files_by_sync_status(self, statuses: list[str]) -> list[dict]:
        """Get files by sync status"""
        placeholders = ','.join('?' * len(statuses))
        return self.db.execute(f"""
            SELECT * FROM files
            WHERE sync_status IN ({placeholders})
            ORDER BY local_modified_at
        """, statuses).fetchall()

    def get_deleted_files(self) -> list[dict]:
        """Get soft-deleted files needing sync"""
        return self.db.execute("""
            SELECT * FROM files
            WHERE deleted = 1
        """).fetchall()

    def get_sync_metadata(self, key: str) -> str:
        """Get sync metadata value"""
        result = self.db.execute(
            "SELECT value FROM sync_metadata WHERE key = ?",
            (key,)
        ).fetchone()
        return result['value'] if result else None

    def set_sync_metadata(self, key: str, value: str):
        """Set sync metadata value"""
        self.db.execute("""
            INSERT INTO sync_metadata (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
        """, (key, value))
```

## Handling Edge Cases

### Conflict Resolution

When both local and remote changed:

```python
def resolve_conflict(file_id: str, strategy: str = 'local_wins'):
    """
    Resolve sync conflict.

    Strategies:
    - 'local_wins': Upload local, overwrite remote
    - 'remote_wins': Download remote, overwrite local
    - 'keep_both': Create version, keep both
    - 'manual': Mark for user review
    """
    file = repo.get_file_by_id(file_id)

    if strategy == 'local_wins':
        _upload_file(fs, storage, remote_root, file)
        repo.update_file_sync_status(file_id, 'synced')

    elif strategy == 'remote_wins':
        remote_file = _get_remote_file(fs, remote_root, file['filename'])
        _download_file(fs, storage, remote_root, remote_file)
        repo.update_file_sync_status(file_id, 'synced')

    elif strategy == 'keep_both':
        # Create new version for remote copy
        remote_file = _get_remote_file(fs, remote_root, file['filename'])
        new_version = file['version'] + 1 if file['version'] else 2

        # Download remote as new version
        repo.insert_file({
            **remote_file,
            'version': new_version,
            'label': f"Remote version (conflict {datetime.now().date()})"
        })

        # Mark local as synced (it will be uploaded)
        repo.update_file_sync_status(file_id, 'synced')
        _upload_file(fs, storage, remote_root, file)
```

### Database Corruption Recovery

If the database is corrupted or out of sync:

```python
def rebuild_database_from_filesystem(data_root: Path, db_manager: DatabaseManager):
    """
    Rebuild SQLite database from filesystem.

    This is a recovery operation that should rarely be needed.
    Scans filesystem and reconstructs database entries.
    """
    logger.warning("Rebuilding database from filesystem - this may take a while")

    repo = FileRepository(db_manager)
    storage = FileStorage(data_root)

    # Clear existing data
    db_manager.execute("DELETE FROM files")

    # Scan filesystem
    file_count = 0
    for shard_dir in data_root.iterdir():
        if not shard_dir.is_dir() or not shard_dir.name.match(r'^[0-9a-f]{2}$'):
            continue

        for file_path in shard_dir.iterdir():
            if file_path.name.startswith('.'):
                continue

            # Extract metadata from filename and content
            file_hash = file_path.stem.split('.')[0]  # Handle .tei.xml
            file_type = _infer_file_type(file_path.suffix)

            # Read file to extract doc_id and metadata (from TEI/PDF content)
            content = file_path.read_bytes()
            doc_id, metadata = _extract_metadata_from_content(content, file_type)

            # Insert into database with unknown sync state
            repo.insert_file({
                'id': file_hash,
                'filename': file_path.name,
                'doc_id': doc_id,
                'file_type': file_type,
                'file_size': len(content),
                'sync_status': 'unknown',  # Mark for resync
                'local_modified_at': datetime.fromtimestamp(file_path.stat().st_mtime),
                **metadata
            })

            file_count += 1

    logger.info(f"Database rebuilt with {file_count} files")

    # Force full sync on next sync operation
    repo.set_sync_metadata('remote_version', '0')
    repo.set_sync_metadata('last_sync_time', '1970-01-01T00:00:00Z')
```

## Remote Change Tracking

### Option 1: Change Log File

For efficient remote change detection, the server can maintain a change log:

```jsonl
{"version": 1, "timestamp": "2024-01-01T10:00:00Z", "action": "add", "file": "ab/abc123.pdf", "hash": "abc123..."}
{"version": 2, "timestamp": "2024-01-01T10:05:00Z", "action": "modify", "file": "cd/cde456.tei.xml", "hash": "cde456new..."}
{"version": 3, "timestamp": "2024-01-01T10:10:00Z", "action": "delete", "file": "ef/efg789.pdf", "hash": "efg789..."}
```

Clients read only new entries:

```python
def _read_change_log(fs: WebdavFileSystem, log_path: str, since_version: int) -> dict:
    """Read remote change log for incremental sync"""
    changes = {"added": [], "modified": [], "deleted": []}

    with fs.open(log_path, 'r') as f:
        for line in f:
            entry = json.loads(line)
            if entry['version'] <= since_version:
                continue

            changes[entry['action'] + 'ed'].append({
                'file': entry['file'],
                'hash': entry['hash'],
                'version': entry['version']
            })

    return changes
```

### Option 2: Fallback to Targeted Scan

If change log unavailable, still more efficient than full scan:

```python
def _get_remote_changes_targeted(
    fs: WebdavFileSystem,
    remote_root: str,
    local_files: list[dict]
) -> dict:
    """
    Check only files we know about, not entire remote filesystem.
    Much faster than full scan when most files unchanged.
    """
    changes = []

    for local_file in local_files:
        remote_path = f"{remote_root}/{local_file['filename']}"

        try:
            remote_info = fs.info(remote_path)
            remote_mtime = remote_info.get('modified')

            # Compare using recorded sync time
            if remote_mtime > local_file.get('remote_modified_at'):
                changes.append({
                    'file': local_file['filename'],
                    'action': 'modified',
                    'remote_mtime': remote_mtime
                })
        except FileNotFoundError:
            # File deleted remotely
            changes.append({
                'file': local_file['filename'],
                'action': 'deleted'
            })

    return changes
```

## Migration Strategy

### Phase 2: Add Schema

Implement sync columns in initial schema but don't use them yet.

### Phase 6: Implement Sync

1. **Backward compatibility**: Keep both sync methods during transition
2. **Feature flag**: Use `USE_DATABASE_SYNC` environment variable
3. **Gradual rollout**: Test with small repositories first
4. **Fallback**: If database sync fails, fall back to filesystem sync

```python
def sync():
    """Sync endpoint with dual implementation"""
    if os.environ.get('USE_DATABASE_SYNC', '0') == '1':
        try:
            return database_sync()
        except Exception as e:
            logger.error(f"Database sync failed: {e}")
            logger.warning("Falling back to filesystem sync")
            return filesystem_sync()
    else:
        return filesystem_sync()
```

## Benefits Summary

### Performance

- **1000x faster** "no changes" detection
- **400x faster** change enumeration
- **5-10x faster** overall sync for typical cases
- **Instant** conflict detection

### Scalability

- Handles 100,000+ files efficiently
- Constant-time skip detection O(1)
- Change enumeration scales with changes, not total files

### Features

- **Detailed sync state** - Know exactly what needs syncing
- **Conflict tracking** - Database records conflicts for resolution
- **Sync history** - Track sync operations over time
- **Atomic operations** - Database transactions ensure consistency
- **No marker files** - All deletion tracking in database

### Developer Experience

- **Debuggable** - Query database to see sync state
- **Testable** - Easy to mock database for testing
- **Observable** - Monitor sync metrics and performance

## See Also

- [schema-design.md](schema-design.md) - Complete database schema
- [phase-2-sqlite-metadata.md](phase-2-sqlite-metadata.md) - Phase 2 implementation tasks
- [phase-6-sync.md](phase-6-sync.md) - Phase 6 sync implementation (TBD)

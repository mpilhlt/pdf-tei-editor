"""
Remote Metadata Manager for WebDAV synchronization.

Manages the shared metadata.db file on the WebDAV server, enabling:
- Database-driven sync without filesystem scanning
- Deletion tracking via database flags (no .deleted marker files)
- Metadata synchronization between instances
- O(1) change detection queries
"""

import gc
import json
import os
import sqlite3
import tempfile
import time
import shutil
from pathlib import Path
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from contextlib import contextmanager
from webdav4.fsspec import WebdavFileSystem


# Remote database schema (shared on WebDAV server)
REMOTE_SCHEMA = """
CREATE TABLE IF NOT EXISTS file_metadata (
    -- Identity
    id TEXT PRIMARY KEY,              -- Content hash (SHA-256)
    stable_id TEXT UNIQUE NOT NULL,   -- Stable short ID
    filename TEXT NOT NULL,

    -- Document organization
    doc_id TEXT NOT NULL,
    doc_id_type TEXT DEFAULT 'doi',

    -- File classification
    file_type TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER,

    -- File-specific
    label TEXT,
    variant TEXT,
    version INTEGER DEFAULT 1,
    is_gold_standard BOOLEAN DEFAULT 0,

    -- Metadata (JSON)
    doc_collections TEXT,             -- ["corpus1", "corpus2"]
    doc_metadata TEXT,                -- {author, title, ...}
    file_metadata TEXT,               -- {extraction_method, ...}

    -- Deletion (replaces .deleted marker files!)
    deleted BOOLEAN DEFAULT 0,

    -- Version tracking
    remote_version INTEGER,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_doc_id ON file_metadata(doc_id);
CREATE INDEX IF NOT EXISTS idx_stable_id ON file_metadata(stable_id);
CREATE INDEX IF NOT EXISTS idx_deleted ON file_metadata(deleted) WHERE deleted = 1;

CREATE TABLE IF NOT EXISTS sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


class RemoteMetadataManager:
    """
    Manages shared metadata.db on WebDAV server.

    This manager handles:
    - Downloading/uploading metadata.db to/from WebDAV
    - Querying remote file metadata
    - Tracking deletions via database (no marker files)
    - Managing sync metadata (version, timestamps)
    """

    def __init__(
        self,
        webdav_config: Dict[str, str],
        logger=None
    ):
        """
        Initialize remote metadata manager.

        Args:
            webdav_config: Dict with 'base_url', 'username', 'password', 'remote_root'
            logger: Optional logger instance
        """
        self.logger = logger
        self.webdav_config = webdav_config
        self.remote_root = webdav_config['remote_root'].rstrip('/')

        # Initialize WebDAV filesystem
        self.fs = WebdavFileSystem(
            webdav_config['base_url'],
            auth=(webdav_config['username'], webdav_config['password'])
        )

        self.remote_db_path = f"{self.remote_root}/metadata.db"
        self.local_db_conn: Optional[sqlite3.Connection] = None
        self.temp_db_path: Optional[Path] = None

    def download(self) -> Path:
        """
        Download metadata.db from WebDAV to temporary file.

        Creates database with schema if it doesn't exist on remote.

        Returns:
            Path to temporary database file

        Raises:
            Exception: If download fails
        """
        try:
            # Create temporary file for downloaded database
            temp_fd, temp_path = tempfile.mkstemp(suffix='.db', prefix='remote_metadata_')
            self.temp_db_path = Path(temp_path)

            if self.fs.exists(self.remote_db_path):
                if self.logger:
                    self.logger.info(f"Downloading remote metadata.db from {self.remote_db_path}")

                # Download remote database
                with self.fs.open(self.remote_db_path, 'rb') as remote_file:
                    with open(self.temp_db_path, 'wb') as local_file:
                        shutil.copyfileobj(remote_file, local_file)

                if self.logger:
                    self.logger.info(f"Downloaded to {self.temp_db_path}")
            else:
                if self.logger:
                    self.logger.info("Remote metadata.db not found, creating new database")

                # Create new database with schema
                conn = sqlite3.connect(self.temp_db_path)
                try:
                    conn.executescript(REMOTE_SCHEMA)
                    # Initialize version
                    conn.execute(
                        "INSERT INTO sync_metadata (key, value) VALUES (?, ?)",
                        ('version', '1')
                    )
                    conn.commit()
                finally:
                    conn.close()

            return self.temp_db_path

        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to download remote metadata: {e}")
            raise

    def upload(self, local_path: Path) -> None:
        """
        Upload metadata.db from local file to WebDAV.

        Args:
            local_path: Path to local database file to upload

        Raises:
            Exception: If upload fails
        """
        try:
            if self.logger:
                self.logger.info(f"Uploading metadata.db to {self.remote_db_path}")

            # Ensure remote directory exists
            remote_dir = self.remote_root
            if not self.fs.exists(remote_dir):
                self.fs.makedirs(remote_dir)

            # Upload database file
            with open(local_path, 'rb') as local_file:
                with self.fs.open(self.remote_db_path, 'wb') as remote_file:
                    shutil.copyfileobj(local_file, remote_file)

            if self.logger:
                self.logger.info(f"Uploaded metadata.db successfully")

        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to upload remote metadata: {e}")
            raise

    def connect(self, db_path: Path) -> None:
        """
        Connect to downloaded database.

        Args:
            db_path: Path to database file
        """
        if self.local_db_conn:
            self.local_db_conn.close()

        self.local_db_conn = sqlite3.connect(db_path)
        self.local_db_conn.row_factory = sqlite3.Row

    def disconnect(self) -> None:
        """Disconnect from database and clean up temporary file."""
        if self.local_db_conn:
            self.local_db_conn.close()
            del self.local_db_conn  # Explicitly delete to release reference
            self.local_db_conn = None

        # Force garbage collection to release file handles on Windows
        gc.collect()

        if self.temp_db_path and self.temp_db_path.exists():
            # Retry deletion with delays (Windows file handle release issue)
            max_retries = 5
            for attempt in range(max_retries):
                try:
                    self.temp_db_path.unlink()
                    self.temp_db_path = None
                    break
                except (PermissionError, OSError) as e:
                    if attempt < max_retries - 1:
                        time.sleep(0.1 * (attempt + 1))  # Exponential backoff
                        gc.collect()  # Try again after another collection
                    else:
                        # Last resort: silently ignore cleanup failure (file will be cleaned by OS temp cleanup)
                        self.temp_db_path = None

    @contextmanager
    def transaction(self):
        """Context manager for database transactions."""
        if not self.local_db_conn:
            raise RuntimeError("Not connected to database")

        try:
            yield self.local_db_conn
            self.local_db_conn.commit()
        except Exception:
            self.local_db_conn.rollback()
            raise

    def get_all_files(self, include_deleted: bool = False) -> List[Dict[str, Any]]:
        """
        Get all file metadata from remote database.

        Args:
            include_deleted: If True, include files with deleted=1

        Returns:
            List of file metadata dictionaries with parsed JSON fields
        """
        if not self.local_db_conn:
            raise RuntimeError("Not connected to database")

        deleted_filter = "" if include_deleted else "WHERE deleted = 0"
        query = f"SELECT * FROM file_metadata {deleted_filter}"

        cursor = self.local_db_conn.cursor()
        cursor.execute(query)
        rows = cursor.fetchall()

        # Parse JSON fields from TEXT to proper Python objects
        result = []
        for row in rows:
            row_dict = dict(row)
            # Parse JSON fields (stored as TEXT in SQLite)
            for json_field in ['doc_collections', 'doc_metadata', 'file_metadata']:
                if json_field in row_dict and row_dict[json_field]:
                    try:
                        row_dict[json_field] = json.loads(row_dict[json_field])
                    except (json.JSONDecodeError, TypeError):
                        # If parsing fails, use empty default
                        row_dict[json_field] = [] if json_field == 'doc_collections' else {}
            result.append(row_dict)

        return result

    def get_deleted_files(self) -> List[Dict[str, Any]]:
        """
        Get files marked as deleted in remote database.

        Returns:
            List of deleted file metadata dictionaries with parsed JSON fields
        """
        if not self.local_db_conn:
            raise RuntimeError("Not connected to database")

        query = "SELECT * FROM file_metadata WHERE deleted = 1"
        cursor = self.local_db_conn.cursor()
        cursor.execute(query)
        rows = cursor.fetchall()

        # Parse JSON fields from TEXT to proper Python objects
        result = []
        for row in rows:
            row_dict = dict(row)
            # Parse JSON fields (stored as TEXT in SQLite)
            for json_field in ['doc_collections', 'doc_metadata', 'file_metadata']:
                if json_field in row_dict and row_dict[json_field]:
                    try:
                        row_dict[json_field] = json.loads(row_dict[json_field])
                    except (json.JSONDecodeError, TypeError):
                        # If parsing fails, use empty default
                        row_dict[json_field] = [] if json_field == 'doc_collections' else {}
            result.append(row_dict)

        return result

    def get_file_by_id(self, file_id: str) -> Optional[Dict[str, Any]]:
        """
        Get file metadata by ID.

        Args:
            file_id: File ID (content hash)

        Returns:
            File metadata dict or None if not found
        """
        if not self.local_db_conn:
            raise RuntimeError("Not connected to database")

        query = "SELECT * FROM file_metadata WHERE id = ?"
        cursor = self.local_db_conn.cursor()
        cursor.execute(query, (file_id,))
        row = cursor.fetchone()

        return dict(row) if row else None

    def upsert_file(self, file_data: Dict[str, Any]) -> None:
        """
        Insert or update file metadata in remote database.

        Args:
            file_data: File metadata dictionary (must include 'id' key)
        """
        if not self.local_db_conn:
            raise RuntimeError("Not connected to database")

        # Prepare data for upsert
        file_data = file_data.copy()
        file_data['updated_at'] = datetime.now(timezone.utc).isoformat()

        # Build column names and placeholders
        columns = list(file_data.keys())
        placeholders = ', '.join('?' * len(columns))
        column_names = ', '.join(columns)
        update_clause = ', '.join(f"{col} = excluded.{col}" for col in columns if col != 'id')

        query = f"""
            INSERT INTO file_metadata ({column_names})
            VALUES ({placeholders})
            ON CONFLICT(id) DO UPDATE SET {update_clause}
        """

        with self.transaction():
            cursor = self.local_db_conn.cursor()
            cursor.execute(query, tuple(file_data.values()))

    def mark_deleted(self, file_id: str, remote_version: int) -> None:
        """
        Mark file as deleted in remote database.

        Args:
            file_id: File ID (content hash)
            remote_version: Version number for this change
        """
        if not self.local_db_conn:
            raise RuntimeError("Not connected to database")

        query = """
            UPDATE file_metadata
            SET deleted = 1,
                remote_version = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """

        with self.transaction():
            cursor = self.local_db_conn.cursor()
            cursor.execute(query, (remote_version, file_id))

    def get_sync_metadata(self, key: str) -> Optional[str]:
        """
        Get sync metadata value.

        Args:
            key: Metadata key

        Returns:
            Metadata value or None if not found
        """
        if not self.local_db_conn:
            raise RuntimeError("Not connected to database")

        query = "SELECT value FROM sync_metadata WHERE key = ?"
        cursor = self.local_db_conn.cursor()
        cursor.execute(query, (key,))
        row = cursor.fetchone()

        return row['value'] if row else None

    def set_sync_metadata(self, key: str, value: str) -> None:
        """
        Set sync metadata value.

        Args:
            key: Metadata key
            value: Metadata value
        """
        if not self.local_db_conn:
            raise RuntimeError("Not connected to database")

        query = """
            INSERT OR REPLACE INTO sync_metadata (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        """

        with self.transaction():
            cursor = self.local_db_conn.cursor()
            cursor.execute(query, (key, value))

    def increment_version(self) -> int:
        """
        Increment and return the remote version number.

        Returns:
            New version number
        """
        current_version = int(self.get_sync_metadata('version') or '0')
        new_version = current_version + 1
        self.set_sync_metadata('version', str(new_version))
        return new_version

    def get_version(self) -> int:
        """
        Get current remote version number.

        Returns:
            Current version number
        """
        version_str = self.get_sync_metadata('version')
        return int(version_str) if version_str else 0

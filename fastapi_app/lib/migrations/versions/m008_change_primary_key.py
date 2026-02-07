"""
Migration 008: Change files table PRIMARY KEY from id to stable_id

Changes the PRIMARY KEY from id (content hash) to stable_id.
This allows multiple file records to share the same content hash,
enabling legitimate content sharing across documents.

Before: id (content hash) is PRIMARY KEY, stable_id is UNIQUE
After: stable_id is PRIMARY KEY, id (content hash) is indexed but not unique

See dev/todo/refactor-primary-key.md for full rationale.
Fixes: https://github.com/mpilhlt/pdf-tei-editor/issues/178
"""

import sqlite3
from ..base import Migration


class Migration008ChangePrimaryKey(Migration):
    """
    Migrate files table to use stable_id as PRIMARY KEY.

    Schema changes:
    1. Recreate files table with stable_id as PRIMARY KEY
    2. id (content hash) becomes a regular NOT NULL column with index
    3. Enables multiple records with same content hash
    """

    @property
    def version(self) -> int:
        return 8

    @property
    def description(self) -> str:
        return "Change files table PRIMARY KEY from id (content hash) to stable_id"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """Check if migration can be applied."""
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='files'"
        )
        if not cursor.fetchone():
            self.logger.info("Files table does not exist yet, skipping migration")
            return False

        # Check if id is still PRIMARY KEY
        cursor = conn.execute("PRAGMA table_info(files)")
        for row in cursor.fetchall():
            col_name, col_pk = row[1], row[5]
            if col_pk == 1 and col_name == "stable_id":
                self.logger.info("Migration already applied (stable_id is PRIMARY KEY)")
                return False
            if col_pk == 1 and col_name == "id":
                return True

        return False

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """Apply migration: change PRIMARY KEY from id to stable_id."""
        self.logger.info("Starting PRIMARY KEY migration from id to stable_id")

        original_count = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]
        self.logger.info(f"Original row count: {original_count}")

        # Create backup
        conn.execute("DROP TABLE IF EXISTS files_backup_m008")
        conn.execute("CREATE TABLE files_backup_m008 AS SELECT * FROM files")

        # Create new table with stable_id as PRIMARY KEY
        conn.execute("""
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
                status TEXT,
                last_revision TEXT,
                version INTEGER DEFAULT 1,
                is_gold_standard BOOLEAN DEFAULT 0,
                deleted BOOLEAN DEFAULT 0,
                local_modified_at TIMESTAMP,
                remote_version INTEGER,
                sync_status TEXT DEFAULT 'synced',
                sync_hash TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by TEXT,
                doc_collections TEXT,
                doc_metadata TEXT,
                file_metadata TEXT
            )
        """)

        # Copy data - note column order change (stable_id first, then id)
        conn.execute("""
            INSERT INTO files_new (
                stable_id, id, filename, doc_id, doc_id_type, file_type,
                mime_type, file_size, label, variant, status, last_revision,
                version, is_gold_standard, deleted, local_modified_at,
                remote_version, sync_status, sync_hash, created_at, updated_at,
                created_by, doc_collections, doc_metadata, file_metadata
            )
            SELECT
                stable_id, id, filename, doc_id, doc_id_type, file_type,
                mime_type, file_size, label, variant, status, last_revision,
                version, is_gold_standard, deleted, local_modified_at,
                remote_version, sync_status, sync_hash, created_at, updated_at,
                created_by, doc_collections, doc_metadata, file_metadata
            FROM files
        """)

        # Verify row count
        new_count = conn.execute("SELECT COUNT(*) FROM files_new").fetchone()[0]
        if original_count != new_count:
            raise RuntimeError(f"Row count mismatch: {original_count} -> {new_count}")

        # Replace old table
        conn.execute("DROP TABLE files")
        conn.execute("ALTER TABLE files_new RENAME TO files")

        # Create indexes
        conn.execute("CREATE INDEX idx_content_hash ON files(id)")
        conn.execute("CREATE INDEX idx_doc_id ON files(doc_id)")
        conn.execute("CREATE INDEX idx_doc_id_type ON files(doc_id, file_type)")
        conn.execute("CREATE INDEX idx_file_type ON files(file_type)")
        conn.execute("CREATE INDEX idx_variant ON files(variant)")
        conn.execute("CREATE INDEX idx_status ON files(status)")
        conn.execute("CREATE INDEX idx_created_at ON files(created_at DESC)")
        conn.execute("CREATE INDEX idx_is_gold ON files(is_gold_standard) WHERE is_gold_standard = 1")
        conn.execute("CREATE INDEX idx_sync_status ON files(sync_status) WHERE sync_status != 'synced'")
        conn.execute("CREATE INDEX idx_deleted ON files(deleted) WHERE deleted = 1")
        conn.execute("CREATE INDEX idx_local_modified ON files(local_modified_at DESC)")
        conn.execute("CREATE INDEX idx_remote_version ON files(remote_version)")
        conn.execute("CREATE INDEX idx_created_by ON files(created_by)")

        self.logger.info("Migration complete: stable_id is now PRIMARY KEY")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """Revert migration. Fails if duplicate content hashes exist."""
        duplicates = conn.execute("""
            SELECT id, COUNT(*) FROM files GROUP BY id HAVING COUNT(*) > 1
        """).fetchall()

        if duplicates:
            raise RuntimeError(
                f"Cannot downgrade: {len(duplicates)} content hashes are shared. "
                "Downgrade only safe immediately after upgrade."
            )

        original_count = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]

        # Create table with original schema
        conn.execute("""
            CREATE TABLE files_old (
                id TEXT PRIMARY KEY,
                stable_id TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                doc_id_type TEXT DEFAULT 'doi',
                file_type TEXT NOT NULL,
                mime_type TEXT,
                file_size INTEGER,
                label TEXT,
                variant TEXT,
                status TEXT,
                last_revision TEXT,
                version INTEGER DEFAULT 1,
                is_gold_standard BOOLEAN DEFAULT 0,
                deleted BOOLEAN DEFAULT 0,
                local_modified_at TIMESTAMP,
                remote_version INTEGER,
                sync_status TEXT DEFAULT 'synced',
                sync_hash TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by TEXT,
                doc_collections TEXT,
                doc_metadata TEXT,
                file_metadata TEXT
            )
        """)

        # Copy data
        conn.execute("""
            INSERT INTO files_old (
                id, stable_id, filename, doc_id, doc_id_type, file_type,
                mime_type, file_size, label, variant, status, last_revision,
                version, is_gold_standard, deleted, local_modified_at,
                remote_version, sync_status, sync_hash, created_at, updated_at,
                created_by, doc_collections, doc_metadata, file_metadata
            )
            SELECT
                id, stable_id, filename, doc_id, doc_id_type, file_type,
                mime_type, file_size, label, variant, status, last_revision,
                version, is_gold_standard, deleted, local_modified_at,
                remote_version, sync_status, sync_hash, created_at, updated_at,
                created_by, doc_collections, doc_metadata, file_metadata
            FROM files
        """)

        # Verify and replace
        new_count = conn.execute("SELECT COUNT(*) FROM files_old").fetchone()[0]
        if original_count != new_count:
            raise RuntimeError(f"Row count mismatch: {original_count} -> {new_count}")

        conn.execute("DROP TABLE files")
        conn.execute("ALTER TABLE files_old RENAME TO files")

        # Recreate original indexes
        conn.execute("CREATE UNIQUE INDEX idx_stable_id ON files(stable_id)")
        conn.execute("CREATE INDEX idx_doc_id ON files(doc_id)")
        conn.execute("CREATE INDEX idx_doc_id_type ON files(doc_id, file_type)")
        conn.execute("CREATE INDEX idx_file_type ON files(file_type)")
        conn.execute("CREATE INDEX idx_variant ON files(variant)")
        conn.execute("CREATE INDEX idx_status ON files(status)")
        conn.execute("CREATE INDEX idx_created_at ON files(created_at DESC)")
        conn.execute("CREATE INDEX idx_is_gold ON files(is_gold_standard) WHERE is_gold_standard = 1")
        conn.execute("CREATE INDEX idx_sync_status ON files(sync_status) WHERE sync_status != 'synced'")
        conn.execute("CREATE INDEX idx_deleted ON files(deleted) WHERE deleted = 1")
        conn.execute("CREATE INDEX idx_local_modified ON files(local_modified_at DESC)")
        conn.execute("CREATE INDEX idx_remote_version ON files(remote_version)")
        conn.execute("CREATE INDEX idx_created_by ON files(created_by)")

        conn.execute("DROP TABLE IF EXISTS files_backup_m008")

        self.logger.info("Downgrade complete: id is now PRIMARY KEY")

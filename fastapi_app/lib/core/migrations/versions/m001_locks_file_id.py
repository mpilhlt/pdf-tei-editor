"""
Migration 001: Rename locks.file_hash to locks.file_id

Changes the locks table to use stable_id instead of content hash.
This eliminates the need for lock transfers when file content changes.

Before: locks identified by content hash (file.id)
After: locks identified by stable_id (file.stable_id)
"""

import sqlite3
from fastapi_app.lib.core.migrations.base import Migration


class Migration001LocksFileId(Migration):
    """
    Migrate locks table from file_hash to file_id.

    Schema changes:
    1. Rename file_hash column to file_id
    2. Update index name from idx_file_hash to idx_file_id
    3. Clear existing locks (they use old hash-based identifiers)

    Note: Existing locks are cleared because they reference content hashes
    instead of stable_ids. Since locks expire after 90 seconds, this is safe.
    """

    @property
    def version(self) -> int:
        return 1

    @property
    def description(self) -> str:
        return "Rename locks.file_hash to locks.file_id for stable_id support"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """
        Check if migration can be applied.

        Returns False if file_id column already exists (migration already applied).
        """
        cursor = conn.execute("PRAGMA table_info(locks)")
        columns = {row[1] for row in cursor.fetchall()}

        # If file_id exists, migration already applied
        if "file_id" in columns:
            self.logger.info("Migration already applied (file_id column exists)")
            return False

        # If file_hash doesn't exist, locks table doesn't exist yet
        if "file_hash" not in columns:
            self.logger.info("Locks table does not exist yet, skipping migration")
            return False

        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """
        Apply migration: rename file_hash to file_id.

        SQLite doesn't support ALTER TABLE RENAME COLUMN directly in older versions,
        so we use the standard migration pattern:
        1. Create new table with new schema
        2. Copy data (in this case, we clear locks instead)
        3. Drop old table
        4. Rename new table

        Note: We clear locks instead of copying because existing locks
        use content hashes, not stable_ids. Locks expire in 90 seconds anyway.
        """
        self.logger.info("Creating new locks table with file_id column")

        # Create new locks table with file_id
        conn.execute("""
            CREATE TABLE locks_new (
                file_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Create indexes on new table
        conn.execute("CREATE INDEX IF NOT EXISTS idx_file_id ON locks_new(file_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_session ON locks_new(session_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_updated ON locks_new(updated_at)")

        self.logger.info("Clearing old locks (they use content hashes, not stable_ids)")

        # Drop old table
        conn.execute("DROP TABLE IF EXISTS locks")

        # Rename new table
        conn.execute("ALTER TABLE locks_new RENAME TO locks")

        self.logger.info("Migration complete: locks table now uses file_id")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Revert migration: rename file_id back to file_hash.
        """
        self.logger.info("Reverting: Creating locks table with file_hash column")

        # Create old locks table with file_hash
        conn.execute("""
            CREATE TABLE locks_new (
                file_hash TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Create old indexes
        conn.execute("CREATE INDEX IF NOT EXISTS idx_session ON locks_new(session_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_updated ON locks_new(updated_at)")

        self.logger.info("Clearing locks during downgrade")

        # Drop current table
        conn.execute("DROP TABLE IF EXISTS locks")

        # Rename new table
        conn.execute("ALTER TABLE locks_new RENAME TO locks")

        self.logger.info("Downgrade complete: locks table now uses file_hash")

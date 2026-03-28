"""
Migration 009: Add file_edit_log table

Creates a table to track the content history of individual file records.
Each time a file is saved in-place (content hash changes), the old hash
is appended here so it can be restored later.

Storage reference counting ensures physical files referenced by this table
are retained until the log entry is removed.
"""

import sqlite3
from fastapi_app.lib.core.migrations.base import Migration


class Migration009FileEditLog(Migration):
    """
    Create the file_edit_log table.

    Schema:
    - id: auto-increment primary key
    - stable_id: references files.stable_id (no FK constraint for simplicity)
    - content_hash: SHA-256 hash of the saved content (the old file id)
    - file_type: 'tei', 'pdf', etc.
    - saved_at: UTC timestamp of the save
    - saved_by: username who performed the save (may be NULL)
    """

    @property
    def version(self) -> int:
        return 9

    @property
    def description(self) -> str:
        return "Add file_edit_log table for per-file edit history"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """Return False if the table already exists."""
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='file_edit_log'"
        )
        if cursor.fetchone():
            self.logger.info("Migration already applied (file_edit_log table exists)")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """Create file_edit_log table and index."""
        conn.execute("""
            CREATE TABLE file_edit_log (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                stable_id    TEXT    NOT NULL,
                content_hash TEXT    NOT NULL,
                file_type    TEXT    NOT NULL,
                saved_at     TEXT    NOT NULL DEFAULT (datetime('now')),
                saved_by     TEXT
            )
        """)
        conn.execute(
            "CREATE INDEX idx_file_edit_log_stable_id ON file_edit_log(stable_id)"
        )
        self.logger.info("Created file_edit_log table and index")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """Drop file_edit_log table."""
        conn.execute("DROP TABLE IF EXISTS file_edit_log")
        self.logger.info("Dropped file_edit_log table")

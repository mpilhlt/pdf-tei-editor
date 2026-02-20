"""
Migration 005: Add status column to files table and populate from TEI XML

Adds a status column to track the revision status from TEI documents.
Populates the column by parsing existing TEI files using extract_last_revision_status().

Before: No status column, requires parsing XML every time
After: Status column populated from revisionDesc/change/@status for efficient lookups
"""

import sqlite3
from pathlib import Path
from fastapi_app.lib.core.migrations.base import Migration


class Migration005AddStatusColumn(Migration):
    """
    Add status column to files table and populate from TEI XML.

    Schema changes:
    1. Add status TEXT column to files table
    2. Create index on status column

    Data changes:
    1. Parse all TEI files and extract status using extract_last_revision_status()
    2. Update status column for each TEI file
    """

    @property
    def version(self) -> int:
        return 5

    @property
    def description(self) -> str:
        return "Add status column to files table and populate from TEI XML"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """
        Check if migration can be applied.

        Returns False if status column already exists (migration already applied).
        """
        cursor = conn.execute("PRAGMA table_info(files)")
        columns = {row[1] for row in cursor.fetchall()}

        # If status exists, migration already applied
        if "status" in columns:
            self.logger.info("Migration already applied (status column exists)")
            return False

        # Check if files table exists
        if "id" not in columns:
            self.logger.info("Files table does not exist yet, skipping migration")
            return False

        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """
        Apply migration: add status column and populate from TEI XML.
        """
        # Import here to avoid circular dependencies during module loading
        from fastapi_app.lib.utils.tei_utils import extract_last_revision_status
        from fastapi_app.lib.core.migrations.utils import populate_column_from_tei_files
        
        populate_column_from_tei_files(
            conn=conn,
            column_name="status",
            column_type="TEXT",
            index_name="idx_status",
            extract_function=extract_last_revision_status,
            logger=self.logger,
            column_description="status"
        )

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Revert migration: remove status column and index.
        """
        self.logger.info("Removing status column from files table")
        conn.execute("DROP INDEX IF EXISTS idx_status")
        conn.execute("ALTER TABLE files DROP COLUMN status")
        self.logger.info("Status column removed successfully")



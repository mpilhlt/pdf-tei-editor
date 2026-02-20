"""
Migration 006: Add last_revision column to files table and populate from TEI XML

Adds a last_revision column to store the timestamp from the last revision change element.
Populates the column by parsing existing TEI files using extract_revision_timestamp().

Before: No last_revision column, requires parsing XML every time
After: last_revision column populated from revisionDesc/change[last()]/@when for efficient lookups
"""

import sqlite3
from pathlib import Path
from ..base import Migration


class Migration006AddLastRevisionColumn(Migration):
    """
    Add last_revision column to files table and populate from TEI XML.

    Schema changes:
    1. Add last_revision TEXT column to files table
    2. Create index on last_revision column

    Data changes:
    1. Parse all TEI files and extract last revision timestamp using extract_revision_timestamp()
    2. Update last_revision column for each TEI file
    """

    @property
    def version(self) -> int:
        return 6

    @property
    def description(self) -> str:
        return "Add last_revision column to files table and populate from TEI XML"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """
        Check if migration can be applied.

        Returns False if last_revision column already exists (migration already applied).
        """
        cursor = conn.execute("PRAGMA table_info(files)")
        columns = {row[1] for row in cursor.fetchall()}

        # If last_revision exists, migration already applied
        if "last_revision" in columns:
            self.logger.info("Migration already applied (last_revision column exists)")
            return False

        # Check if files table exists
        if "id" not in columns:
            self.logger.info("Files table does not exist yet, skipping migration")
            return False

        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """
        Apply migration: add last_revision column and populate from TEI XML.
        """
        # Import here to avoid circular dependencies during module loading
        from ....lib.tei_utils import extract_revision_timestamp
        from ..utils import populate_column_from_tei_files
        
        populate_column_from_tei_files(
            conn=conn,
            column_name="last_revision",
            column_type="TEXT",
            index_name="idx_last_revision",
            extract_function=extract_revision_timestamp,
            logger=self.logger,
            column_description="last revision"
        )

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Revert migration: remove last_revision column and index.
        """
        self.logger.info("Removing last_revision column from files table")
        conn.execute("DROP INDEX IF EXISTS idx_last_revision")
        conn.execute("ALTER TABLE files DROP COLUMN last_revision")
        self.logger.info("Last_revision column removed successfully")


"""
Migration 007: Add created_by column to files table

Adds a created_by column to track which user created each file.
This is used for owner-based access control.

Existing files will have created_by=NULL, which allows reviewers to manage them.
New files will have created_by set to the creating user's username.
"""

import sqlite3
from fastapi_app.lib.core.migrations.base import Migration


class Migration007AddCreatedByColumn(Migration):
    """
    Add created_by column to files table.

    Schema changes:
    1. Add created_by TEXT column to files table
    2. Create index on created_by column
    """

    @property
    def version(self) -> int:
        return 7

    @property
    def description(self) -> str:
        return "Add created_by column to files table for owner-based access control"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """
        Check if migration can be applied.

        Returns False if created_by column already exists (migration already applied).
        """
        cursor = conn.execute("PRAGMA table_info(files)")
        columns = {row[1] for row in cursor.fetchall()}

        # If created_by exists, migration already applied
        if "created_by" in columns:
            self.logger.info("Migration already applied (created_by column exists)")
            return False

        # Check if files table exists
        if "id" not in columns:
            self.logger.info("Files table does not exist yet, skipping migration")
            return False

        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """
        Apply migration: add created_by column.
        """
        self.logger.info("Adding created_by column to files table")

        # Add column (NULL for existing files - reviewers can manage them)
        conn.execute("ALTER TABLE files ADD COLUMN created_by TEXT")

        # Create index for efficient owner lookups
        conn.execute("CREATE INDEX IF NOT EXISTS idx_created_by ON files(created_by)")

        self.logger.info("created_by column added successfully")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Revert migration: remove created_by column and index.
        """
        self.logger.info("Removing created_by column from files table")
        conn.execute("DROP INDEX IF EXISTS idx_created_by")
        conn.execute("ALTER TABLE files DROP COLUMN created_by")
        self.logger.info("created_by column removed successfully")

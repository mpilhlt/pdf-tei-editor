"""
Migration 005: Add status column to files table and populate from TEI XML

Adds a status column to track the revision status from TEI documents.
Populates the column by parsing existing TEI files using extract_last_revision_status().

Before: No status column, requires parsing XML every time
After: Status column populated from revisionDesc/change/@status for efficient lookups
"""

import sqlite3
from pathlib import Path
from ..base import Migration


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

        Steps:
        1. Add status column to files table
        2. Create index on status column
        3. Get file storage location from database path
        4. Parse all TEI files and extract status
        5. Update status column for each file
        """
        self.logger.info("Adding status column to files table")

        # Add status column
        conn.execute("""
            ALTER TABLE files
            ADD COLUMN status TEXT
        """)

        # Create index on status column
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_status
            ON files(status)
            WHERE status IS NOT NULL
        """)

        self.logger.info("Status column and index created successfully")

        # Now populate status from existing TEI files
        self.logger.info("Populating status from existing TEI files")

        # Get file storage path (sibling to db directory)
        db_path = Path(conn.execute("PRAGMA database_list").fetchone()[2])
        db_dir = db_path.parent
        files_dir = db_dir.parent / "files"

        if not files_dir.exists():
            self.logger.debug(f"Files directory not found: {files_dir}, skipping data population")
            return

        # Get all TEI files
        cursor = conn.execute("""
            SELECT id, file_type
            FROM files
            WHERE file_type = 'tei' AND deleted = 0
        """)

        tei_files = cursor.fetchall()
        total_files = len(tei_files)
        updated_count = 0
        error_count = 0

        self.logger.info(f"Found {total_files} TEI file(s) to process")

        # Import here to avoid circular dependencies during module loading
        from ....lib.tei_utils import extract_last_revision_status
        from ....lib.hash_utils import get_storage_path

        for file_id, file_type in tei_files:
            try:
                # Get storage path and read file content directly
                storage_path = get_storage_path(files_dir, file_id, file_type)
                if not storage_path.exists():
                    file_id_short = file_id[:8] if len(file_id) >= 8 else file_id
                    self.logger.warning(f"File not found in storage: {file_id_short}")
                    continue

                content = storage_path.read_bytes()

                # Extract status from XML
                status = extract_last_revision_status(content)

                if status:
                    # Update status in database
                    conn.execute("""
                        UPDATE files
                        SET status = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    """, (status, file_id))
                    updated_count += 1

            except Exception as e:
                error_count += 1
                file_id_short = file_id[:8] if len(file_id) >= 8 else file_id
                self.logger.warning(
                    f"Failed to extract status from file {file_id_short}: {e}"
                )

        self.logger.info(
            f"Migration complete: updated {updated_count} file(s), "
            f"{error_count} skipped due to issues, "
            f"{total_files - updated_count - error_count} file(s) without status"
        )

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Downgrade not supported - status column provides valuable metadata.
        """
        raise NotImplementedError(
            "Migration 005 cannot be reverted. "
            "The status column is now part of the schema."
        )

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

        Steps:
        1. Add last_revision column to files table
        2. Create index on last_revision column
        3. Get file storage location from database path
        4. Parse all TEI files and extract last revision timestamp
        5. Update last_revision column for each file
        """
        self.logger.info("Adding last_revision column to files table")

        # Add last_revision column
        conn.execute("""
            ALTER TABLE files
            ADD COLUMN last_revision TEXT
        """)

        # Create index on last_revision column
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_last_revision
            ON files(last_revision)
            WHERE last_revision IS NOT NULL
        """)

        self.logger.info("last_revision column and index created successfully")

        # Now populate last_revision from existing TEI files
        self.logger.info("Populating last_revision from existing TEI files")

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
        from ....lib.tei_utils import extract_revision_timestamp
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

                # Extract last revision timestamp from XML
                last_revision = extract_revision_timestamp(content)

                if last_revision:
                    # Update last_revision in database
                    conn.execute("""
                        UPDATE files
                        SET last_revision = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    """, (last_revision, file_id))
                    updated_count += 1

            except Exception as e:
                error_count += 1
                file_id_short = file_id[:8] if len(file_id) >= 8 else file_id
                self.logger.warning(
                    f"Failed to extract last_revision from file {file_id_short}: {e}"
                )

        self.logger.info(
            f"Migration complete: updated {updated_count} file(s), "
            f"{error_count} skipped due to issues, "
            f"{total_files - updated_count - error_count} file(s) without last_revision"
        )

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Downgrade not supported - last_revision column provides valuable metadata.
        """
        raise NotImplementedError(
            "Migration 006 cannot be reverted. "
            "The last_revision column is now part of the schema."
        )

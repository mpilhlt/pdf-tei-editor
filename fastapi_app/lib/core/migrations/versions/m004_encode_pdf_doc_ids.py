"""
Migration 004: Encode PDF document IDs to be filesystem-compliant

Encodes doc_id values in the files table to ensure they are filesystem-safe.
Uses the encoding from doi_utils.py which converts:
- Forward slashes (/) -> double underscore (__)
- Special characters like :, <, >, etc. -> dollar-sign encoding ($XX$)

This migration only encodes doc_ids that are not already encoded.

Before: doc_id may contain filesystem-unsafe characters (/, :, <, >, etc.)
After: All doc_id values are filesystem-safe
"""

import sqlite3
from ..base import Migration
from fastapi_app.lib.doi_utils import encode_filename, is_filename_encoded


class Migration004EncodePdfDocIds(Migration):
    """
    Encode document IDs to be filesystem-compliant.

    Data changes:
    1. Find all files where doc_id is not filesystem-safe
    2. Encode doc_id using encode_filename() from doi_utils
    3. Skip doc_ids that are already encoded
    4. Update sync_status to 'modified' for changed files
    5. Report number of files updated

    This is a data-only migration - no schema changes.
    """

    @property
    def version(self) -> int:
        return 4

    @property
    def description(self) -> str:
        return "Encode PDF document IDs to be filesystem-compliant"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """
        Check if migration is needed.

        Returns True if there are any files with non-encoded doc_ids that would change.
        """
        # Check if files table exists
        cursor = conn.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='files'
        """)
        if not cursor.fetchone():
            self.logger.info("Files table does not exist yet, skipping migration")
            return False

        # Get all distinct doc_ids
        cursor = conn.execute("""
            SELECT DISTINCT doc_id
            FROM files
            WHERE deleted = 0
        """)

        doc_ids = [row[0] for row in cursor.fetchall()]
        needs_encoding = []

        for doc_id in doc_ids:
            # Skip if already encoded
            if is_filename_encoded(doc_id):
                continue

            # Check if encoding would change the doc_id
            encoded = encode_filename(doc_id)
            if encoded != doc_id:
                needs_encoding.append(doc_id)

        if not needs_encoding:
            self.logger.info("No doc_ids need encoding")
            return False

        self.logger.info(f"Found {len(needs_encoding)} doc_id(s) that need encoding")
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """
        Apply migration: encode doc_ids to be filesystem-safe.

        For each doc_id that needs encoding:
        1. Encode it using encode_filename()
        2. Update all files with that doc_id
        3. Set sync_status='modified' for changed files
        """
        self.logger.info("Starting doc_id encoding")

        # Get all distinct doc_ids
        cursor = conn.execute("""
            SELECT DISTINCT doc_id
            FROM files
            WHERE deleted = 0
        """)

        doc_ids = [row[0] for row in cursor.fetchall()]
        total_files_updated = 0
        total_doc_ids_updated = 0

        for old_doc_id in doc_ids:
            # Skip if already encoded
            if is_filename_encoded(old_doc_id):
                continue

            # Encode the doc_id
            new_doc_id = encode_filename(old_doc_id)

            # Skip if encoding didn't change anything
            if new_doc_id == old_doc_id:
                continue

            # Update all files with this doc_id
            cursor = conn.execute("""
                UPDATE files
                SET doc_id = ?,
                    sync_status = 'modified',
                    updated_at = CURRENT_TIMESTAMP
                WHERE doc_id = ?
                  AND deleted = 0
            """, (new_doc_id, old_doc_id))

            files_updated = cursor.rowcount
            if files_updated > 0:
                total_files_updated += files_updated
                total_doc_ids_updated += 1
                self.logger.info(
                    f"Encoded doc_id: '{old_doc_id}' -> '{new_doc_id}' "
                    f"({files_updated} file(s) updated)"
                )

        self.logger.info(
            f"Migration complete: encoded {total_doc_ids_updated} doc_id(s), "
            f"updated {total_files_updated} file(s)"
        )

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Revert migration.

        This migration cannot be automatically reverted since we don't know
        the original unencoded doc_ids. Manual intervention would be required
        to restore the original state.

        Raises:
            NotImplementedError: Always - this migration is not reversible
        """
        raise NotImplementedError(
            "Migration 004 cannot be automatically reverted. "
            "The original unencoded doc_ids were lost during the upgrade. "
            "If you need to revert, restore from backup."
        )

"""
Migration 002: Sync TEI file collections with their PDF files

Fixes data integrity issue where TEI files have different doc_collections
than their associated PDF file. This can happen when files were moved
using the old move operation that only updated PDF files.

Before: TEI files may be in different collections than their PDF
After: All TEI files have the same doc_collections as their PDF
"""

import json
import sqlite3
from ..base import Migration


class Migration002SyncTeiCollections(Migration):
    """
    Synchronize TEI file collections with their PDF files.

    Data changes:
    1. Find all TEI files where doc_collections differs from PDF's doc_collections
    2. Update TEI files to match their PDF's doc_collections
    3. Report number of files updated

    This is a data-only migration - no schema changes.
    """

    @property
    def version(self) -> int:
        return 2

    @property
    def description(self) -> str:
        return "Sync TEI file collections with their PDF files"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """
        Check if migration is needed.

        Returns True if there are any TEI files with mismatched collections.
        """
        # Check if files table exists
        cursor = conn.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='files'
        """)
        if not cursor.fetchone():
            self.logger.info("Files table does not exist yet, skipping migration")
            return False

        # Count TEI files with mismatched collections
        cursor = conn.execute("""
            SELECT COUNT(*)
            FROM files tei
            JOIN files pdf ON tei.doc_id = pdf.doc_id AND pdf.file_type = 'pdf'
            WHERE tei.file_type = 'tei'
              AND tei.deleted = 0
              AND pdf.deleted = 0
              AND tei.doc_collections != pdf.doc_collections
        """)

        count = cursor.fetchone()[0]
        if count == 0:
            self.logger.info("No TEI files with mismatched collections found")
            return False

        self.logger.info(f"Found {count} TEI file(s) with mismatched collections")
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """
        Apply migration: sync TEI collections with PDF collections.

        For each document (doc_id):
        1. Get the PDF's doc_collections
        2. Update all TEI files to have the same doc_collections
        3. Set sync_status='modified' for changed files
        """
        self.logger.info("Starting TEI collection sync")

        # Get all documents with mismatched TEI files
        cursor = conn.execute("""
            SELECT DISTINCT pdf.doc_id, pdf.doc_collections
            FROM files pdf
            JOIN files tei ON pdf.doc_id = tei.doc_id AND tei.file_type = 'tei'
            WHERE pdf.file_type = 'pdf'
              AND pdf.deleted = 0
              AND tei.deleted = 0
              AND pdf.doc_collections != tei.doc_collections
        """)

        documents = cursor.fetchall()
        total_updated = 0

        for doc_id, pdf_collections in documents:
            # Parse collections (stored as JSON array)
            try:
                collections = json.loads(pdf_collections)
                collections_str = ', '.join(collections) if collections else 'none'
            except (json.JSONDecodeError, TypeError):
                collections_str = str(pdf_collections)

            # Update all TEI files for this document
            cursor = conn.execute("""
                UPDATE files
                SET doc_collections = ?,
                    sync_status = 'modified',
                    updated_at = CURRENT_TIMESTAMP
                WHERE doc_id = ?
                  AND file_type = 'tei'
                  AND deleted = 0
                  AND doc_collections != ?
            """, (pdf_collections, doc_id, pdf_collections))

            updated = cursor.rowcount
            total_updated += updated

            if updated > 0:
                self.logger.info(
                    f"Updated {updated} TEI file(s) for doc_id={doc_id} "
                    f"to collections: [{collections_str}]"
                )

        self.logger.info(
            f"Migration complete: synchronized {total_updated} TEI file(s) "
            f"across {len(documents)} document(s)"
        )

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Revert migration.

        This migration cannot be automatically reverted since we don't know
        what the original mismatched collections were. Manual intervention
        would be required to restore the original state.

        Raises:
            NotImplementedError: Always - this migration is not reversible
        """
        raise NotImplementedError(
            "Migration 002 cannot be automatically reverted. "
            "The original collection assignments were lost during the upgrade. "
            "If you need to revert, restore from backup."
        )

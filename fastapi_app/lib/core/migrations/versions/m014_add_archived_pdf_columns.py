"""
Migration 014: Add pdf_stable_id and superseded_by columns to files table

Keeps the original PDF of a document after text recognition (OCR) replaced it (#924). The
original becomes an archived PDF row (same doc_id, old content hash, new stable_id) whose
`superseded_by` holds the stable_id of the current PDF; the TEI versions made from it record its
stable_id in `pdf_stable_id`. PDFs replaced before this migration are gone, so nothing is
populated.

Before: files has neither column.
After: files.pdf_stable_id and files.superseded_by exist (indexed), NULL for all rows.
"""

import sqlite3

from fastapi_app.lib.core.migrations.base import Migration


class Migration014AddArchivedPdfColumns(Migration):
    """Add the pdf_stable_id (TEI) and superseded_by (PDF) columns to the files table."""

    @property
    def version(self) -> int:
        return 14

    @property
    def description(self) -> str:
        return "Add pdf_stable_id and superseded_by columns to files table (archived PDFs after OCR)"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(files)").fetchall()}
        if "id" not in columns:
            self.logger.info("Files table does not exist yet, skipping migration")
            return False
        if "pdf_stable_id" in columns and "superseded_by" in columns:
            self.logger.info("Migration already applied (pdf_stable_id and superseded_by columns exist)")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(files)").fetchall()}
        if "pdf_stable_id" not in columns:
            self.logger.info("Adding pdf_stable_id column to files table")
            conn.execute("ALTER TABLE files ADD COLUMN pdf_stable_id TEXT")
        if "superseded_by" not in columns:
            self.logger.info("Adding superseded_by column to files table")
            conn.execute("ALTER TABLE files ADD COLUMN superseded_by TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pdf_stable_id ON files(pdf_stable_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_superseded_by ON files(superseded_by)")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        self.logger.info("Removing pdf_stable_id and superseded_by columns from files table")
        conn.execute("DROP INDEX IF EXISTS idx_pdf_stable_id")
        conn.execute("DROP INDEX IF EXISTS idx_superseded_by")
        conn.execute("ALTER TABLE files DROP COLUMN pdf_stable_id")
        conn.execute("ALTER TABLE files DROP COLUMN superseded_by")

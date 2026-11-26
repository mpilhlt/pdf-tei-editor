"""
Migration 015: Attach every TEI file to its own PDF, drop superseded_by

Until now, a document had one current PDF and archived PDFs (#924): text recognition replaced the
content of the current PDF row, kept the old content as an archived row (`superseded_by` = the
current PDF) and linked the versions based on the current PDF to it (`pdf_stable_id`), while
`pdf_stable_id IS NULL` meant "the current PDF". Now each TEI file is attached to the PDF it was
made from, PDFs never change, and the canonical PDF of a document is derived (#944).

- TEI files without `pdf_stable_id` are attached to the current PDF of their document (the PDF row
  without `superseded_by`, non-deleted first).
- The document fields (`doc_collections`, `doc_metadata`) of the current PDF are copied to the
  other PDFs of the document: archived rows kept a snapshot of the time they were archived.
- The `superseded_by` column and its index are dropped.

Before: files.superseded_by exists; TEI files based on the current PDF have pdf_stable_id NULL.
After: files.superseded_by is gone; every TEI file of a document with a PDF has pdf_stable_id set.
"""

import sqlite3

from fastapi_app.lib.core.migrations.base import Migration


class Migration015PdfPerVersion(Migration):
    """Attach every TEI file to a PDF and drop the superseded_by column."""

    @property
    def version(self) -> int:
        return 15

    @property
    def description(self) -> str:
        return "Attach every TEI file to its PDF, drop superseded_by (PDF per version, #944)"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(files)").fetchall()}
        if "id" not in columns:
            self.logger.info("Files table does not exist yet, skipping migration")
            return False
        if "pdf_stable_id" not in columns:
            self.logger.info("Column pdf_stable_id is missing (migration 014 not applied), skipping migration")
            return False
        if "superseded_by" not in columns:
            self.logger.info("Migration already applied (superseded_by column does not exist)")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        current_pdf = """
            SELECT pdf.stable_id FROM files pdf
            WHERE pdf.doc_id = files.doc_id AND pdf.file_type = 'pdf' AND pdf.superseded_by IS NULL
            ORDER BY pdf.deleted ASC, pdf.created_at DESC LIMIT 1
        """
        cursor = conn.execute(f"""
            UPDATE files SET pdf_stable_id = ({current_pdf})
            WHERE file_type = 'tei' AND pdf_stable_id IS NULL
        """)
        self.logger.info(f"Attached {cursor.rowcount} TEI file(s) to the current PDF of their document")
        cursor = conn.execute("""
            UPDATE files
            SET doc_collections = (SELECT cur.doc_collections FROM files cur WHERE cur.stable_id = files.superseded_by),
                doc_metadata = (SELECT cur.doc_metadata FROM files cur WHERE cur.stable_id = files.superseded_by)
            WHERE file_type = 'pdf' AND superseded_by IS NOT NULL
              AND EXISTS (SELECT 1 FROM files cur WHERE cur.stable_id = files.superseded_by)
        """)
        self.logger.info(f"Copied the document fields of the current PDF to {cursor.rowcount} archived PDF(s)")
        conn.execute("DROP INDEX IF EXISTS idx_superseded_by")
        conn.execute("ALTER TABLE files DROP COLUMN superseded_by")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        # The PDFs of a document become archived PDFs of its most recent PDF; TEI files attached to
        # that PDF are based on the current PDF again
        self.logger.info("Restoring the superseded_by column of the files table")
        conn.execute("ALTER TABLE files ADD COLUMN superseded_by TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_superseded_by ON files(superseded_by)")
        latest_pdf = """
            SELECT latest.stable_id FROM files latest
            WHERE latest.doc_id = files.doc_id AND latest.file_type = 'pdf'
            ORDER BY latest.deleted ASC, latest.created_at DESC, latest.rowid DESC LIMIT 1
        """
        conn.execute(f"""
            UPDATE files SET superseded_by = ({latest_pdf})
            WHERE file_type = 'pdf' AND stable_id != ({latest_pdf})
        """)
        conn.execute("""
            UPDATE files SET pdf_stable_id = NULL
            WHERE file_type = 'tei' AND pdf_stable_id IN (
                SELECT stable_id FROM files WHERE file_type = 'pdf' AND superseded_by IS NULL
            )
        """)

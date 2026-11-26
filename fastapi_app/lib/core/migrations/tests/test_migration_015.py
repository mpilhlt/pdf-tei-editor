"""
Unit tests for migration 015 (every TEI file attached to its PDF, superseded_by dropped).

@testCovers fastapi_app/lib/core/migrations/versions/m015_pdf_per_version.py
"""

import logging
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.migrations import MigrationManager
from fastapi_app.lib.core.migrations.versions.m015_pdf_per_version import Migration015PdfPerVersion


class TestMigration015(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp())
        self.db_path = self.temp_dir / "metadata.db"
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("""CREATE TABLE files (id TEXT, stable_id TEXT, doc_id TEXT, file_type TEXT, deleted INTEGER DEFAULT 0,
                created_at TEXT, doc_collections TEXT, doc_metadata TEXT, pdf_stable_id TEXT, superseded_by TEXT)""")
            conn.execute("CREATE INDEX idx_superseded_by ON files(superseded_by)")
            rows = [
                # document d1: current PDF p1, archived PDF a1 with an old snapshot of the document fields
                ("h1", "p1", "d1", "pdf", 0, "2026-01-02", '["new"]', '{"title": "New"}', None, None),
                ("h0", "a1", "d1", "pdf", 0, "2026-01-01", '["old"]', '{"title": "Old"}', None, "p1"),
                ("t1", "tei1", "d1", "tei", 0, "2026-01-03", "[]", "{}", None, None),
                ("t2", "tei2", "d1", "tei", 0, "2026-01-01", "[]", "{}", "a1", None),
                ("t3", "tei3", "d1", "tei", 1, "2026-01-03", "[]", "{}", None, None),
                # document d2 without a PDF
                ("t4", "tei4", "d2", "tei", 0, "2026-01-03", "[]", "{}", None, None),
            ]
            conn.executemany("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        self.logger = logging.getLogger("test_migration_015")
        self.logger.setLevel(logging.ERROR)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def manager(self) -> MigrationManager:
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration015PdfPerVersion(self.logger))
        return manager

    def test_attaches_tei_files_and_drops_column(self):
        self.assertEqual(self.manager().run_migrations(skip_backup=True), 1)
        self.assertEqual(self.manager().run_migrations(skip_backup=True), 0)
        with sqlite3.connect(str(self.db_path)) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(files)")}
            self.assertNotIn("superseded_by", columns)
            links = dict(conn.execute("SELECT stable_id, pdf_stable_id FROM files WHERE file_type = 'tei'").fetchall())
            self.assertEqual(links, {"tei1": "p1", "tei2": "a1", "tei3": "p1", "tei4": None})
            fields = conn.execute("SELECT doc_collections, doc_metadata FROM files WHERE stable_id = 'a1'").fetchone()
            self.assertEqual(fields, ('["new"]', '{"title": "New"}'))


if __name__ == "__main__":
    unittest.main()

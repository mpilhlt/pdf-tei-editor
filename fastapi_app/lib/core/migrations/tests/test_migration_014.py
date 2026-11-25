"""
Unit tests for migration 014 (pdf_stable_id and superseded_by columns).

@testCovers fastapi_app/lib/core/migrations/versions/m014_add_archived_pdf_columns.py
"""

import logging
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.migrations import MigrationManager
from fastapi_app.lib.core.migrations.versions.m014_add_archived_pdf_columns import (
    Migration014AddArchivedPdfColumns,
)


class TestMigration014(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp())
        self.db_path = self.temp_dir / "metadata.db"
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("CREATE TABLE files (id TEXT, stable_id TEXT, doc_id TEXT, file_type TEXT)")
            conn.execute("INSERT INTO files VALUES ('h', 's', 'd', 'pdf')")
        self.logger = logging.getLogger("test_migration_014")
        self.logger.setLevel(logging.ERROR)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def manager(self) -> MigrationManager:
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration014AddArchivedPdfColumns(self.logger))
        return manager

    def test_adds_columns_once(self):
        self.assertEqual(self.manager().run_migrations(skip_backup=True), 1)
        self.assertEqual(self.manager().run_migrations(skip_backup=True), 0)
        with sqlite3.connect(str(self.db_path)) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(files)")}
            self.assertIn("pdf_stable_id", columns)
            self.assertIn("superseded_by", columns)
            self.assertEqual(conn.execute("SELECT pdf_stable_id, superseded_by FROM files").fetchone(), (None, None))


if __name__ == "__main__":
    unittest.main()

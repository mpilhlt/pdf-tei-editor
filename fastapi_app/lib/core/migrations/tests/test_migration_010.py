"""
Unit tests for migration 010 (parent_stable_id column).

@testCovers fastapi_app/lib/core/migrations/versions/m010_add_parent_stable_id_column.py
"""

import logging
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.migrations import MigrationManager
from fastapi_app.lib.core.migrations.versions.m010_add_parent_stable_id_column import (
    Migration010AddParentStableIdColumn,
)
from fastapi_app.lib.utils.hash_utils import get_storage_path


def tei(changes: list[tuple[str, str]]) -> bytes:
    body = "".join(f'<change when="{when}" who="{who}" status="draft"/>' for who, when in changes)
    return f'<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><revisionDesc>{body}</revisionDesc></teiHeader><text/></TEI>'.encode()


class TestMigration010(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp())
        (self.temp_dir / "db").mkdir()
        self.files_dir = self.temp_dir / "files"
        self.files_dir.mkdir()
        self.db_path = self.temp_dir / "db" / "metadata.db"
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute(
                "CREATE TABLE files (id TEXT, stable_id TEXT, doc_id TEXT, variant TEXT, file_type TEXT, deleted BOOLEAN DEFAULT 0)"
            )
        self.logger = logging.getLogger("test_migration_010")
        self.logger.setLevel(logging.ERROR)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def add_file(self, stable_id: str, changes: list[tuple[str, str]], variant: str = "v") -> None:
        file_hash = stable_id * 8
        get_storage_path(self.files_dir, file_hash, "tei").write_bytes(tei(changes))
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute(
                "INSERT INTO files (id, stable_id, doc_id, variant, file_type) VALUES (?, ?, 'doc', ?, 'tei')",
                (file_hash, stable_id, variant)
            )

    def parents(self) -> dict[str, str | None]:
        with sqlite3.connect(str(self.db_path)) as conn:
            return dict(conn.execute("SELECT stable_id, parent_stable_id FROM files").fetchall())

    def test_parents_are_derived_from_the_revision_history(self):
        self.add_file("gold", [("#r", "1")])
        self.add_file("v1aa", [("#r", "1"), ("#a", "2")])
        self.add_file("v2aa", [("#r", "1"), ("#a", "2"), ("#a", "3")])
        self.add_file("othr", [("#r", "1"), ("#b", "2")], variant="w")  # other variant: no parent
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration010AddParentStableIdColumn(self.logger))
        self.assertEqual(manager.run_migrations(skip_backup=True), 1)
        self.assertEqual(self.parents(), {"gold": None, "v1aa": "gold", "v2aa": "v1aa", "othr": None})

    def test_migration_is_idempotent(self):
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration010AddParentStableIdColumn(self.logger))
        self.assertEqual(manager.run_migrations(skip_backup=True), 1)
        self.assertEqual(manager.run_migrations(skip_backup=True), 0)


if __name__ == "__main__":
    unittest.main()

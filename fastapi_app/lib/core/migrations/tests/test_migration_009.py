"""
Unit tests for migration 009 (document rules tables).

@testCovers fastapi_app/lib/core/migrations/versions/m009_document_rules_tables.py
"""

import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.migrations import MigrationManager
from fastapi_app.lib.core.migrations.versions.m009_document_rules_tables import (
    Migration009DocumentRulesTables,
)


class TestMigration009(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        # MigrationManager.run_migrations() is a no-op if the db file does not
        # exist yet, so create an empty database first (same pattern as the
        # other migration tests in this directory).
        sqlite3.connect(str(self.db_path)).close()
        self.logger = logging.getLogger("test_migration_009")
        self.logger.setLevel(logging.ERROR)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_migration_creates_both_tables(self):
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration009DocumentRulesTables(self.logger))
        applied = manager.run_migrations(skip_backup=True)
        self.assertEqual(applied, 1)

        with sqlite3.connect(str(self.db_path)) as conn:
            tables = {
                row[0] for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
        self.assertIn("resource_overrides", tables)
        self.assertIn("resource_selection", tables)

    def test_migration_is_idempotent(self):
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration009DocumentRulesTables(self.logger))
        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)
        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)

    def test_deleting_an_override_cascades_to_its_selection(self):
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration009DocumentRulesTables(self.logger))
        manager.run_migrations(skip_backup=True)

        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute(
                """INSERT INTO resource_overrides
                   (id, kind, resource_key, owner, note, text, format, base_url, base_hash, created_at, updated_at)
                   VALUES ('ov1', 'schema', 'key1', 'alice', '', 'text', 'xml', 'https://x', 'hash', 't', 't')"""
            )
            conn.execute(
                "INSERT INTO resource_selection (owner, kind, resource_key, override_id) "
                "VALUES ('alice', 'schema', 'key1', 'ov1')"
            )
            conn.execute("DELETE FROM resource_overrides WHERE id = 'ov1'")
            conn.commit()

            remaining = conn.execute("SELECT * FROM resource_selection").fetchall()
        self.assertEqual(remaining, [])

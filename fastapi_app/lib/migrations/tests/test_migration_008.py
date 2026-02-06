"""
Unit tests for migration 008: Change PRIMARY KEY from id to stable_id.

@testCovers fastapi_app/lib/migrations/versions/m008_change_primary_key.py
"""

import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.migrations import MigrationManager
from fastapi_app.lib.migrations.versions.m008_change_primary_key import (
    Migration008ChangePrimaryKey,
)


class TestMigration008ChangePrimaryKey(unittest.TestCase):
    """Test cases for migration 008."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        self.logger = logging.getLogger("test_migration_008")
        self.logger.setLevel(logging.ERROR)

    def tearDown(self):
        """Clean up test fixtures."""
        import shutil

        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)

    def _create_old_schema(self, conn: sqlite3.Connection):
        """Create files table with old schema (id as PRIMARY KEY)."""
        conn.execute("""
            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                stable_id TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                doc_id_type TEXT DEFAULT 'doi',
                file_type TEXT NOT NULL,
                mime_type TEXT,
                file_size INTEGER,
                label TEXT,
                variant TEXT,
                status TEXT,
                last_revision TEXT,
                version INTEGER DEFAULT 1,
                is_gold_standard BOOLEAN DEFAULT 0,
                deleted BOOLEAN DEFAULT 0,
                local_modified_at TIMESTAMP,
                remote_version INTEGER,
                sync_status TEXT DEFAULT 'synced',
                sync_hash TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by TEXT,
                doc_collections TEXT,
                doc_metadata TEXT,
                file_metadata TEXT
            )
        """)
        conn.commit()

    def _insert_test_files(self, conn: sqlite3.Connection):
        """Insert test files with unique content hashes."""
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections)
            VALUES ('hash1', 'stable1', 'doc1.pdf', 'doc1', 'pdf', '["collection-a"]')
        """)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant, doc_collections)
            VALUES ('hash2', 'stable2', 'doc1.xml', 'doc1', 'tei', 'variant1', '["collection-a"]')
        """)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections)
            VALUES ('hash3', 'stable3', 'doc2.pdf', 'doc2', 'pdf', '["collection-b"]')
        """)
        conn.commit()

    def _get_primary_key_column(self, conn: sqlite3.Connection) -> str:
        """Get the name of the PRIMARY KEY column."""
        cursor = conn.execute("PRAGMA table_info(files)")
        for row in cursor.fetchall():
            col_name, col_pk = row[1], row[5]
            if col_pk == 1:
                return col_name
        return None

    def test_migration_changes_primary_key(self):
        """Test migration changes PRIMARY KEY from id to stable_id."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_old_schema(conn)
            self._insert_test_files(conn)

            # Verify old schema has id as PRIMARY KEY
            pk_col = self._get_primary_key_column(conn)
            self.assertEqual(pk_col, "id")

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration008ChangePrimaryKey(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 1)

        # Verify new schema has stable_id as PRIMARY KEY
        with sqlite3.connect(str(self.db_path)) as conn:
            pk_col = self._get_primary_key_column(conn)
            self.assertEqual(pk_col, "stable_id")

    def test_migration_preserves_all_data(self):
        """Test migration preserves all existing data."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_old_schema(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration008ChangePrimaryKey(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify all data is preserved
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM files ORDER BY stable_id")
            rows = cursor.fetchall()

            self.assertEqual(len(rows), 3)

            # Check first file
            self.assertEqual(rows[0]["id"], "hash1")
            self.assertEqual(rows[0]["stable_id"], "stable1")
            self.assertEqual(rows[0]["doc_id"], "doc1")

            # Check second file
            self.assertEqual(rows[1]["id"], "hash2")
            self.assertEqual(rows[1]["stable_id"], "stable2")
            self.assertEqual(rows[1]["variant"], "variant1")

            # Check third file
            self.assertEqual(rows[2]["id"], "hash3")
            self.assertEqual(rows[2]["stable_id"], "stable3")
            self.assertEqual(rows[2]["doc_id"], "doc2")

    def test_migration_allows_duplicate_content_hash(self):
        """Test that after migration, duplicate content hashes are allowed."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_old_schema(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration008ChangePrimaryKey(self.logger))
        manager.run_migrations(skip_backup=True)

        # Now try to insert a file with duplicate content hash (different stable_id)
        with sqlite3.connect(str(self.db_path)) as conn:
            # This should succeed after migration (duplicate hash allowed)
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections)
                VALUES ('hash1', 'stable4', 'doc3.pdf', 'doc3', 'pdf', '["collection-c"]')
            """)
            conn.commit()

            # Verify both files exist
            cursor = conn.execute("SELECT COUNT(*) FROM files WHERE id = 'hash1'")
            count = cursor.fetchone()[0]
            self.assertEqual(count, 2)

    def test_migration_creates_content_hash_index(self):
        """Test migration creates index on content hash column."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_old_schema(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration008ChangePrimaryKey(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify idx_content_hash exists
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='index' AND name='idx_content_hash'
            """)
            index = cursor.fetchone()
            self.assertIsNotNone(index)

    def test_migration_is_idempotent(self):
        """Test migration can be run multiple times safely."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_old_schema(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration008ChangePrimaryKey(self.logger))

        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)  # Not re-applied

    def test_downgrade_works_without_duplicates(self):
        """Test downgrade works when no duplicate content hashes exist."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_old_schema(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        migration = Migration008ChangePrimaryKey(self.logger)
        manager.register_migration(migration)
        manager.run_migrations(skip_backup=True)

        # Verify stable_id is PRIMARY KEY
        with sqlite3.connect(str(self.db_path)) as conn:
            pk_col = self._get_primary_key_column(conn)
            self.assertEqual(pk_col, "stable_id")

        # Run downgrade
        with sqlite3.connect(str(self.db_path)) as conn:
            migration.downgrade(conn)
            conn.commit()

            # Verify id is PRIMARY KEY again
            pk_col = self._get_primary_key_column(conn)
            self.assertEqual(pk_col, "id")

    def test_downgrade_fails_with_duplicates(self):
        """Test downgrade fails when duplicate content hashes exist."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_old_schema(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        migration = Migration008ChangePrimaryKey(self.logger)
        manager.register_migration(migration)
        manager.run_migrations(skip_backup=True)

        # Add duplicate content hash
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type)
                VALUES ('hash1', 'stable4', 'doc3.pdf', 'doc3', 'pdf')
            """)
            conn.commit()

        # Downgrade should fail
        with sqlite3.connect(str(self.db_path)) as conn:
            with self.assertRaises(RuntimeError) as context:
                migration.downgrade(conn)

            self.assertIn("content hashes are shared", str(context.exception))

    def test_check_can_apply_returns_false_after_migration(self):
        """Test check_can_apply returns False when already migrated."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_old_schema(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        migration = Migration008ChangePrimaryKey(self.logger)
        manager.register_migration(migration)
        manager.run_migrations(skip_backup=True)

        # check_can_apply should return False
        with sqlite3.connect(str(self.db_path)) as conn:
            can_apply = migration.check_can_apply(conn)
            self.assertFalse(can_apply)


if __name__ == "__main__":
    unittest.main()

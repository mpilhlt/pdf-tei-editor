"""
Unit tests for migration 002: Sync TEI collections.

@testCovers fastapi_app/lib/migrations/versions/m002_sync_tei_collections.py
"""

import json
import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.migrations import MigrationManager
from fastapi_app.lib.migrations.versions.m002_sync_tei_collections import (
    Migration002SyncTeiCollections,
)


class TestMigration002SyncTeiCollections(unittest.TestCase):
    """Test cases for migration 002."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        # Create logger configured to suppress expected warnings
        self.logger = logging.getLogger("test_migration_002")
        self.logger.setLevel(logging.ERROR)  # Suppress INFO and WARNING

    def tearDown(self):
        """Clean up test fixtures."""
        import shutil

        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)

    def _create_files_table(self, conn: sqlite3.Connection):
        """Create files table with schema."""
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
                version INTEGER DEFAULT 1,
                is_gold_standard BOOLEAN DEFAULT 0,
                deleted BOOLEAN DEFAULT 0,
                local_modified_at TIMESTAMP,
                remote_version INTEGER,
                sync_status TEXT DEFAULT 'synced',
                sync_hash TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                doc_collections TEXT,
                doc_metadata TEXT,
                file_metadata TEXT
            )
        """)
        conn.commit()

    def _insert_test_files(self, conn: sqlite3.Connection):
        """Insert test files with mismatched collections."""
        # Document 1: PDF in collection-a, TEI in collection-b (needs sync)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections)
            VALUES ('pdf1', 'pdf1id', 'doc1.pdf', 'doc1', 'pdf', '["collection-a"]')
        """)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant, doc_collections)
            VALUES ('tei1', 'tei1id', 'doc1.xml', 'doc1', 'tei', 'variant1', '["collection-b"]')
        """)

        # Document 2: PDF and TEI already in same collection (no sync needed)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections)
            VALUES ('pdf2', 'pdf2id', 'doc2.pdf', 'doc2', 'pdf', '["collection-c"]')
        """)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant, doc_collections)
            VALUES ('tei2', 'tei2id', 'doc2.xml', 'doc2', 'tei', 'variant1', '["collection-c"]')
        """)

        # Document 3: PDF in multiple collections, TEI in different collection
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections)
            VALUES ('pdf3', 'pdf3id', 'doc3.pdf', 'doc3', 'pdf', '["collection-d", "collection-e"]')
        """)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant, doc_collections)
            VALUES ('tei3a', 'tei3aid', 'doc3a.xml', 'doc3', 'tei', 'variant1', '["collection-f"]')
        """)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant, doc_collections)
            VALUES ('tei3b', 'tei3bid', 'doc3b.xml', 'doc3', 'tei', 'variant2', '["collection-g"]')
        """)

        conn.commit()

    def test_migration_applies_successfully(self):
        """Test migration updates mismatched TEI files."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)
            self._insert_test_files(conn)

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration002SyncTeiCollections(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 1)

        # Verify TEI files now match PDF collections
        with sqlite3.connect(str(self.db_path)) as conn:
            # Document 1: TEI should now be in collection-a
            cursor = conn.execute(
                "SELECT doc_collections FROM files WHERE id = 'tei1'"
            )
            tei1_collections = cursor.fetchone()[0]
            self.assertEqual(tei1_collections, '["collection-a"]')

            # Document 2: TEI should remain in collection-c
            cursor = conn.execute(
                "SELECT doc_collections FROM files WHERE id = 'tei2'"
            )
            tei2_collections = cursor.fetchone()[0]
            self.assertEqual(tei2_collections, '["collection-c"]')

            # Document 3: Both TEI files should now match PDF
            cursor = conn.execute(
                "SELECT doc_collections FROM files WHERE id = 'tei3a'"
            )
            tei3a_collections = cursor.fetchone()[0]
            self.assertEqual(tei3a_collections, '["collection-d", "collection-e"]')

            cursor = conn.execute(
                "SELECT doc_collections FROM files WHERE id = 'tei3b'"
            )
            tei3b_collections = cursor.fetchone()[0]
            self.assertEqual(tei3b_collections, '["collection-d", "collection-e"]')

    def test_migration_is_idempotent(self):
        """Test migration can be run multiple times safely."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration002SyncTeiCollections(self.logger))

        # Run migration twice
        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)  # Not re-applied

    def test_migration_skips_when_no_mismatches(self):
        """Test migration skips when all TEI files already match."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)

            # Only insert matched files
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections)
                VALUES ('pdf1', 'pdf1id', 'doc1.pdf', 'doc1', 'pdf', '["collection-a"]')
            """)
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant, doc_collections)
                VALUES ('tei1', 'tei1id', 'doc1.xml', 'doc1', 'tei', 'variant1', '["collection-a"]')
            """)
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration002SyncTeiCollections(self.logger))

        applied = manager.run_migrations(skip_backup=True)

        # Migration should be skipped
        self.assertEqual(applied, 0)

    def test_migration_skips_deleted_files(self):
        """Test migration ignores soft-deleted files."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)

            # Insert files with mismatched collections but TEI is deleted
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections)
                VALUES ('pdf1', 'pdf1id', 'doc1.pdf', 'doc1', 'pdf', '["collection-a"]')
            """)
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant, doc_collections, deleted)
                VALUES ('tei1', 'tei1id', 'doc1.xml', 'doc1', 'tei', 'variant1', '["collection-b"]', 1)
            """)
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration002SyncTeiCollections(self.logger))

        applied = manager.run_migrations(skip_backup=True)

        # Should skip because deleted TEI file is ignored
        self.assertEqual(applied, 0)

        # Verify deleted TEI was not updated
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute(
                "SELECT doc_collections FROM files WHERE id = 'tei1'"
            )
            tei_collections = cursor.fetchone()[0]
            self.assertEqual(tei_collections, '["collection-b"]')  # Unchanged

    def test_migration_updates_sync_status(self):
        """Test migration sets sync_status to modified."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)

            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, doc_collections, sync_status)
                VALUES ('pdf1', 'pdf1id', 'doc1.pdf', 'doc1', 'pdf', '["collection-a"]', 'synced')
            """)
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant, doc_collections, sync_status)
                VALUES ('tei1', 'tei1id', 'doc1.xml', 'doc1', 'tei', 'variant1', '["collection-b"]', 'synced')
            """)
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration002SyncTeiCollections(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify sync_status was updated
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute(
                "SELECT sync_status FROM files WHERE id = 'tei1'"
            )
            sync_status = cursor.fetchone()[0]
            self.assertEqual(sync_status, 'modified')

    def test_downgrade_raises_not_implemented(self):
        """Test downgrade raises NotImplementedError."""
        migration = Migration002SyncTeiCollections(self.logger)

        with sqlite3.connect(str(self.db_path)) as conn:
            with self.assertRaises(NotImplementedError) as context:
                migration.downgrade(conn)

            self.assertIn("cannot be automatically reverted", str(context.exception))


if __name__ == "__main__":
    unittest.main()

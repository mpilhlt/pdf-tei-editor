"""
Unit tests for migration 004: Encode PDF document IDs.

@testCovers fastapi_app/lib/migrations/versions/m004_encode_pdf_doc_ids.py
"""

import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.migrations import MigrationManager
from fastapi_app.lib.core.migrations.versions.m004_encode_pdf_doc_ids import (
    Migration004EncodePdfDocIds,
)
from fastapi_app.lib.utils.doi_utils import encode_filename


class TestMigration004EncodePdfDocIds(unittest.TestCase):
    """Test cases for migration 004."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        # Create logger configured to suppress expected warnings
        self.logger = logging.getLogger("test_migration_004")
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
        """Insert test files with various doc_id formats."""
        # DOI with forward slash (needs encoding)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type)
            VALUES ('pdf1', 'pdf1id', 'doc1.pdf', '10.1111/1467-6478.00040', 'pdf')
        """)

        # DOI with colon (needs encoding)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type)
            VALUES ('pdf2', 'pdf2id', 'doc2.pdf', '10.1234/test:file', 'pdf')
        """)

        # Already encoded DOI (should be skipped)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type)
            VALUES ('pdf3', 'pdf3id', 'doc3.pdf', '10.5555__encoded-doi', 'pdf')
        """)

        # Simple filename (no encoding needed)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type)
            VALUES ('pdf4', 'pdf4id', 'doc4.pdf', 'simple-filename', 'pdf')
        """)

        # DOI with special characters (needs encoding)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type)
            VALUES ('pdf5', 'pdf5id', 'doc5.pdf', '10.1234/doc<name>', 'pdf')
        """)

        # Multiple files with same doc_id (all should be updated)
        conn.execute("""
            INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant)
            VALUES ('tei1', 'tei1id', 'doc1.xml', '10.1111/1467-6478.00040', 'tei', 'variant1')
        """)

        conn.commit()

    def test_migration_applies_successfully(self):
        """Test migration encodes non-compliant doc_ids."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)
            self._insert_test_files(conn)

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration004EncodePdfDocIds(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 1)

        # Verify doc_ids were encoded correctly
        with sqlite3.connect(str(self.db_path)) as conn:
            # pdf1 and tei1: forward slash encoded
            cursor = conn.execute(
                "SELECT doc_id FROM files WHERE id = 'pdf1'"
            )
            doc_id = cursor.fetchone()[0]
            self.assertEqual(doc_id, '10.1111__1467-6478.00040')

            cursor = conn.execute(
                "SELECT doc_id FROM files WHERE id = 'tei1'"
            )
            doc_id = cursor.fetchone()[0]
            self.assertEqual(doc_id, '10.1111__1467-6478.00040')

            # pdf2: colon encoded
            cursor = conn.execute(
                "SELECT doc_id FROM files WHERE id = 'pdf2'"
            )
            doc_id = cursor.fetchone()[0]
            self.assertEqual(doc_id, encode_filename('10.1234/test:file'))

            # pdf3: already encoded, unchanged
            cursor = conn.execute(
                "SELECT doc_id FROM files WHERE id = 'pdf3'"
            )
            doc_id = cursor.fetchone()[0]
            self.assertEqual(doc_id, '10.5555__encoded-doi')

            # pdf4: no encoding needed
            cursor = conn.execute(
                "SELECT doc_id FROM files WHERE id = 'pdf4'"
            )
            doc_id = cursor.fetchone()[0]
            self.assertEqual(doc_id, 'simple-filename')

            # pdf5: special characters encoded
            cursor = conn.execute(
                "SELECT doc_id FROM files WHERE id = 'pdf5'"
            )
            doc_id = cursor.fetchone()[0]
            self.assertEqual(doc_id, encode_filename('10.1234/doc<name>'))

    def test_migration_is_idempotent(self):
        """Test migration can be run multiple times safely."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)
            self._insert_test_files(conn)

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration004EncodePdfDocIds(self.logger))

        # Run migration twice
        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)  # Not re-applied

    def test_migration_skips_when_all_encoded(self):
        """Test migration skips when all doc_ids are already encoded."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)

            # Only insert files with encoded or simple doc_ids
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type)
                VALUES ('pdf1', 'pdf1id', 'doc1.pdf', '10.5555__encoded-doi', 'pdf')
            """)
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type)
                VALUES ('pdf2', 'pdf2id', 'doc2.pdf', 'simple-filename', 'pdf')
            """)
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration004EncodePdfDocIds(self.logger))

        applied = manager.run_migrations(skip_backup=True)

        # Migration should be skipped
        self.assertEqual(applied, 0)

    def test_migration_skips_deleted_files(self):
        """Test migration ignores soft-deleted files."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)

            # Insert file with non-encoded doc_id but marked as deleted
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, deleted)
                VALUES ('pdf1', 'pdf1id', 'doc1.pdf', '10.1111/needs-encoding', 'pdf', 1)
            """)
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration004EncodePdfDocIds(self.logger))

        applied = manager.run_migrations(skip_backup=True)

        # Should skip because deleted files are ignored
        self.assertEqual(applied, 0)

        # Verify deleted file was not updated
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute(
                "SELECT doc_id FROM files WHERE id = 'pdf1'"
            )
            doc_id = cursor.fetchone()[0]
            self.assertEqual(doc_id, '10.1111/needs-encoding')  # Unchanged

    def test_migration_updates_sync_status(self):
        """Test migration sets sync_status to modified."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)

            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, sync_status)
                VALUES ('pdf1', 'pdf1id', 'doc1.pdf', '10.1111/needs-encoding', 'pdf', 'synced')
            """)
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration004EncodePdfDocIds(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify sync_status was updated
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute(
                "SELECT sync_status FROM files WHERE id = 'pdf1'"
            )
            sync_status = cursor.fetchone()[0]
            self.assertEqual(sync_status, 'modified')

    def test_downgrade_raises_not_implemented(self):
        """Test downgrade raises NotImplementedError."""
        migration = Migration004EncodePdfDocIds(self.logger)

        with sqlite3.connect(str(self.db_path)) as conn:
            with self.assertRaises(NotImplementedError) as context:
                migration.downgrade(conn)

            self.assertIn("cannot be automatically reverted", str(context.exception))

    def test_migration_handles_multiple_files_same_doc_id(self):
        """Test migration updates all files with the same doc_id."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table(conn)

            # Insert multiple files with same non-encoded doc_id
            doc_id = '10.1234/test-doc'
            for i in range(3):
                conn.execute("""
                    INSERT INTO files (id, stable_id, filename, doc_id, file_type, variant)
                    VALUES (?, ?, ?, ?, 'tei', ?)
                """, (f'file{i}', f'stable{i}', f'doc{i}.xml', doc_id, f'variant{i}'))
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration004EncodePdfDocIds(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify all files were updated
        expected_doc_id = encode_filename(doc_id)
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("SELECT doc_id FROM files")
            doc_ids = [row[0] for row in cursor.fetchall()]
            self.assertEqual(len(doc_ids), 3)
            for actual_doc_id in doc_ids:
                self.assertEqual(actual_doc_id, expected_doc_id)


if __name__ == "__main__":
    unittest.main()

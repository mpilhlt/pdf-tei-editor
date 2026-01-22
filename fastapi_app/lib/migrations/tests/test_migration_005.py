"""
Unit tests for migration 005: Add status column.

@testCovers fastapi_app/lib/migrations/versions/m005_add_status_column.py
"""

import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.migrations import MigrationManager
from fastapi_app.lib.migrations.versions.m005_add_status_column import (
    Migration005AddStatusColumn,
)


class TestMigration005AddStatusColumn(unittest.TestCase):
    """Test cases for migration 005."""

    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        # Match production structure: data/db/metadata.db and data/files/
        self.db_dir = Path(self.temp_dir) / "db"
        self.db_dir.mkdir()
        self.db_path = self.db_dir / "test.db"
        self.files_dir = Path(self.temp_dir) / "files"
        self.files_dir.mkdir()

        # Create logger configured to suppress expected warnings
        self.logger = logging.getLogger("test_migration_005")
        self.logger.setLevel(logging.ERROR)  # Suppress INFO and WARNING

    def tearDown(self):
        """Clean up test fixtures."""
        import shutil

        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)

    def _create_files_table_without_status(self, conn: sqlite3.Connection):
        """Create files table without status column (pre-migration schema)."""
        conn.execute("DROP TABLE IF EXISTS files")
        conn.commit()
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

    def _create_test_tei_file(self, file_id: str, status: str = "draft") -> bytes:
        """Create a test TEI XML file with a specific status."""
        tei_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title level="a">Test Document</title>
      </titleStmt>
      <publicationStmt>
        <publisher>Test Publisher</publisher>
      </publicationStmt>
      <sourceDesc>
        <bibl>Test</bibl>
      </sourceDesc>
    </fileDesc>
    <revisionDesc>
      <change when="2024-01-01" status="{status}">
        <desc>Test change</desc>
      </change>
    </revisionDesc>
  </teiHeader>
  <text>
    <body>
      <p>Test content</p>
    </body>
  </text>
</TEI>"""
        return tei_xml.encode('utf-8')

    def test_migration_adds_status_column(self):
        """Test migration adds status column to files table."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table_without_status(conn)

            # Verify status column doesn't exist
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertNotIn("status", columns)

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 1)

        # Verify status column now exists
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertIn("status", columns)

    def test_migration_creates_status_index(self):
        """Test migration creates index on status column."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table_without_status(conn)

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify index exists
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='index' AND name='idx_status'
            """)
            index = cursor.fetchone()
            self.assertIsNotNone(index)

    def test_migration_populates_status_from_tei_files(self):
        """Test migration extracts status from existing TEI files."""
        # Use INFO logging for this test to see migration details
        import logging
        test_logger = logging.getLogger("test_migration_005_debug")
        test_logger.setLevel(logging.INFO)
        handler = logging.StreamHandler()
        handler.setLevel(logging.INFO)
        test_logger.addHandler(handler)

        # Create physical TEI files in storage first to get their hashes
        from fastapi_app.lib.file_storage import FileStorage
        from fastapi_app.lib.database import DatabaseManager
        db_manager = DatabaseManager(self.db_path, test_logger)
        file_storage = FileStorage(self.files_dir, db_manager, logger=test_logger)

        # Create and save TEI files with different statuses
        tei_draft_content = self._create_test_tei_file('tei_draft', 'draft')
        tei_published_content = self._create_test_tei_file('tei_published', 'published')

        draft_hash, _ = file_storage.save_file(tei_draft_content, 'tei', increment_ref=False)
        published_hash, _ = file_storage.save_file(tei_published_content, 'tei', increment_ref=False)

        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table_without_status(conn)

            # Insert TEI files using the actual content hashes
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, file_size)
                VALUES (?, 'draft123', 'doc1.xml', 'doc1', 'tei', 1000)
            """, (draft_hash,))
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, file_size)
                VALUES (?, 'pub123', 'doc2.xml', 'doc2', 'tei', 1000)
            """, (published_hash,))
            conn.commit()

        # Run migration with debug logger
        manager = MigrationManager(self.db_path, test_logger)
        manager.register_migration(Migration005AddStatusColumn(test_logger))
        manager.run_migrations(skip_backup=True)

        # Verify status was extracted and saved
        with sqlite3.connect(str(self.db_path)) as conn:
            # Check draft file
            cursor = conn.execute("SELECT status FROM files WHERE id = ?", (draft_hash,))
            status = cursor.fetchone()
            self.assertIsNotNone(status)
            self.assertEqual(status[0], 'draft')

            # Check published file
            cursor = conn.execute("SELECT status FROM files WHERE id = ?", (published_hash,))
            status = cursor.fetchone()
            self.assertIsNotNone(status)
            self.assertEqual(status[0], 'published')

    def test_migration_skips_files_without_status(self):
        """Test migration handles TEI files without status attribute."""
        # Create TEI file without status attribute
        tei_no_status = b"""<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title level="a">Test Document</title>
      </titleStmt>
    </fileDesc>
    <revisionDesc>
      <change when="2024-01-01">
        <desc>Test change without status</desc>
      </change>
    </revisionDesc>
  </teiHeader>
  <text>
    <body>
      <p>Test content</p>
    </body>
  </text>
</TEI>"""

        from fastapi_app.lib.file_storage import FileStorage
        from fastapi_app.lib.database import DatabaseManager
        db_manager = DatabaseManager(self.db_path, self.logger)
        file_storage = FileStorage(self.files_dir, db_manager, logger=self.logger)
        no_status_hash, _ = file_storage.save_file(tei_no_status, 'tei', increment_ref=False)

        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table_without_status(conn)

            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, file_size)
                VALUES (?, 'nostatus', 'doc3.xml', 'doc3', 'tei', 1000)
            """, (no_status_hash,))
            conn.commit()

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify status is NULL for file without status
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("SELECT status FROM files WHERE id = ?", (no_status_hash,))
            status = cursor.fetchone()
            self.assertIsNone(status[0])

    def test_migration_only_processes_tei_files(self):
        """Test migration only processes TEI files, not PDF files."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table_without_status(conn)

            # Insert PDF file
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, file_size)
                VALUES ('pdf1', 'pdf123', 'doc1.pdf', 'doc1', 'pdf', 5000)
            """)
            conn.commit()

        # Run migration (should not fail even though PDF has no TEI content)
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify PDF file status is NULL
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("SELECT status FROM files WHERE id = 'pdf1'")
            status = cursor.fetchone()
            self.assertIsNone(status[0])

    def test_migration_is_idempotent(self):
        """Test migration can be run multiple times safely."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table_without_status(conn)

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))

        # Run migration twice
        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)  # Not re-applied

    def test_migration_skips_if_column_exists(self):
        """Test migration skips if status column already exists."""
        with sqlite3.connect(str(self.db_path)) as conn:
            # Create table WITH status column
            self._create_files_table_without_status(conn)
            conn.execute("ALTER TABLE files ADD COLUMN status TEXT")
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))

        applied = manager.run_migrations(skip_backup=True)

        # Migration should be skipped
        self.assertEqual(applied, 0)

    def test_migration_handles_missing_files_dir(self):
        """Test migration handles case where files directory doesn't exist."""
        with sqlite3.connect(str(self.db_path)) as conn:
            self._create_files_table_without_status(conn)

        # Remove files directory
        import shutil
        shutil.rmtree(self.files_dir)

        # Run migration (should complete without error but not populate status)
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        # Migration should still apply (schema change), just skip data population
        self.assertEqual(applied, 1)

    def test_downgrade_raises_not_implemented(self):
        """Test downgrade raises NotImplementedError."""
        migration = Migration005AddStatusColumn(self.logger)

        with sqlite3.connect(str(self.db_path)) as conn:
            with self.assertRaises(NotImplementedError) as context:
                migration.downgrade(conn)

            self.assertIn("cannot be reverted", str(context.exception))


if __name__ == "__main__":
    unittest.main()





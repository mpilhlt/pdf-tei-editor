"""
Unit tests for migrations 005, 006, and 007: Add status, last_revision, and created_by columns.

@testCovers fastapi_app/lib/migrations/versions/m005_add_status_column.py
@testCovers fastapi_app/lib/migrations/versions/m006_add_last_revision_column.py
@testCovers fastapi_app/lib/migrations/versions/m007_add_created_by_column.py
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
from fastapi_app.lib.migrations.versions.m006_add_last_revision_column import (
    Migration006AddLastRevisionColumn,
)
from fastapi_app.lib.migrations.versions.m007_add_created_by_column import (
    Migration007AddCreatedByColumn,
)


class TestMigrations005To007(unittest.TestCase):
    """Test cases for migrations 005 (status), 006 (last_revision), and 007 (created_by)."""

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

        # Initialize database with full schema and all migrations
        from fastapi_app.lib.database import DatabaseManager
        self.db_manager = DatabaseManager(self.db_path, self.logger)

    def tearDown(self):
        """Clean up test fixtures."""
        import shutil

        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)

    def _rollback_to_version_4(self):
        """Roll back migrations to version 4 (pre-migration-005 state)."""
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))
        manager.register_migration(Migration006AddLastRevisionColumn(self.logger))
        manager.register_migration(Migration007AddCreatedByColumn(self.logger))
        manager.rollback_migration(4)

    def _rollback_to_version_5(self):
        """Roll back migrations to version 5 (pre-migration-006 state)."""
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration006AddLastRevisionColumn(self.logger))
        manager.register_migration(Migration007AddCreatedByColumn(self.logger))
        manager.rollback_migration(5)

    def _rollback_to_version_6(self):
        """Roll back migrations to version 6 (pre-migration-007 state)."""
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration007AddCreatedByColumn(self.logger))
        manager.rollback_migration(6)

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
        self._rollback_to_version_4()

        # Verify status column doesn't exist
        with sqlite3.connect(str(self.db_path)) as conn:
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
        self._rollback_to_version_4()

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
        from fastapi_app.lib.file_storage import FileStorage
        file_storage = FileStorage(self.files_dir, self.db_manager, logger=self.logger)

        # Create and save TEI files with different statuses
        tei_draft_content = self._create_test_tei_file('tei_draft', 'draft')
        tei_published_content = self._create_test_tei_file('tei_published', 'published')

        draft_hash, _ = file_storage.save_file(tei_draft_content, 'tei', increment_ref=False)
        published_hash, _ = file_storage.save_file(tei_published_content, 'tei', increment_ref=False)

        self._rollback_to_version_4()

        # Insert TEI files using the actual content hashes
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, file_size)
                VALUES (?, 'draft123', 'doc1.xml', 'doc1', 'tei', 1000)
            """, (draft_hash,))
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, file_size)
                VALUES (?, 'pub123', 'doc2.xml', 'doc2', 'tei', 1000)
            """, (published_hash,))
            conn.commit()

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))
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
        file_storage = FileStorage(self.files_dir, self.db_manager, logger=self.logger)
        no_status_hash, _ = file_storage.save_file(tei_no_status, 'tei', increment_ref=False)

        self._rollback_to_version_4()

        with sqlite3.connect(str(self.db_path)) as conn:
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
        self._rollback_to_version_4()

        # Insert PDF file
        with sqlite3.connect(str(self.db_path)) as conn:
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
        self._rollback_to_version_4()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))

        # Run migration twice
        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)  # Not re-applied

    def test_migration_skips_if_column_exists(self):
        """Test migration skips if status column already exists."""
        self._rollback_to_version_4()

        # Add status column manually
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("ALTER TABLE files ADD COLUMN status TEXT")
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))

        applied = manager.run_migrations(skip_backup=True)

        # Migration should be skipped
        self.assertEqual(applied, 0)

    def test_migration_handles_missing_files_dir(self):
        """Test migration handles case where files directory doesn't exist."""
        self._rollback_to_version_4()

        # Remove files directory
        import shutil
        shutil.rmtree(self.files_dir)

        # Run migration (should complete without error but not populate status)
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration005AddStatusColumn(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        # Migration should still apply (schema change), just skip data population
        self.assertEqual(applied, 1)

    def test_downgrade_removes_status_column(self):
        """Test downgrade removes status column and index."""
        # Verify status column exists (from setUp migrations)
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertIn("status", columns)

        # Run downgrade
        self._rollback_to_version_4()

        # Verify status column is removed
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertNotIn("status", columns)

            # Verify index is also removed
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='index' AND name='idx_status'
            """)
            index = cursor.fetchone()
            self.assertIsNone(index)

    # ===== Migration 006 Tests =====

    def test_migration_006_adds_last_revision_column(self):
        """Test migration 006 adds last_revision column to files table."""
        self._rollback_to_version_5()

        # Verify last_revision column doesn't exist
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertNotIn("last_revision", columns)

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration006AddLastRevisionColumn(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 1)

        # Verify last_revision column now exists
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertIn("last_revision", columns)

    def test_migration_006_populates_last_revision_from_tei_files(self):
        """Test migration 006 extracts last_revision timestamp from TEI files."""
        from fastapi_app.lib.file_storage import FileStorage
        file_storage = FileStorage(self.files_dir, self.db_manager, logger=self.logger)

        # Create and save TEI file (uses the helper which includes when="2024-01-01")
        tei_content = self._create_test_tei_file('tei_test', 'draft')
        file_hash, _ = file_storage.save_file(tei_content, 'tei', increment_ref=False)

        self._rollback_to_version_5()

        # Insert TEI file
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, file_size)
                VALUES (?, 'test123', 'doc1.xml', 'doc1', 'tei', 1000)
            """, (file_hash,))
            conn.commit()

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration006AddLastRevisionColumn(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify last_revision was extracted and saved
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("SELECT last_revision FROM files WHERE id = ?", (file_hash,))
            result = cursor.fetchone()
            self.assertIsNotNone(result)
            self.assertEqual(result[0], '2024-01-01')

    def test_migration_006_downgrade_removes_last_revision_column(self):
        """Test downgrade removes last_revision column and index."""
        # Verify last_revision column exists (from setUp migrations)
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertIn("last_revision", columns)

        # Run downgrade
        self._rollback_to_version_5()

        # Verify last_revision column is removed
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertNotIn("last_revision", columns)

            # Verify index is also removed
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='index' AND name='idx_last_revision'
            """)
            index = cursor.fetchone()
            self.assertIsNone(index)

    # ===== Migration 007 Tests =====

    def test_migration_007_adds_created_by_column(self):
        """Test migration 007 adds created_by column to files table."""
        self._rollback_to_version_6()

        # Verify created_by column doesn't exist
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertNotIn("created_by", columns)

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration007AddCreatedByColumn(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 1)

        # Verify created_by column now exists
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertIn("created_by", columns)

    def test_migration_007_creates_created_by_index(self):
        """Test migration 007 creates index on created_by column."""
        self._rollback_to_version_6()

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration007AddCreatedByColumn(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify index exists
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='index' AND name='idx_created_by'
            """)
            index = cursor.fetchone()
            self.assertIsNotNone(index)

    def test_migration_007_existing_files_have_null_created_by(self):
        """Test that existing files have NULL created_by after migration."""
        self._rollback_to_version_6()

        # Insert file without created_by
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("""
                INSERT INTO files (id, stable_id, filename, doc_id, file_type, file_size)
                VALUES ('test1', 'test123', 'doc1.xml', 'doc1', 'tei', 1000)
            """)
            conn.commit()

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration007AddCreatedByColumn(self.logger))
        manager.run_migrations(skip_backup=True)

        # Verify created_by is NULL for existing file
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("SELECT created_by FROM files WHERE id = 'test1'")
            result = cursor.fetchone()
            self.assertIsNone(result[0])

    def test_migration_007_is_idempotent(self):
        """Test migration 007 can be run multiple times safely."""
        self._rollback_to_version_6()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration007AddCreatedByColumn(self.logger))

        # Run migration twice
        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)  # Not re-applied

    def test_migration_007_skips_if_column_exists(self):
        """Test migration 007 skips if created_by column already exists."""
        self._rollback_to_version_6()

        # Add created_by column manually
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("ALTER TABLE files ADD COLUMN created_by TEXT")
            conn.commit()

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(Migration007AddCreatedByColumn(self.logger))

        applied = manager.run_migrations(skip_backup=True)

        # Migration should be skipped
        self.assertEqual(applied, 0)

    def test_migration_007_downgrade_removes_created_by_column(self):
        """Test downgrade removes created_by column and index."""
        # Verify created_by column exists (from setUp migrations)
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertIn("created_by", columns)

        # Run downgrade
        self._rollback_to_version_6()

        # Verify created_by column is removed
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(files)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertNotIn("created_by", columns)

            # Verify index is also removed
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='index' AND name='idx_created_by'
            """)
            index = cursor.fetchone()
            self.assertIsNone(index)


if __name__ == "__main__":
    unittest.main()





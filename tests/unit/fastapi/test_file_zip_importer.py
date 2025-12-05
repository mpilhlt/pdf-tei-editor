"""
Unit tests for FileZipImporter.

Tests:
- Basic ZIP import (PDF and TEI)
- ZIP with single root directory structure
- ZIP with files at root
- Empty ZIP handling
- Invalid ZIP handling
- Collection assignment
- Recursive collections mode
- Cleanup after import

@testCovers fastapi_app/lib/file_zip_importer.py
"""

import unittest
import tempfile
import shutil
import zipfile
import os
from pathlib import Path
from unittest.mock import patch

from fastapi_app.lib.file_zip_importer import FileZipImporter
from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.collection_utils import get_available_collections
from fastapi_app.config import get_settings


class TestFileZipImporter(unittest.TestCase):
    """Test file zip importer functionality."""

    def setUp(self):
        """Create temporary directories and initialize components."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "test.db"
        self.storage_root = self.test_dir / "storage"
        self.zip_dir = self.test_dir / "zips"
        self.db_dir = self.test_dir / "db"

        self.storage_root.mkdir()
        self.zip_dir.mkdir()
        self.db_dir.mkdir()

        # Create empty collections.json file
        collections_file = self.db_dir / "collections.json"
        collections_file.write_text("[]")

        # Initialize database and components
        self.db = DatabaseManager(self.db_path)
        self.storage = FileStorage(self.storage_root, self.db_path)
        self.repo = FileRepository(self.db)

    def tearDown(self):
        """Clean up temporary directories."""
        import gc
        gc.collect()
        shutil.rmtree(self.test_dir)

    def create_test_pdf(self, content: str = "test pdf") -> bytes:
        """Create minimal PDF content."""
        return f"%PDF-1.4\n{content}\n%%EOF".encode('utf-8')

    def create_test_tei(self, doc_id: str = "10.1234/test", title: str = "Test") -> bytes:
        """Create minimal TEI XML content."""
        tei_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt><title>{title}</title></titleStmt>
            <publicationStmt><publisher>Test</publisher></publicationStmt>
            <sourceDesc>
                <biblStruct>
                    <analytic><title>{title}</title></analytic>
                    <monogr><imprint><date>2024</date></imprint></monogr>
                    <idno type="DOI">{doc_id}</idno>
                </biblStruct>
            </sourceDesc>
        </fileDesc>
    </teiHeader>
    <text><body><p>Test content</p></body></text>
</TEI>
"""
        return tei_content.encode('utf-8')

    def create_zip_with_structure(
        self,
        zip_name: str,
        structure: dict,
        root_dir: str = "export"
    ) -> Path:
        """
        Create a ZIP file with specified directory structure.

        Args:
            zip_name: Name of zip file
            structure: Dict mapping paths to content (bytes)
                      e.g., {"pdf/test.pdf": b"...", "tei/test.tei.xml": b"..."}
            root_dir: Root directory name inside zip (None for files at root)

        Returns:
            Path to created zip file
        """
        zip_path = self.zip_dir / zip_name

        with zipfile.ZipFile(zip_path, 'w') as zipf:
            for file_path, content in structure.items():
                if root_dir:
                    arcname = f"{root_dir}/{file_path}"
                else:
                    arcname = file_path
                zipf.writestr(arcname, content)

        return zip_path

    def test_import_basic_structure(self):
        """Test importing ZIP with basic type-grouped structure."""
        # Create ZIP with pdf/ and tei/ directories
        structure = {
            "pdf/10.1234__test.pdf": self.create_test_pdf("doc1"),
            "tei/10.1234__test.tei.xml": self.create_test_tei("10.1234/test", "Document 1")
        }
        zip_path = self.create_zip_with_structure("test.zip", structure)

        # Import
        importer = FileZipImporter(self.db, self.storage, self.repo)
        stats = importer.import_from_zip(zip_path)
        importer.cleanup()

        # Verify
        self.assertEqual(stats['files_imported'], 2)
        self.assertEqual(stats['files_skipped'], 0)
        self.assertEqual(len(stats['errors']), 0)

        # Check database
        files = self.repo.get_files_by_doc_id("10.1234/test")
        self.assertEqual(len(files), 2)
        pdf_file = [f for f in files if f.file_type == 'pdf'][0]
        tei_file = [f for f in files if f.file_type == 'tei'][0]

        self.assertEqual(pdf_file.doc_id, "10.1234/test")
        self.assertEqual(tei_file.doc_id, "10.1234/test")
        self.assertTrue(tei_file.is_gold_standard)

    def test_import_with_single_root_directory(self):
        """Test importing ZIP that has a single root directory."""
        structure = {
            "pdf/test.pdf": self.create_test_pdf(),
            "tei/test.tei.xml": self.create_test_tei()
        }
        zip_path = self.create_zip_with_structure("test.zip", structure, root_dir="export")

        importer = FileZipImporter(self.db, self.storage, self.repo)
        stats = importer.import_from_zip(zip_path)
        importer.cleanup()

        self.assertEqual(stats['files_imported'], 2)
        self.assertEqual(len(stats['errors']), 0)

    def test_import_with_files_at_root(self):
        """Test importing ZIP with files directly at root (no single root dir)."""
        structure = {
            "pdf/test.pdf": self.create_test_pdf(),
            "tei/test.tei.xml": self.create_test_tei()
        }
        # Create without root directory
        zip_path = self.create_zip_with_structure("test.zip", structure, root_dir=None)

        importer = FileZipImporter(self.db, self.storage, self.repo)
        stats = importer.import_from_zip(zip_path)
        importer.cleanup()

        self.assertEqual(stats['files_imported'], 2)
        self.assertEqual(len(stats['errors']), 0)

    def test_import_with_collection_assignment(self):
        """Test importing with collection assignment."""
        structure = {
            "pdf/test.pdf": self.create_test_pdf(),
            "tei/test.tei.xml": self.create_test_tei()
        }
        zip_path = self.create_zip_with_structure("test.zip", structure)

        importer = FileZipImporter(self.db, self.storage, self.repo)
        stats = importer.import_from_zip(zip_path, collection="corpus1")
        importer.cleanup()

        self.assertEqual(stats['files_imported'], 2)

        # Check that files have collection assigned
        files = self.repo.get_files_by_doc_id("10.1234/test")
        for file in files:
            self.assertIn("corpus1", file.doc_collections)

    def test_import_with_recursive_collections(self):
        """Test importing with recursive collections mode."""
        structure = {
            "collection1/pdf/doc1.pdf": self.create_test_pdf("doc1"),
            "collection1/tei/doc1.tei.xml": self.create_test_tei("doc1", "Doc 1"),
            "collection2/pdf/doc2.pdf": self.create_test_pdf("doc2"),
            "collection2/tei/doc2.tei.xml": self.create_test_tei("doc2", "Doc 2")
        }
        zip_path = self.create_zip_with_structure("test.zip", structure)

        importer = FileZipImporter(self.db, self.storage, self.repo)
        stats = importer.import_from_zip(
            zip_path,
            recursive_collections=True,
            skip_dirs=['pdf', 'tei']
        )
        importer.cleanup()

        self.assertEqual(stats['files_imported'], 4)

        # Check collection assignments
        doc1_files = self.repo.get_files_by_doc_id("doc1")
        for file in doc1_files:
            self.assertIn("collection1", file.doc_collections)

        doc2_files = self.repo.get_files_by_doc_id("doc2")
        for file in doc2_files:
            self.assertIn("collection2", file.doc_collections)

    def test_import_empty_zip(self):
        """Test importing empty ZIP raises error."""
        zip_path = self.zip_dir / "empty.zip"
        with zipfile.ZipFile(zip_path, 'w'):
            pass  # Create empty zip

        importer = FileZipImporter(self.db, self.storage, self.repo)

        # Suppress expected error log output
        with self.assertLogs('fastapi_app.lib.file_zip_importer', level='ERROR') as log_cm:
            with self.assertRaises(RuntimeError) as ctx:
                importer.import_from_zip(zip_path)

        self.assertIn("empty", str(ctx.exception).lower())
        # Verify error was logged
        self.assertTrue(any('Import from zip failed' in msg for msg in log_cm.output))
        importer.cleanup()

    def test_import_invalid_zip(self):
        """Test importing invalid ZIP raises error."""
        # Create a text file, not a zip
        invalid_zip = self.zip_dir / "invalid.zip"
        invalid_zip.write_text("not a zip file")

        importer = FileZipImporter(self.db, self.storage, self.repo)

        with self.assertRaises(ValueError) as ctx:
            importer.import_from_zip(invalid_zip)

        self.assertIn("valid zip", str(ctx.exception).lower())
        importer.cleanup()

    def test_import_nonexistent_file(self):
        """Test importing nonexistent file raises error."""
        importer = FileZipImporter(self.db, self.storage, self.repo)

        with self.assertRaises(ValueError) as ctx:
            importer.import_from_zip(Path("/nonexistent/file.zip"))

        self.assertIn("does not exist", str(ctx.exception).lower())
        importer.cleanup()

    def test_cleanup_removes_temp_directory(self):
        """Test cleanup removes temporary extraction directory."""
        structure = {
            "pdf/test.pdf": self.create_test_pdf()
        }
        zip_path = self.create_zip_with_structure("test.zip", structure)

        importer = FileZipImporter(self.db, self.storage, self.repo)
        importer.import_from_zip(zip_path)

        # Check temp directory exists
        self.assertIsNotNone(importer.temp_dir)
        temp_dir = importer.temp_dir
        self.assertTrue(temp_dir.exists())

        # Cleanup
        importer.cleanup()

        # Verify temp directory is removed
        self.assertFalse(temp_dir.exists())

    def test_dry_run_mode(self):
        """Test dry run mode doesn't import files."""
        structure = {
            "pdf/test.pdf": self.create_test_pdf(),
            "tei/test.tei.xml": self.create_test_tei()
        }
        zip_path = self.create_zip_with_structure("test.zip", structure)

        importer = FileZipImporter(self.db, self.storage, self.repo, dry_run=True)
        stats = importer.import_from_zip(zip_path)
        importer.cleanup()

        # Files should be scanned but not imported
        self.assertEqual(stats['files_scanned'], 2)
        self.assertEqual(stats['files_imported'], 0)

        # Check database is empty
        files = self.repo.get_all_files()
        self.assertEqual(len(files), 0)

    def test_auto_create_collections(self):
        """Test that collections are auto-created during recursive import."""
        structure = {
            "new_collection/pdf/doc1.pdf": self.create_test_pdf("doc1"),
            "new_collection/tei/doc1.tei.xml": self.create_test_tei("doc1", "Doc 1")
        }
        zip_path = self.create_zip_with_structure("test.zip", structure)

        # Verify collection doesn't exist yet
        collections = get_available_collections(self.db_dir)
        self.assertNotIn("new_collection", collections)

        # Set DATA_ROOT environment variable to use test directory
        # db_dir is derived from data_root/db
        # Clear settings cache to pick up new environment variable
        with patch.dict(os.environ, {"DATA_ROOT": str(self.test_dir)}):
            get_settings.cache_clear()  # Clear LRU cache
            importer = FileZipImporter(self.db, self.storage, self.repo)
            stats = importer.import_from_zip(
                zip_path,
                recursive_collections=True,
                skip_dirs=['pdf', 'tei']
            )
            importer.cleanup()
            get_settings.cache_clear()  # Clear cache again after test

        # Verify files were imported
        self.assertEqual(stats['files_imported'], 2)

        # Verify collection was auto-created
        collections = get_available_collections(self.db_dir)
        self.assertIn("new_collection", collections)

        # Verify files have the correct collection assigned
        doc1_files = self.repo.get_files_by_doc_id("doc1")
        for file in doc1_files:
            self.assertIn("new_collection", file.doc_collections)


if __name__ == '__main__':
    unittest.main()

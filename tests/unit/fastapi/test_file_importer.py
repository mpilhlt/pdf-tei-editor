"""
Unit tests for FileImporter.

Tests:
- Basic file import (PDF and TEI)
- Collection assignment
- Recursive directory scanning
- Recursive collections (subdirectory names as collections)
- Skip directories configuration
- File grouping by document ID
- Metadata extraction and inheritance
- Gold standard detection using patterns (filename and directory)

@testCovers fastapi_app/lib/file_importer.py
"""

import unittest
import tempfile
import shutil
import json
import logging
from pathlib import Path
from datetime import datetime

from fastapi_app.lib.file_importer import FileImporter
from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage


class TestFileImporter(unittest.TestCase):
    """Test file importer functionality."""

    def setUp(self):
        """Create temporary directories and initialize components."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "test.db"
        self.storage_root = self.test_dir / "storage"
        self.import_dir = self.test_dir / "import"

        self.storage_root.mkdir()
        self.import_dir.mkdir()

        # Initialize database and components
        self.db = DatabaseManager(self.db_path)
        self.storage = FileStorage(self.storage_root, self.db_path)
        self.repo = FileRepository(self.db)

    def tearDown(self):
        """Clean up temporary directories."""
        import gc
        gc.collect()
        shutil.rmtree(self.test_dir)

    def create_test_pdf(self, path: Path, unique_content: str = None) -> None:
        """Create a minimal valid PDF file stub with unique content."""
        # Use filename or provided content to make each PDF unique
        if unique_content is None:
            unique_content = path.stem

        # Minimal PDF header and structure with unique content
        pdf_content = f"""%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources 4 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>
endobj
4 0 obj
<< >>
endobj
5 0 obj
<< /Length {len(unique_content) + 20} >>
stream
BT
/F1 12 Tf
({unique_content})
ET
endstream
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000230 00000 n
0000000249 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
{300 + len(unique_content)}
%%EOF
""".encode('utf-8')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pdf_content)

    def create_test_tei(self, path: Path, doc_id: str = None, title: str = "Test Document") -> None:
        """Create a minimal valid TEI XML file."""
        tei_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title>{title}</title>
            </titleStmt>
            <publicationStmt>
                <publisher>Test Publisher</publisher>
                <date>2024</date>
            </publicationStmt>
            <sourceDesc>
                <biblStruct>
                    <analytic>
                        <title>{title}</title>
                    </analytic>
                    <monogr>
                        <imprint>
                            <date>2024</date>
                        </imprint>
                    </monogr>
                    {f'<idno type="DOI">{doc_id}</idno>' if doc_id else ''}
                </biblStruct>
            </sourceDesc>
        </fileDesc>
    </teiHeader>
    <text>
        <body>
            <p>Test content</p>
        </body>
    </text>
</TEI>
"""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(tei_content, encoding='utf-8')

    def test_import_single_pdf(self):
        """Test importing a single PDF file."""
        # Create test file
        pdf_path = self.import_dir / "test_doc.pdf"
        self.create_test_pdf(pdf_path)

        # Import
        importer = FileImporter(self.db, self.storage, self.repo)
        stats = importer.import_directory(self.import_dir, collection="test_collection")

        # Verify stats
        self.assertEqual(stats['files_scanned'], 1)
        self.assertEqual(stats['files_imported'], 1)
        self.assertEqual(stats['files_skipped'], 0)
        self.assertEqual(len(stats['errors']), 0)

        # Verify database
        files = self.repo.list_files()
        self.assertEqual(len(files), 1)
        # Check filename is preserved
        self.assertEqual(files[0].filename, "test_doc.pdf")
        self.assertEqual(files[0].file_type, "pdf")
        self.assertEqual(files[0].doc_collections, ["test_collection"])
        # Original path stored in metadata
        self.assertEqual(files[0].file_metadata.get('original_path'), str(pdf_path))

    def test_import_pdf_with_tei(self):
        """Test importing PDF with matching TEI file."""
        # Create test files with matching names
        pdf_path = self.import_dir / "10.1234_test.pdf"
        tei_path = self.import_dir / "10.1234_test.tei.xml"

        self.create_test_pdf(pdf_path)
        self.create_test_tei(tei_path, doc_id="10.1234/test", title="Test Article")

        # Import
        importer = FileImporter(self.db, self.storage, self.repo)
        stats = importer.import_directory(self.import_dir, collection="corpus1")

        # Verify stats
        self.assertEqual(stats['files_scanned'], 2)
        self.assertEqual(stats['files_imported'], 2)

        # Verify database
        files = self.repo.list_files()
        self.assertEqual(len(files), 2)

        # Find PDF and TEI
        pdf_file = next((f for f in files if f.file_type == "pdf"), None)
        tei_file = next((f for f in files if f.file_type == "tei"), None)

        self.assertIsNotNone(pdf_file)
        self.assertIsNotNone(tei_file)

        # Verify they share the same doc_id (DOI is encoded for filesystem safety)
        self.assertEqual(pdf_file.doc_id, tei_file.doc_id)
        self.assertEqual(pdf_file.doc_id, "10.1234__test")

        # Verify collection assignment
        self.assertEqual(pdf_file.doc_collections, ["corpus1"])
        self.assertEqual(tei_file.doc_collections, ["corpus1"])

    def test_import_without_collection(self):
        """Test importing files without specifying a collection."""
        pdf_path = self.import_dir / "no_collection.pdf"
        self.create_test_pdf(pdf_path)

        # Import without collection
        importer = FileImporter(self.db, self.storage, self.repo)
        stats = importer.import_directory(self.import_dir)

        # Verify file has empty collections
        files = self.repo.list_files()
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].doc_collections, [])

    def test_recursive_scanning(self):
        """Test recursive directory scanning."""
        # Create files in subdirectories
        (self.import_dir / "subdir1").mkdir()
        (self.import_dir / "subdir2").mkdir()

        self.create_test_pdf(self.import_dir / "root.pdf")
        self.create_test_pdf(self.import_dir / "subdir1" / "file1.pdf")
        self.create_test_pdf(self.import_dir / "subdir2" / "file2.pdf")

        # Import recursively
        importer = FileImporter(self.db, self.storage, self.repo)
        stats = importer.import_directory(self.import_dir, recursive=True)

        # Should find all 3 files
        self.assertEqual(stats['files_scanned'], 3)
        self.assertEqual(stats['files_imported'], 3)

    def test_non_recursive_scanning(self):
        """Test non-recursive directory scanning."""
        # Create files in subdirectories
        (self.import_dir / "subdir1").mkdir()

        self.create_test_pdf(self.import_dir / "root.pdf")
        self.create_test_pdf(self.import_dir / "subdir1" / "file1.pdf")

        # Import non-recursively
        importer = FileImporter(self.db, self.storage, self.repo)
        stats = importer.import_directory(self.import_dir, recursive=False)

        # Should find only root file
        self.assertEqual(stats['files_scanned'], 1)
        self.assertEqual(stats['files_imported'], 1)

    def test_recursive_collections_basic(self):
        """Test automatic collection naming from subdirectories."""
        # Create directory structure:
        # import/
        #   corpus1/
        #     doc1.pdf
        #   corpus2/
        #     doc2.pdf
        #   root.pdf

        (self.import_dir / "corpus1").mkdir()
        (self.import_dir / "corpus2").mkdir()

        self.create_test_pdf(self.import_dir / "corpus1" / "doc1.pdf")
        self.create_test_pdf(self.import_dir / "corpus2" / "doc2.pdf")
        self.create_test_pdf(self.import_dir / "root.pdf")

        # Import with recursive collections
        importer = FileImporter(
            self.db, self.storage, self.repo,
            skip_collection_dirs=['pdf', 'tei', 'versions']
        )
        stats = importer.import_directory(
            self.import_dir,
            recursive=True,
            recursive_collections=True
        )

        # Verify all files imported
        self.assertEqual(stats['files_scanned'], 3)
        self.assertEqual(stats['files_imported'], 3)

        # Verify collections
        files = self.repo.list_files()
        self.assertEqual(len(files), 3)

        # Find each file by filename
        doc1 = next((f for f in files if f.filename == "doc1.pdf"), None)
        doc2 = next((f for f in files if f.filename == "doc2.pdf"), None)
        root = next((f for f in files if f.filename == "root.pdf"), None)

        self.assertIsNotNone(doc1, "doc1.pdf not found in imported files")
        self.assertIsNotNone(doc2, "doc2.pdf not found in imported files")
        self.assertIsNotNone(root, "root.pdf not found in imported files")

        self.assertEqual(doc1.doc_collections, ["corpus1"])
        self.assertEqual(doc2.doc_collections, ["corpus2"])
        self.assertEqual(root.doc_collections, [])  # Root has no collection

    def test_recursive_collections_with_skip_dirs(self):
        """Test recursive collections with organizational directories."""
        # Create directory structure:
        # import/
        #   corpus1/
        #     pdf/
        #       doc1.pdf
        #     tei/
        #       doc1.tei.xml
        #   corpus2/
        #     doc2.pdf

        corpus1_pdf = self.import_dir / "corpus1" / "pdf"
        corpus1_tei = self.import_dir / "corpus1" / "tei"
        corpus2 = self.import_dir / "corpus2"

        corpus1_pdf.mkdir(parents=True)
        corpus1_tei.mkdir(parents=True)
        corpus2.mkdir()

        self.create_test_pdf(corpus1_pdf / "doc1.pdf")
        self.create_test_tei(corpus1_tei / "doc1.tei.xml", doc_id="test1")
        self.create_test_pdf(corpus2 / "doc2.pdf")

        # Import with skip directories
        importer = FileImporter(
            self.db, self.storage, self.repo,
            skip_collection_dirs=['pdf', 'tei', 'versions']
        )
        stats = importer.import_directory(
            self.import_dir,
            recursive=True,
            recursive_collections=True
        )

        # Verify import
        self.assertEqual(stats['files_scanned'], 3)
        self.assertEqual(stats['files_imported'], 3)

        # Verify collections - should use "corpus1" and "corpus2", not "pdf" or "tei"
        files = self.repo.list_files()

        pdf_files = [f for f in files if f.file_type == "pdf"]
        self.assertEqual(len(pdf_files), 2)

        doc1_pdf = next((f for f in pdf_files if f.filename == "doc1.pdf"), None)
        doc2_pdf = next((f for f in pdf_files if f.filename == "doc2.pdf"), None)

        self.assertIsNotNone(doc1_pdf)
        self.assertIsNotNone(doc2_pdf)

        # Both should use the meaningful directory name, not "pdf"
        self.assertEqual(doc1_pdf.doc_collections, ["corpus1"])
        self.assertEqual(doc2_pdf.doc_collections, ["corpus2"])

    def test_recursive_collections_overrides_collection_param(self):
        """Test that recursive_collections overrides collection parameter."""
        # Create structure
        (self.import_dir / "corpus1").mkdir()
        self.create_test_pdf(self.import_dir / "corpus1" / "doc1.pdf")

        # Import with both parameters (suppress expected warning)
        importer = FileImporter(
            self.db, self.storage, self.repo,
            skip_collection_dirs=['pdf', 'tei']
        )

        # Suppress the warning for this specific test case
        with self.assertLogs('fastapi_app.lib.file_importer', level='WARNING') as cm:
            stats = importer.import_directory(
                self.import_dir,
                collection="ignored_collection",  # Should be ignored
                recursive=True,
                recursive_collections=True
            )

        # Verify the expected warning was logged
        self.assertTrue(any('Both --collection and --recursive-collections' in msg for msg in cm.output))

        # Verify collection is from directory, not parameter
        files = self.repo.list_files()
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].doc_collections, ["corpus1"])  # Not "ignored_collection"

    def test_custom_skip_dirs(self):
        """Test custom skip directories configuration."""
        # Create structure with custom organizational dir
        (self.import_dir / "corpus1" / "sources").mkdir(parents=True)
        self.create_test_pdf(self.import_dir / "corpus1" / "sources" / "doc1.pdf")

        # Import with custom skip dirs including "sources"
        importer = FileImporter(
            self.db, self.storage, self.repo,
            skip_collection_dirs=['pdf', 'tei', 'sources']
        )
        stats = importer.import_directory(
            self.import_dir,
            recursive=True,
            recursive_collections=True
        )

        # Verify collection skips "sources" and uses "corpus1"
        files = self.repo.list_files()
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].doc_collections, ["corpus1"])

    def test_dry_run_mode(self):
        """Test that dry run doesn't import files."""
        pdf_path = self.import_dir / "test.pdf"
        self.create_test_pdf(pdf_path)

        # Import in dry run mode
        importer = FileImporter(self.db, self.storage, self.repo, dry_run=True)
        stats = importer.import_directory(self.import_dir)

        # Stats should show scan but no import
        self.assertEqual(stats['files_scanned'], 1)

        # Database should be empty
        files = self.repo.list_files()
        self.assertEqual(len(files), 0)

    def test_multiple_tei_versions(self):
        """Test importing PDF with multiple TEI versions."""
        # Create files
        pdf_path = self.import_dir / "doc.pdf"
        tei_gold = self.import_dir / "doc.tei.xml"
        tei_v1 = self.import_dir / "doc.v1.tei.xml"
        tei_v2 = self.import_dir / "doc.v2.tei.xml"

        self.create_test_pdf(pdf_path)
        self.create_test_tei(tei_gold, doc_id="10.1234/doc", title="Gold Standard")
        self.create_test_tei(tei_v1, doc_id="10.1234/doc", title="Version 1")
        self.create_test_tei(tei_v2, doc_id="10.1234/doc", title="Version 2")

        # Import
        importer = FileImporter(self.db, self.storage, self.repo)
        stats = importer.import_directory(self.import_dir)

        # Verify all files imported
        self.assertEqual(stats['files_scanned'], 4)
        self.assertEqual(stats['files_imported'], 4)

        # Verify database has all files
        files = self.repo.list_files()
        self.assertEqual(len(files), 4)

        # All should have same doc_id (DOI is encoded for filesystem safety)
        doc_ids = set(f.doc_id for f in files)
        self.assertEqual(len(doc_ids), 1)
        self.assertIn("10.1234__doc", doc_ids)

    def test_skip_marker_files(self):
        """Test that marker files are skipped."""
        # Create regular file and marker files
        self.create_test_pdf(self.import_dir / "doc.pdf")

        # Create marker files (should be skipped)
        (self.import_dir / ".git").mkdir()
        (self.import_dir / ".git" / "config").write_text("git config")
        (self.import_dir / ".DS_Store").write_text("macos metadata")

        # Import
        importer = FileImporter(self.db, self.storage, self.repo)
        stats = importer.import_directory(self.import_dir)

        # Should only import the PDF, not marker files
        self.assertEqual(stats['files_scanned'], 1)
        self.assertEqual(stats['files_imported'], 1)

        files = self.repo.list_files()
        self.assertEqual(len(files), 1)
        # Check it's the correct PDF file
        self.assertEqual(files[0].filename, "doc.pdf")
        self.assertEqual(files[0].file_type, "pdf")

    def test_gold_by_version_marker_default(self):
        """Test gold detection using version marker (default behavior)."""
        # Create TEI files - ones without .vN. are gold
        # Use different titles to ensure different content/hashes
        self.create_test_tei(self.import_dir / "doc1.tei.xml", doc_id="10.1234/doc1", title="Gold Standard")
        self.create_test_tei(self.import_dir / "doc1.v1.tei.xml", doc_id="10.1234/doc1", title="Version 1")
        self.create_test_tei(self.import_dir / "doc2.tei.xml", doc_id="10.1234/doc2", title="Document 2 Gold")
        self.create_test_tei(self.import_dir / "doc2.v2.tei.xml", doc_id="10.1234/doc2", title="Document 2 Version 2")

        # Import with default settings (no gold_pattern - uses version marker logic)
        importer = FileImporter(self.db, self.storage, self.repo)
        with self.assertLogs('fastapi_app.lib.file_importer', level='WARNING') as cm:
            stats = importer.import_directory(self.import_dir)

        # Verify expected warnings about missing PDFs
        self.assertTrue(any('No PDF found for document' in msg for msg in cm.output))

        # Verify all files imported
        self.assertEqual(stats['files_scanned'], 4)
        self.assertEqual(stats['files_imported'], 4)

        # Verify gold status
        files = self.repo.list_files()
        self.assertEqual(len(files), 4)

        # Files without .vN. should be gold
        doc1_gold = next((f for f in files if f.filename == "doc1.tei.xml"), None)
        doc1_v1 = next((f for f in files if f.filename == "doc1.v1.tei.xml"), None)
        doc2_gold = next((f for f in files if f.filename == "doc2.tei.xml"), None)
        doc2_v2 = next((f for f in files if f.filename == "doc2.v2.tei.xml"), None)

        self.assertIsNotNone(doc1_gold)
        self.assertIsNotNone(doc1_v1)
        self.assertIsNotNone(doc2_gold)
        self.assertIsNotNone(doc2_v2)

        # Verify gold status
        self.assertTrue(doc1_gold.is_gold_standard)
        self.assertFalse(doc1_v1.is_gold_standard)
        self.assertTrue(doc2_gold.is_gold_standard)
        self.assertFalse(doc2_v2.is_gold_standard)

    def test_gold_pattern_in_filename(self):
        """Test gold detection using filename pattern (legacy mode)."""
        # Create TEI files with .gold. pattern in filename
        # Use different titles to ensure different content/hashes
        self.create_test_tei(self.import_dir / "doc1.gold.tei.xml", doc_id="10.1234/doc1", title="Gold Standard")
        self.create_test_tei(self.import_dir / "doc1.tei.xml", doc_id="10.1234/doc1", title="Working Version")
        self.create_test_tei(self.import_dir / "doc2.tei.xml", doc_id="10.1234/doc2", title="Document 2")

        # Import with gold pattern matching '.gold.' (suppress expected warnings)
        importer = FileImporter(
            self.db, self.storage, self.repo,
            gold_pattern=r'\.gold\.'
        )
        with self.assertLogs('fastapi_app.lib.file_importer', level='WARNING') as cm:
            stats = importer.import_directory(self.import_dir)

        # Verify expected warnings about missing PDFs
        self.assertTrue(any('No PDF found for document' in msg for msg in cm.output))

        # Verify all files imported
        self.assertEqual(stats['files_scanned'], 3)
        self.assertEqual(stats['files_imported'], 3)

        # Verify gold status
        files = self.repo.list_files()
        self.assertEqual(len(files), 3)

        # Find files by filename
        gold_file = next((f for f in files if 'gold' in f.filename), None)
        non_gold_files = [f for f in files if 'gold' not in f.filename]

        self.assertIsNotNone(gold_file)
        self.assertEqual(len(non_gold_files), 2)

        # Verify gold status
        self.assertTrue(gold_file.is_gold_standard)
        for f in non_gold_files:
            self.assertFalse(f.is_gold_standard)

    def test_gold_pattern_in_directory(self):
        """Test gold detection using directory pattern (legacy mode)."""
        # Create directory structure with tei/ subdirectory
        tei_dir = self.import_dir / "tei"
        tei_dir.mkdir()

        self.create_test_tei(tei_dir / "doc1.tei.xml", doc_id="10.1234/doc1")
        self.create_test_tei(self.import_dir / "doc2.tei.xml", doc_id="10.1234/doc2")

        # Import with gold directory pattern (suppress expected warnings)
        importer = FileImporter(self.db, self.storage, self.repo, gold_dir_name='tei')
        with self.assertLogs('fastapi_app.lib.file_importer', level='WARNING') as cm:
            stats = importer.import_directory(self.import_dir)

        # Verify expected warnings about missing PDFs
        self.assertTrue(any('No PDF found for document' in msg for msg in cm.output))

        # Verify all files imported
        self.assertEqual(stats['files_scanned'], 2)
        self.assertEqual(stats['files_imported'], 2)

        # Verify gold status
        files = self.repo.list_files()
        self.assertEqual(len(files), 2)

        # File in tei/ dir should be gold
        gold_file = next((f for f in files if f.filename == "doc1.tei.xml"), None)
        non_gold_file = next((f for f in files if f.filename == "doc2.tei.xml"), None)

        self.assertIsNotNone(gold_file)
        self.assertIsNotNone(non_gold_file)

        self.assertTrue(gold_file.is_gold_standard)
        self.assertFalse(non_gold_file.is_gold_standard)

    def test_gold_pattern_custom_directory(self):
        """Test gold detection with custom directory name."""
        # Create directory structure with custom gold directory
        gold_dir = self.import_dir / "gold_standard"
        gold_dir.mkdir()

        self.create_test_tei(gold_dir / "doc1.tei.xml", doc_id="10.1234/doc1")
        self.create_test_tei(self.import_dir / "doc2.tei.xml", doc_id="10.1234/doc2")

        # Import with custom gold directory name (suppress expected warnings)
        importer = FileImporter(
            self.db, self.storage, self.repo,
            gold_dir_name="gold_standard"
        )
        with self.assertLogs('fastapi_app.lib.file_importer', level='WARNING') as cm:
            stats = importer.import_directory(self.import_dir)

        # Verify expected warnings about missing PDFs
        self.assertTrue(any('No PDF found for document' in msg for msg in cm.output))

        # Verify gold status
        files = self.repo.list_files()
        self.assertEqual(len(files), 2)

        gold_file = next((f for f in files if f.filename == "doc1.tei.xml"), None)
        non_gold_file = next((f for f in files if f.filename == "doc2.tei.xml"), None)

        self.assertTrue(gold_file.is_gold_standard)
        self.assertFalse(non_gold_file.is_gold_standard)


if __name__ == '__main__':
    unittest.main()

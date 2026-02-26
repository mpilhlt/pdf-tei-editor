"""
Unit tests for FileExporter.

Tests:
- Basic file export (PDF and TEI)
- Filename construction (with/without variants, versioned files)
- Collection filtering
- Variant filtering with glob patterns
- Regex filename filtering
- Grouping strategies (type, collection, variant)
- Multi-collection duplication
- Filename transformations
- Dry run mode

@testCovers fastapi_app/lib/storage/file_exporter.py
"""

import unittest
import tempfile
import shutil
from pathlib import Path

from fastapi_app.lib.storage.file_exporter import FileExporter
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.models.models import FileCreate


class TestFileExporter(unittest.TestCase):
    """Test file exporter functionality."""

    def setUp(self):
        """Create temporary directories and initialize components."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "test.db"
        self.storage_root = self.test_dir / "storage"
        self.export_dir = self.test_dir / "export"

        self.storage_root.mkdir()
        self.export_dir.mkdir()

        # Initialize database and components
        self.db = DatabaseManager(self.db_path)
        self.storage = FileStorage(self.storage_root, self.db)
        self.repo = FileRepository(self.db)

    def tearDown(self):
        """Clean up temporary directories."""
        import gc
        gc.collect()
        shutil.rmtree(self.test_dir)

    def create_test_pdf(self, content: str = None) -> bytes:
        """Create minimal PDF content with unique hash."""
        import time
        if content is None:
            # Use timestamp to ensure unique content
            content = f"test pdf {time.time()}"
        return f"%PDF-1.4\n{content}\n%%EOF".encode('utf-8')

    def create_test_tei(self, doc_id: str = "10.1234/test", title: str = None) -> bytes:
        """Create minimal TEI XML content with unique hash."""
        import time
        if title is None:
            # Use timestamp to ensure unique content
            title = f"Test {time.time()}"

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

    def add_file(
        self,
        doc_id: str,
        file_type: str,
        content: bytes,
        collections: list = None,
        variant: str = None,
        version: int = None,
        is_gold: bool = False
    ) -> str:
        """
        Add a file to storage and database.

        Note: Collections should only be set for PDF files.
        TEI files inherit collections from their associated PDF.
        """
        # Save to storage
        file_hash, _ = self.storage.save_file(content, file_type)

        # Only PDFs store collections - TEI files inherit from PDF
        file_collections = collections if file_type == 'pdf' and collections else []

        # Create metadata
        file_create = FileCreate(
            id=file_hash,
            filename=f"{doc_id}.{file_type}",
            doc_id=doc_id,
            file_type=file_type,
            file_size=len(content),
            variant=variant,
            version=version,
            is_gold_standard=is_gold,
            doc_collections=file_collections
        )

        # Insert into database
        self.repo.insert_file(file_create)
        return file_hash

    def test_export_single_pdf(self):
        """Test exporting a single PDF file with matching TEI."""
        # Add PDF
        pdf_content = self.create_test_pdf("unique pdf 1")
        self.add_file(
            doc_id="10.1111/test",
            file_type="pdf",
            content=pdf_content,
            collections=["corpus1"]
        )

        # Add matching gold TEI (required for PDF to be exported)
        tei_content = self.create_test_tei("10.1111/test")
        self.add_file(
            doc_id="10.1111/test",
            file_type="tei",
            content=tei_content,
            variant="grobid",
            is_gold=True
        )

        # Export
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir)

        # Verify stats (1 PDF + 1 TEI = 2 files)
        self.assertEqual(stats['files_scanned'], 2)
        self.assertEqual(stats['files_exported'], 2)
        self.assertEqual(stats['files_skipped'], 0)
        self.assertEqual(len(stats['errors']), 0)

        # Verify PDF file exists
        exported_file = self.export_dir / "pdf" / "10.1111__test.pdf"
        self.assertTrue(exported_file.exists())
        self.assertEqual(exported_file.read_bytes(), pdf_content)

        # Verify TEI file exists
        tei_file = self.export_dir / "tei" / "10.1111__test.grobid.tei.xml"
        self.assertTrue(tei_file.exists())

    def test_export_tei_with_variant(self):
        """Test exporting TEI file with variant in filename."""
        # Add TEI with variant
        tei_content = self.create_test_tei("10.1111/test")
        self.add_file(
            doc_id="10.1111/test",
            file_type="tei",
            content=tei_content,
            collections=["corpus1"],
            variant="grobid-0.8.1",
            is_gold=True
        )

        # Export
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir)

        # Verify file exists with variant in name
        exported_file = self.export_dir / "tei" / "10.1111__test.grobid-0.8.1.tei.xml"
        self.assertTrue(exported_file.exists())
        self.assertEqual(exported_file.read_bytes(), tei_content)

    def test_export_tei_without_variant(self):
        """Test exporting TEI file without variant (omit from filename)."""
        # Add TEI without variant
        tei_content = self.create_test_tei("10.1111/test")
        self.add_file(
            doc_id="10.1111/test",
            file_type="tei",
            content=tei_content,
            collections=["corpus1"],
            variant=None,
            is_gold=True
        )

        # Export
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir)

        # Verify file exists without variant in name
        exported_file = self.export_dir / "tei" / "10.1111__test.tei.xml"
        self.assertTrue(exported_file.exists())
        self.assertEqual(exported_file.read_bytes(), tei_content)

    def test_export_with_versions(self):
        """Test exporting versioned TEI files."""
        # Add gold file (version=0, is_gold=True)
        gold_content = self.create_test_tei("10.1111/test", title="Gold")
        self.add_file(
            doc_id="10.1111/test",
            file_type="tei",
            content=gold_content,
            collections=["corpus1"],
            variant="grobid-0.8.1",
            version=0,
            is_gold=True
        )

        # Add version 1 (non-gold version, is_gold=False)
        v1_content = self.create_test_tei("10.1111/test", title="Version 1")
        self.add_file(
            doc_id="10.1111/test",
            file_type="tei",
            content=v1_content,
            collections=["corpus1"],
            variant="grobid-0.8.1",
            version=1,
            is_gold=False
        )

        # Add version 2 (non-gold version, is_gold=False)
        v2_content = self.create_test_tei("10.1111/test", title="Version 2")
        self.add_file(
            doc_id="10.1111/test",
            file_type="tei",
            content=v2_content,
            collections=["corpus1"],
            variant="grobid-0.8.1",
            version=2,
            is_gold=False
        )

        # Export without versions
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, include_versions=False)

        # Should only export gold file (is_gold_standard=True)
        self.assertEqual(stats['files_exported'], 1)
        gold_file = self.export_dir / "tei" / "10.1111__test.grobid-0.8.1.tei.xml"
        self.assertTrue(gold_file.exists())

        # Versions should not exist when include_versions=False
        v1_file = self.export_dir / "versions" / "10.1111__test.grobid-0.8.1.v1.tei.xml"
        v2_file = self.export_dir / "versions" / "10.1111__test.grobid-0.8.1.v2.tei.xml"
        self.assertFalse(v1_file.exists())
        self.assertFalse(v2_file.exists())

        # Export with versions
        export_dir2 = self.test_dir / "export2"
        stats2 = exporter.export_files(export_dir2, include_versions=True)

        # Should export all files (1 gold + 2 non-gold versions)
        self.assertEqual(stats2['files_exported'], 3)
        gold_file2 = export_dir2 / "tei" / "10.1111__test.grobid-0.8.1.tei.xml"
        v1_file2 = export_dir2 / "versions" / "10.1111__test.grobid-0.8.1.v1.tei.xml"
        v2_file2 = export_dir2 / "versions" / "10.1111__test.grobid-0.8.1.v2.tei.xml"
        self.assertTrue(gold_file2.exists())
        self.assertTrue(v1_file2.exists())
        self.assertTrue(v2_file2.exists())

    def test_filter_by_collection(self):
        """Test filtering by collection."""
        # Add files to different collections with matching TEI files
        self.add_file("10.1111/test1", "pdf", self.create_test_pdf("pdf1"), ["corpus1"])
        self.add_file("10.1111/test1", "tei", self.create_test_tei("10.1111/test1"), variant="grobid", is_gold=True)

        self.add_file("10.1111/test2", "pdf", self.create_test_pdf("pdf2"), ["corpus2"])
        self.add_file("10.1111/test2", "tei", self.create_test_tei("10.1111/test2"), variant="grobid", is_gold=True)

        self.add_file("10.1111/test3", "pdf", self.create_test_pdf("pdf3"), ["corpus1", "corpus2"])
        self.add_file("10.1111/test3", "tei", self.create_test_tei("10.1111/test3"), variant="grobid", is_gold=True)

        # Export only corpus1
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, collections=["corpus1"])

        # Should export test1 and test3 (both in corpus1): 2 PDFs + 2 TEIs = 4 files
        self.assertEqual(stats['files_exported'], 4)
        self.assertTrue((self.export_dir / "pdf" / "10.1111__test1.pdf").exists())
        self.assertTrue((self.export_dir / "pdf" / "10.1111__test3.pdf").exists())

    def test_filter_by_variants_glob(self):
        """Test filtering variants with glob patterns."""
        # Add files with different variants
        self.add_file("10.1111/test", "tei", self.create_test_tei(), variant="grobid-0.7.0", is_gold=True)
        self.add_file("10.1111/test", "tei", self.create_test_tei(), variant="grobid-0.8.1", is_gold=True)
        self.add_file("10.1111/test", "tei", self.create_test_tei(), variant="metatei-1.0", is_gold=True)

        # Export only grobid variants
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, variants=["grobid*"])

        # Should export 2 grobid files
        self.assertEqual(stats['files_exported'], 2)
        self.assertTrue((self.export_dir / "tei" / "10.1111__test.grobid-0.7.0.tei.xml").exists())
        self.assertTrue((self.export_dir / "tei" / "10.1111__test.grobid-0.8.1.tei.xml").exists())
        self.assertFalse((self.export_dir / "tei" / "10.1111__test.metatei-1.0.tei.xml").exists())

    def test_filter_by_regex(self):
        """Test filtering filenames by regex."""
        # Add files with matching TEI files
        self.add_file("10.1111/test1", "pdf", self.create_test_pdf())
        self.add_file("10.1111/test1", "tei", self.create_test_tei("10.1111/test1"), variant="grobid", is_gold=True)

        self.add_file("10.1111/test2", "pdf", self.create_test_pdf())
        self.add_file("10.1111/test2", "tei", self.create_test_tei("10.1111/test2"), variant="grobid", is_gold=True)

        self.add_file("10.5771/other", "pdf", self.create_test_pdf())
        self.add_file("10.5771/other", "tei", self.create_test_tei("10.5771/other"), variant="grobid", is_gold=True)

        # Export only files matching "test"
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, regex=r"test")

        # Should export only test1 and test2: 2 PDFs + 2 TEIs = 4 files
        self.assertEqual(stats['files_exported'], 4)
        self.assertTrue((self.export_dir / "pdf" / "10.1111__test1.pdf").exists())
        self.assertTrue((self.export_dir / "pdf" / "10.1111__test2.pdf").exists())
        self.assertFalse((self.export_dir / "pdf" / "10.5771__other.pdf").exists())

    def test_group_by_type(self):
        """Test grouping by type (default)."""
        # Add files
        pdf_content = self.create_test_pdf()
        tei_content = self.create_test_tei()
        self.add_file("10.1111/test", "pdf", pdf_content)
        self.add_file("10.1111/test", "tei", tei_content, variant="grobid", is_gold=True)

        # Export with group_by=type
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, group_by="type")

        # Verify structure
        self.assertTrue((self.export_dir / "pdf" / "10.1111__test.pdf").exists())
        self.assertTrue((self.export_dir / "tei" / "10.1111__test.grobid.tei.xml").exists())

    def test_group_by_collection(self):
        """Test grouping by collection."""
        # Add files
        pdf_content = self.create_test_pdf()
        tei_content = self.create_test_tei()
        self.add_file("10.1111/test", "pdf", pdf_content, collections=["corpus1"])
        self.add_file("10.1111/test", "tei", tei_content, collections=["corpus1"], variant="grobid", is_gold=True)

        # Export with group_by=collection
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, group_by="collection")

        # Verify structure
        self.assertTrue((self.export_dir / "corpus1" / "pdf" / "10.1111__test.pdf").exists())
        self.assertTrue((self.export_dir / "corpus1" / "tei" / "10.1111__test.grobid.tei.xml").exists())

    def test_group_by_variant(self):
        """Test grouping by variant."""
        # Add files
        pdf_content = self.create_test_pdf()
        tei1_content = self.create_test_tei(title="Grobid")
        tei2_content = self.create_test_tei(title="MetaTEI")
        self.add_file("10.1111/test", "pdf", pdf_content)
        self.add_file("10.1111/test", "tei", tei1_content, variant="grobid-0.8.1", is_gold=True)
        self.add_file("10.1111/test", "tei", tei2_content, variant="metatei-1.0", is_gold=True)

        # Export with group_by=variant
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, group_by="variant")

        # Verify structure - files still have variant in name for consistency
        self.assertTrue((self.export_dir / "pdf" / "10.1111__test.pdf").exists())
        self.assertTrue((self.export_dir / "grobid-0.8.1" / "10.1111__test.grobid-0.8.1.tei.xml").exists())
        self.assertTrue((self.export_dir / "metatei-1.0" / "10.1111__test.metatei-1.0.tei.xml").exists())

    def test_multi_collection_duplication(self):
        """Test that files in multiple collections are exported to each."""
        # Add file in multiple collections with matching TEI
        pdf_content = self.create_test_pdf()
        self.add_file("10.1111/test", "pdf", pdf_content, collections=["corpus1", "corpus2"])
        self.add_file("10.1111/test", "tei", self.create_test_tei("10.1111/test"), variant="grobid", is_gold=True)

        # Export with group_by=collection
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, group_by="collection")

        # Verify file exists in both collections
        self.assertTrue((self.export_dir / "corpus1" / "pdf" / "10.1111__test.pdf").exists())
        self.assertTrue((self.export_dir / "corpus2" / "pdf" / "10.1111__test.pdf").exists())

        # Should count as 4 exports (PDF + TEI duplicated to both collections)
        self.assertEqual(stats['files_exported'], 4)

    def test_filename_encoding(self):
        """Test DOI encoding in filenames."""
        # Add file with DOI containing special chars with matching TEI
        pdf_content = self.create_test_pdf()
        self.add_file("10.1234/test:file<name>", "pdf", pdf_content)
        self.add_file("10.1234/test:file<name>", "tei", self.create_test_tei("10.1234/test:file<name>"), variant="grobid", is_gold=True)

        # Export
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir)

        # Verify encoded filename
        exported_file = self.export_dir / "pdf" / "10.1234__test$3A$file$3C$name$3E$.pdf"
        self.assertTrue(exported_file.exists())

    def test_filename_transform(self):
        """Test sed-style filename transformation."""
        # Add file with matching TEI
        pdf_content = self.create_test_pdf()
        self.add_file("10.1111/test", "pdf", pdf_content)
        self.add_file("10.1111/test", "tei", self.create_test_tei("10.1111/test"), variant="grobid", is_gold=True)

        # Export with transform to remove DOI prefix
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(
            self.export_dir,
            filename_transforms=["/^10\\.1111__//"]
        )

        # Verify transformed filename
        exported_file = self.export_dir / "pdf" / "test.pdf"
        self.assertTrue(exported_file.exists())

    def test_multiple_filename_transforms(self):
        """Test multiple sequential filename transformations."""
        # Add file with matching TEI
        pdf_content = self.create_test_pdf()
        self.add_file("10.1111/test-file", "pdf", pdf_content)
        self.add_file("10.1111/test-file", "tei", self.create_test_tei("10.1111/test-file"), variant="grobid", is_gold=True)

        # Export with multiple transforms applied sequentially
        # First: remove DOI prefix, Second: replace hyphens with underscores
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(
            self.export_dir,
            filename_transforms=["/^10\\.1111__//", "/-/_/"]
        )

        # Verify filename with both transforms applied
        # Original: 10.1111__test-file.pdf
        # After transform 1: test-file.pdf
        # After transform 2: test_file.pdf
        exported_file = self.export_dir / "pdf" / "test_file.pdf"
        self.assertTrue(exported_file.exists())

    def test_dry_run(self):
        """Test dry run mode."""
        # Add file with matching TEI
        self.add_file("10.1111/test", "pdf", self.create_test_pdf())
        self.add_file("10.1111/test", "tei", self.create_test_tei("10.1111/test"), variant="grobid", is_gold=True)

        # Export in dry run mode
        exporter = FileExporter(self.db, self.storage, self.repo, dry_run=True)
        stats = exporter.export_files(self.export_dir)

        # Stats should show export (1 PDF + 1 TEI = 2 files)
        self.assertEqual(stats['files_exported'], 2)

        # But file should not exist
        exported_file = self.export_dir / "pdf" / "10.1111__test.pdf"
        self.assertFalse(exported_file.exists())

    def test_collection_inheritance(self):
        """Test that TEI files inherit collections from their PDF."""
        # Add PDF with collections
        pdf_content = self.create_test_pdf()
        self.add_file("10.1111/test", "pdf", pdf_content, collections=["corpus1", "corpus2"])

        # Add TEI without collections (they should inherit from PDF)
        tei_content = self.create_test_tei("10.1111/test")
        self.add_file("10.1111/test", "tei", tei_content, variant="grobid", is_gold=True)

        # Export with group_by=collection
        exporter = FileExporter(self.db, self.storage, self.repo)
        stats = exporter.export_files(self.export_dir, group_by="collection")

        # TEI should be exported to both collections (inherited from PDF)
        # 2 PDF copies (one per collection) + 2 TEI copies (one per collection) = 4
        self.assertEqual(stats['files_exported'], 4)

        # Verify files exist in both collections
        self.assertTrue((self.export_dir / "corpus1" / "pdf" / "10.1111__test.pdf").exists())
        self.assertTrue((self.export_dir / "corpus1" / "tei" / "10.1111__test.grobid.tei.xml").exists())
        self.assertTrue((self.export_dir / "corpus2" / "pdf" / "10.1111__test.pdf").exists())
        self.assertTrue((self.export_dir / "corpus2" / "tei" / "10.1111__test.grobid.tei.xml").exists())

    def test_invalid_group_by_raises_error(self):
        """Test that invalid group_by raises ValueError."""
        exporter = FileExporter(self.db, self.storage, self.repo)

        with self.assertRaises(ValueError) as cm:
            exporter.export_files(self.export_dir, group_by="invalid")

        self.assertIn("Invalid group_by", str(cm.exception))

    def test_invalid_transform_raises_error(self):
        """Test that invalid transform pattern raises ValueError."""
        # Add file
        self.add_file("10.1111/test", "pdf", self.create_test_pdf())

        exporter = FileExporter(self.db, self.storage, self.repo)

        # Invalid pattern (no leading /)
        with self.assertRaises(ValueError) as cm:
            exporter.export_files(self.export_dir, filename_transforms=["test/replace/"])
        self.assertIn("must start with", str(cm.exception))

        # Invalid pattern (too few parts)
        with self.assertRaises(ValueError) as cm:
            exporter.export_files(self.export_dir, filename_transforms=["/test"])
        self.assertIn("must be in format", str(cm.exception))


if __name__ == '__main__':
    unittest.main()

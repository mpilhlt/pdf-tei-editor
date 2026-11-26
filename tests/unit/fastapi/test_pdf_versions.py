"""
Unit tests for the PDFs of a document (#944): each TEI file is attached to its own PDF, PDFs never
change (a new text layer is a new PDF), and the canonical PDF of a document is the PDF of its most
recently changed gold version, else its most recent PDF.

@testCovers fastapi_app/lib/repository/file_repository.py::create_pdf_version
@testCovers fastapi_app/lib/repository/file_repository.py::get_pdf_for_document
@testCovers fastapi_app/lib/repository/file_repository.py::get_pdf_for_file
@testCovers fastapi_app/lib/repository/file_repository.py::get_unreferenced_pdfs
@testCovers fastapi_app/lib/storage/file_gc.py::purge_unreferenced_pdfs
"""

import gc
import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.gc_registry import GcContext
from fastapi_app.lib.models.models import FileCreate, FileMetadata, FileUpdate
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_gc import purge_deleted_files, purge_unreferenced_pdfs
from fastapi_app.lib.storage.file_storage import FileStorage


class TestPdfVersions(unittest.TestCase):
    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / "metadata.db")
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.test_dir / "files", self.db)
        # FileRepository creates its own FileStorage under settings.data_root / "files" to delete content
        settings = type("S", (), {"data_root": self.test_dir})()
        self.settings_patch = patch("fastapi_app.config.get_settings", lambda: settings)
        self.settings_patch.start()
        self.old_hash = self.save(b"%PDF original", "pdf")
        self.pdf = self.insert(self.old_hash, "pdf", stable_id="pdf1", doc_collections=["c1"], doc_metadata={"title": "T"})

    def tearDown(self):
        self.settings_patch.stop()
        gc.collect()
        shutil.rmtree(self.test_dir)

    def save(self, content: bytes, file_type: str) -> str:
        file_hash, _ = self.storage.save_file(content, file_type, increment_ref=False)
        return file_hash

    def insert(self, file_hash: str, file_type: str, doc_id: str = "doc1", **kwargs) -> FileMetadata:
        stable_id = kwargs.pop("stable_id", None)
        self.repo.insert_file(FileCreate(
            id=file_hash, stable_id=stable_id, filename=f"{file_hash[:8]}.{file_type}", doc_id=doc_id,
            file_type=file_type, file_size=1, **kwargs,
        ))
        rows = [f for f in self.repo.get_files_by_content_hash(file_hash) if f.doc_id == doc_id]
        file = rows[-1] if stable_id is None else self.repo.get_file_by_stable_id(stable_id)
        assert file is not None
        return file

    def add_version(self, content: bytes, **kwargs) -> FileMetadata:
        return self.insert(self.save(content, "tei"), "tei", **kwargs)

    def ocr(self, source: str = "pdf1", content: bytes = b"%PDF ocr") -> FileMetadata:
        new_hash = self.save(content, "pdf")
        return self.repo.create_pdf_version(source, new_hash, len(content), {"ocr": {"engine": "fake"}})

    def canonical(self) -> str:
        pdf = self.repo.get_pdf_for_document("doc1")
        assert pdf is not None
        return pdf.stable_id

    def gc_context(self, dry_run: bool = False) -> GcContext:
        ctx = GcContext(deleted_before=datetime(2999, 1, 1), file_repo=self.repo, file_storage=self.storage,
                        db_dir=self.test_dir, is_admin=True)
        ctx.dry_run = dry_run
        return ctx

    def test_new_pdf_leaves_the_source_unchanged(self):
        v1 = self.add_version(b"<TEI>1</TEI>")
        self.assertEqual(v1.pdf_stable_id, "pdf1")
        new = self.ocr()
        self.assertNotEqual(new.stable_id, "pdf1")
        self.assertEqual((new.doc_id, new.doc_collections, new.doc_metadata), ("doc1", ["c1"], {"title": "T"}))
        self.assertEqual(new.file_metadata["ocr"]["engine"], "fake")
        source = self.repo.get_file_by_stable_id("pdf1")
        assert source is not None
        self.assertEqual(source.id, self.old_hash)
        self.assertNotIn("ocr", source.file_metadata)
        # the version stays attached to its PDF
        self.assertEqual(self.repo.get_pdf_for_file(v1).stable_id, "pdf1")  # type: ignore[union-attr]

    def test_unchanged_content_is_refused(self):
        with self.assertRaises(ValueError):
            self.repo.create_pdf_version("pdf1", self.old_hash, 1, {})

    def test_new_tei_is_attached_to_the_canonical_pdf_unless_given(self):
        new = self.ocr()
        self.assertEqual(self.add_version(b"<TEI>1</TEI>").pdf_stable_id, new.stable_id)
        self.assertEqual(self.add_version(b"<TEI>2</TEI>", pdf_stable_id="pdf1").pdf_stable_id, "pdf1")

    def test_tei_imported_before_its_pdf(self):
        tei = self.add_version(b"<TEI>x</TEI>", doc_id="doc2")
        self.assertIsNone(tei.pdf_stable_id)
        self.insert(self.save(b"%PDF doc2", "pdf"), "pdf", doc_id="doc2", stable_id="pdf2")
        self.assertEqual(self.repo.get_file_by_stable_id(tei.stable_id).pdf_stable_id, "pdf2")  # type: ignore[union-attr]

    def test_canonical_is_the_most_recent_pdf_without_gold(self):
        self.assertEqual(self.canonical(), "pdf1")
        new = self.ocr()
        self.assertEqual(self.canonical(), new.stable_id)

    def test_canonical_is_the_pdf_of_the_gold_version(self):
        self.add_version(b"<TEI>gold</TEI>", is_gold_standard=True, version=None, variant="a")
        new = self.ocr()
        self.assertEqual(self.canonical(), "pdf1")
        # another lineage gets a gold version that is changed later: its PDF becomes canonical
        self.add_version(b"<TEI>gold b</TEI>", is_gold_standard=True, version=None, variant="b", pdf_stable_id=new.stable_id)
        self.assertEqual(self.canonical(), new.stable_id)
        # the first gold version is changed later (timestamps have a resolution of a second)
        with self.db.transaction() as conn:
            conn.execute("UPDATE files SET updated_at = '2999-01-01 00:00:00' WHERE variant = 'a'")
        self.assertEqual(self.canonical(), "pdf1")
        # without gold versions, the most recent PDF is canonical
        with self.db.transaction() as conn:
            conn.execute("UPDATE files SET is_gold_standard = 0, version = 2 WHERE file_type = 'tei'")
        self.assertEqual(self.canonical(), new.stable_id)

    def test_document_lists_contain_the_canonical_pdf_only(self):
        self.add_version(b"<TEI>1</TEI>")
        new = self.ocr()
        pdf_ids = lambda files: sorted(f.stable_id for f in files if f.file_type == "pdf")
        self.assertEqual(pdf_ids(self.repo.get_files_by_doc_id("doc1")), [new.stable_id])
        self.assertEqual(pdf_ids(self.repo.list_files()), [new.stable_id])
        self.assertEqual(pdf_ids(self.repo.get_files_by_collection("c1")), [new.stable_id])
        self.assertEqual(pdf_ids(self.repo.get_files_by_doc_id("doc1", include_all_pdfs=True)), sorted(["pdf1", new.stable_id]))
        self.assertEqual([p.stable_id for p in self.repo.get_document_pdfs("doc1")], ["pdf1", new.stable_id])

    def test_document_fields_are_shared_by_the_pdfs(self):
        new = self.ocr()
        self.repo.update_file(new.id, FileUpdate(doc_collections=["c2"], doc_metadata={"title": "U"}), stable_id=new.stable_id)
        source = self.repo.get_file_by_stable_id("pdf1")
        assert source is not None
        self.assertEqual((source.doc_collections, source.doc_metadata), (["c2"], {"title": "U"}))

    def test_shared_content_of_another_document_is_not_affected(self):
        other = self.insert(self.old_hash, "pdf", doc_id="doc2", stable_id="pdf2")
        self.ocr()
        self.assertEqual(self.repo.get_file_by_stable_id(other.stable_id).id, self.old_hash)  # type: ignore[union-attr]

    def test_gc_keeps_referenced_canonical_and_latest_pdfs(self):
        v1 = self.add_version(b"<TEI>1</TEI>")
        first = self.ocr(content=b"%PDF ocr 1")
        # pdf1 is referenced, `first` is the most recent and canonical
        self.assertEqual(purge_unreferenced_pdfs(self.gc_context()).items_deleted, 0)
        second = self.ocr(source=first.stable_id, content=b"%PDF ocr 2")
        # `first` is neither referenced nor the most recent nor canonical
        self.assertEqual(purge_unreferenced_pdfs(self.gc_context(dry_run=True)).items_deleted, 1)
        self.assertEqual(purge_unreferenced_pdfs(self.gc_context()).items_deleted, 1)
        self.assertIsNone(self.repo.get_file_by_stable_id(first.stable_id, include_deleted=True))
        self.assertIsNotNone(self.repo.get_file_by_stable_id(second.stable_id))

        # a soft-deleted version still keeps its PDF (it can be restored)
        self.repo.delete_file(v1.id, stable_id=v1.stable_id)
        self.assertEqual(purge_unreferenced_pdfs(self.gc_context()).items_deleted, 0)
        # once the version is purged, its PDF goes as well
        purge_deleted_files(self.gc_context())
        self.assertEqual(purge_unreferenced_pdfs(self.gc_context()).items_deleted, 1)
        self.assertIsNone(self.storage.get_file_path(self.old_hash, "pdf"))
        self.assertIsNotNone(self.storage.get_file_path(second.id, "pdf"))


if __name__ == "__main__":
    unittest.main()

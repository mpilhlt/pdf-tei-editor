"""
Unit tests for archived PDFs: the original PDF of a document is kept after text recognition
replaced it, for the versions made from it (#924).

@testCovers fastapi_app/lib/repository/file_repository.py::replace_pdf_content
@testCovers fastapi_app/lib/repository/file_repository.py::get_pdf_for_file
@testCovers fastapi_app/lib/repository/file_repository.py::get_unreferenced_archived_pdfs
@testCovers fastapi_app/lib/storage/file_gc.py::delete_unreferenced_archived_pdfs
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
from fastapi_app.lib.models.models import FileCreate, FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_gc import purge_deleted_files, purge_unreferenced_archived_pdfs
from fastapi_app.lib.storage.file_storage import FileStorage


class TestArchivedPdfs(unittest.TestCase):
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
        self.pdf = self.insert(self.old_hash, "pdf", stable_id="pdf1", doc_collections=["c1"])

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
        return rows[-1] if stable_id is None else self.repo.get_file_by_stable_id(stable_id)

    def add_version(self, content: bytes, **kwargs) -> FileMetadata:
        return self.insert(self.save(content, "tei"), "tei", **kwargs)

    def ocr(self, content: bytes = b"%PDF ocr") -> tuple[FileMetadata, FileMetadata | None]:
        new_hash = self.save(content, "pdf")
        return self.repo.replace_pdf_content("pdf1", new_hash, len(content), {"ocr": {"engine": "fake"}})

    def gc_context(self) -> GcContext:
        return GcContext(deleted_before=datetime(2999, 1, 1), file_repo=self.repo, file_storage=self.storage,
                         db_dir=self.test_dir, is_admin=True)

    def test_without_versions_nothing_is_archived(self):
        current, archived = self.ocr()
        self.assertIsNone(archived)
        self.assertEqual(current.stable_id, "pdf1")
        self.assertNotEqual(current.id, self.old_hash)
        self.assertIsNone(self.storage.get_file_path(self.old_hash, "pdf"))

    def test_versions_keep_the_original_pdf(self):
        v1 = self.add_version(b"<TEI>1</TEI>")
        current, archived = self.ocr()
        assert archived is not None
        self.assertEqual(current.stable_id, "pdf1")
        self.assertEqual(archived.id, self.old_hash)
        self.assertEqual(archived.superseded_by, "pdf1")
        self.assertEqual(archived.doc_id, "doc1")
        self.assertEqual(archived.doc_collections, ["c1"])
        self.assertNotIn("ocr", archived.file_metadata)
        self.assertEqual(current.file_metadata["ocr"]["engine"], "fake")
        self.assertIsNotNone(self.storage.get_file_path(self.old_hash, "pdf"))
        # the version is linked to the archived PDF, a new one to the current PDF
        v1 = self.repo.get_file_by_stable_id(v1.stable_id)
        self.assertEqual(v1.pdf_stable_id, archived.stable_id)
        self.assertEqual(self.repo.get_pdf_for_file(v1).stable_id, archived.stable_id)
        v2 = self.add_version(b"<TEI>2</TEI>")
        self.assertIsNone(v2.pdf_stable_id)
        self.assertEqual(self.repo.get_pdf_for_file(v2).stable_id, "pdf1")

    def test_archived_pdf_is_hidden_from_document_queries(self):
        self.add_version(b"<TEI>1</TEI>")
        _, archived = self.ocr()
        assert archived is not None
        self.assertEqual(self.repo.get_pdf_for_document("doc1").stable_id, "pdf1")
        pdf_ids = lambda files: sorted(f.stable_id for f in files if f.file_type == "pdf")
        self.assertEqual(pdf_ids(self.repo.get_files_by_doc_id("doc1")), ["pdf1"])
        self.assertEqual(pdf_ids(self.repo.list_files()), ["pdf1"])
        self.assertEqual(pdf_ids(self.repo.get_all_files()), ["pdf1"])
        self.assertEqual(pdf_ids(self.repo.get_files_by_collection("c1")), ["pdf1"])
        self.assertEqual(pdf_ids(self.repo.get_files_by_doc_id("doc1", include_superseded=True)), sorted(["pdf1", archived.stable_id]))
        self.assertIsNotNone(self.repo.get_file_by_stable_id(archived.stable_id))
        self.assertIn(archived.stable_id, [f.stable_id for f in self.repo.get_files_to_upload()])

    def test_repeated_ocr(self):
        v1 = self.add_version(b"<TEI>1</TEI>")
        _, first = self.ocr(b"%PDF ocr 1")
        v2 = self.add_version(b"<TEI>2</TEI>")
        _, second = self.ocr(b"%PDF ocr 2")
        assert first is not None and second is not None
        self.assertNotEqual(first.stable_id, second.stable_id)
        self.assertEqual(self.repo.get_file_by_stable_id(v1.stable_id).pdf_stable_id, first.stable_id)
        self.assertEqual(self.repo.get_file_by_stable_id(v2.stable_id).pdf_stable_id, second.stable_id)

    def test_shared_content_only_changes_the_ocr_pdf(self):
        other = self.insert(self.old_hash, "pdf", doc_id="doc2", stable_id="pdf2")
        self.add_version(b"<TEI>1</TEI>")
        current, _ = self.ocr()
        self.assertNotEqual(current.id, self.old_hash)
        self.assertEqual(self.repo.get_file_by_stable_id(other.stable_id).id, self.old_hash)

    def test_archived_pdf_cannot_be_replaced(self):
        self.add_version(b"<TEI>1</TEI>")
        _, archived = self.ocr()
        assert archived is not None
        with self.assertRaises(ValueError):
            self.repo.replace_pdf_content(archived.stable_id, self.save(b"%PDF x", "pdf"), 1, {})

    def test_gc_keeps_archived_pdf_while_referenced(self):
        v1 = self.add_version(b"<TEI>1</TEI>")
        _, archived = self.ocr()
        assert archived is not None
        self.assertEqual(purge_unreferenced_archived_pdfs(self.gc_context()).items_deleted, 0)

        # a soft-deleted version still keeps its archived PDF (it can be restored)
        self.repo.delete_file(v1.id, stable_id=v1.stable_id)
        self.assertEqual(purge_unreferenced_archived_pdfs(self.gc_context()).items_deleted, 0)
        self.assertIsNotNone(self.storage.get_file_path(self.old_hash, "pdf"))

        # once the version is purged, the archived PDF goes as well
        purge_deleted_files(self.gc_context())
        ctx = self.gc_context()
        ctx.dry_run = True
        self.assertEqual(purge_unreferenced_archived_pdfs(ctx).items_deleted, 1)
        self.assertIsNotNone(self.repo.get_file_by_stable_id(archived.stable_id))
        self.assertEqual(purge_unreferenced_archived_pdfs(self.gc_context()).items_deleted, 1)
        self.assertIsNone(self.repo.get_file_by_stable_id(archived.stable_id, include_deleted=True))
        self.assertIsNone(self.storage.get_file_path(self.old_hash, "pdf"))
        current = self.repo.get_file_by_stable_id("pdf1")
        assert current is not None
        self.assertIsNotNone(self.storage.get_file_path(current.id, "pdf"))


if __name__ == "__main__":
    unittest.main()

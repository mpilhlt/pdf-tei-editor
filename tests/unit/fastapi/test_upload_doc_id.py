"""
Unit tests for file upload doc_id assignment

Tests that uploaded files get proper doc_id from filename, including when the
same file content is re-uploaded with a different (e.g. DOI-based) filename.

@testCovers fastapi_app/routers/files_upload.py
"""

import io
import tempfile
import unittest
from pathlib import Path
import sys
import re

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))


class TestUploadDocId(unittest.TestCase):
    """Test that upload assigns doc_id correctly from filename."""

    def test_doc_id_from_filename(self):
        """Test that doc_id is derived from filename without extension."""
        # Simulate the logic in files_upload.py
        filename = "my-document.pdf"
        original_name = filename.rsplit('.', 1)[0]
        doc_id = re.sub(r'\s+', '_', original_name)

        self.assertEqual(doc_id, "my-document")

    def test_doc_id_replaces_whitespace(self):
        """Test that whitespace in filename is replaced with underscores."""
        filename = "My Document With Spaces.pdf"
        original_name = filename.rsplit('.', 1)[0]
        doc_id = re.sub(r'\s+', '_', original_name)

        self.assertEqual(doc_id, "My_Document_With_Spaces")

    def test_doc_id_preserves_doi_format(self):
        """Test that DOI-like filenames are preserved."""
        filename = "10.1111__eulj.12049.pdf"
        original_name = filename.rsplit('.', 1)[0]
        # Note: DOI underscores are NOT replaced (only whitespace)
        doc_id = re.sub(r'\s+', '_', original_name)

        # The label conversion happens separately: original_name.replace("__", "/")
        # But doc_id keeps the original format
        self.assertEqual(doc_id, "10.1111__eulj.12049")

    def test_doc_id_for_xml_file(self):
        """Test that XML files also get doc_id from filename."""
        filename = "extracted-content.tei.xml"
        original_name = filename.rsplit('.', 1)[0]
        doc_id = re.sub(r'\s+', '_', original_name)

        self.assertEqual(doc_id, "extracted-content.tei")


class TestUploadDuplicateDocIdUpdate(unittest.TestCase):
    """Test that re-uploading a file with a different filename updates doc_id."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_duplicate_upload_updates_doc_id(self):
        """Re-uploading a file with a DOI-based name must update the existing doc_id."""
        from fastapi_app.lib.core.database import DatabaseManager
        from fastapi_app.lib.repository.file_repository import FileRepository
        from fastapi_app.lib.storage.file_storage import FileStorage
        from fastapi_app.lib.models.models import FileCreate
        from fastapi_app.main import app
        from fastapi_app.lib.core.dependencies import (
            get_file_repository,
            get_file_storage,
            get_session_id,
            get_current_user,
        )
        from fastapi.testclient import TestClient

        db = DatabaseManager(self.test_dir / "test.db")
        repo = FileRepository(db)
        storage = FileStorage(self.test_dir, db)

        # Seed the database: same PDF content, title-based doc_id
        pdf_content = b"%PDF-1.4 test content unique_abc"
        import hashlib
        file_hash = hashlib.sha256(pdf_content).hexdigest()
        storage.save_file(pdf_content, 'pdf')
        repo.insert_file(FileCreate(
            id=file_hash,
            filename=f"{file_hash}.pdf",
            doc_id="Schäfer_(2021)_Title",
            file_type='pdf',
            file_size=len(pdf_content),
            label="Schäfer (2021) Title",
            doc_collections=["_inbox"],
        ))

        # Verify initial state
        initial = repo.get_file_by_id(file_hash)
        self.assertEqual(initial.doc_id, "Schäfer_(2021)_Title")

        app.dependency_overrides[get_file_repository] = lambda: repo
        app.dependency_overrides[get_file_storage] = lambda: storage
        app.dependency_overrides[get_session_id] = lambda: "test-session"
        app.dependency_overrides[get_current_user] = lambda: {"username": "testuser"}

        try:
            client = TestClient(app)
            response = client.post(
                "/api/v1/files/upload",
                files={"file": ("10.1628__rabelsz-2021-0049.pdf", io.BytesIO(pdf_content), "application/pdf")},
            )
            self.assertEqual(response.status_code, 200)

            updated = repo.get_file_by_id(file_hash)
            self.assertEqual(
                updated.doc_id,
                "10.1628__rabelsz-2021-0049",
                "doc_id should be updated to the DOI-based value from the new filename",
            )
            self.assertEqual(
                updated.label,
                "10.1628/rabelsz-2021-0049",
                "label should reflect the decoded DOI",
            )
        finally:
            app.dependency_overrides.clear()


if __name__ == '__main__':
    unittest.main()

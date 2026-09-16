"""
Unit tests for extraction functionality

Tests that extractors set the correct fileref (doc_id) in extracted TEI.

@testCovers fastapi_app/plugins/test_plugin/extractor.py
@testCovers fastapi_app/plugins/grobid/extractor.py
@testCovers fastapi_app/plugins/llamore_extractor/extractor.py
@testCovers fastapi_app/routers/extraction.py
"""

import unittest
import tempfile
import json
from pathlib import Path
import sys
from lxml import etree

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.plugins.test_plugin.extractor import MockExtractor


XML_NS = "http://www.w3.org/XML/1998/namespace"


def _get_file_desc_xml_id(root: etree._Element) -> str | None:
    """Helper: return decoded fileref from fileDesc/@xml:id."""
    from fastapi_app.lib.utils.doi_utils import decode_from_xml_id
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    file_desc = root.find('.//tei:fileDesc', ns)
    if file_desc is None:
        return None
    xml_id = file_desc.get(f"{{{XML_NS}}}id")
    return decode_from_xml_id(xml_id) if xml_id else None


class TestExtractionFileref(unittest.IsolatedAsyncioTestCase):
    """Test that extractors write doc_id to fileDesc/@xml:id."""

    async def test_mock_extractor_uses_doc_id_from_options(self):
        """Test that MockExtractor uses doc_id from options for fileDesc/@xml:id."""
        extractor = MockExtractor()

        pdf_path = "/path/to/storage/a1b2c3d4e5f6.pdf"
        doc_id = "my-document-2024"

        result = await extractor.extract(
            pdf_path=pdf_path,
            options={'doc_id': doc_id}
        )

        root = etree.fromstring(result.encode('utf-8'))
        fileref = _get_file_desc_xml_id(root)

        self.assertIsNotNone(fileref, "fileDesc/@xml:id should be set")
        self.assertEqual(fileref, doc_id,
                         f"fileref should be '{doc_id}', not derived from storage path")

    async def test_mock_extractor_fallback_to_pdf_path(self):
        """Test that MockExtractor falls back to PDF path when no doc_id in options."""
        extractor = MockExtractor()

        pdf_path = "/path/to/my-document.pdf"

        result = await extractor.extract(
            pdf_path=pdf_path,
            options={}
        )

        root = etree.fromstring(result.encode('utf-8'))
        fileref = _get_file_desc_xml_id(root)

        self.assertIsNotNone(fileref, "fileDesc/@xml:id should be set")
        self.assertEqual(fileref, "my-document",
                         "fileref should be derived from PDF filename when no doc_id provided")

    async def test_mock_extractor_without_pdf_path(self):
        """Test that MockExtractor generates a fileref when no PDF path provided."""
        extractor = MockExtractor()

        result = await extractor.extract(
            xml_content="<TEI></TEI>",
            options={}
        )

        root = etree.fromstring(result.encode('utf-8'))
        fileref = _get_file_desc_xml_id(root)

        self.assertIsNotNone(fileref, "fileDesc/@xml:id should be set")
        self.assertTrue(fileref.startswith("mock-extracted-"),
                        "fileref should be auto-generated when no PDF path")


class TestExtractionRevisionDesc(unittest.IsolatedAsyncioTestCase):
    """Test that extractors add revisionDesc with change element."""

    async def test_mock_extractor_includes_revision_desc(self):
        """Test that MockExtractor includes revisionDesc with change element."""
        extractor = MockExtractor()

        result = await extractor.extract(
            pdf_path="/path/to/test.pdf",
            options={}
        )

        # Parse the result
        root = etree.fromstring(result.encode('utf-8'))
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}

        # Check for revisionDesc
        revision_desc = root.find('.//tei:revisionDesc', ns)
        self.assertIsNotNone(revision_desc, "revisionDesc should exist")

        # Check for change element
        change_elem = revision_desc.find('.//tei:change', ns)
        self.assertIsNotNone(change_elem, "change element should exist in revisionDesc")

        # Check attributes
        self.assertIsNotNone(change_elem.get('when'), "change element should have 'when' attribute")
        self.assertEqual(change_elem.get('status'), 'extraction', "change element should have status='extraction'")

        # Check desc element inside change
        desc_elem = change_elem.find('tei:desc', ns)
        self.assertIsNotNone(desc_elem, "desc element should exist inside change")
        self.assertIsNotNone(desc_elem.text, "desc element should have text content")
        self.assertIn("mock extractor", desc_elem.text.lower(), "desc text should mention mock extractor")


class TestMockExtractorVariants(unittest.TestCase):
    """Test that MockExtractor exposes variants correctly in get_info()."""

    def test_variants_field_present(self):
        """get_info() must include a top-level 'variants' list."""
        info = MockExtractor.get_info()
        self.assertIn('variants', info)
        self.assertIsInstance(info['variants'], list)

    def test_variants_not_empty(self):
        """variants list must contain at least one entry."""
        info = MockExtractor.get_info()
        self.assertGreater(len(info['variants']), 0)

    def test_variants_match_options(self):
        """variants must equal options.variant_id.options."""
        info = MockExtractor.get_info()
        option_variants = info['options']['variant_id']['options']
        self.assertEqual(info['variants'], option_variants)

    def test_all_variants_have_string_ids(self):
        """Every variant id must be a non-empty string."""
        info = MockExtractor.get_info()
        for v in info['variants']:
            self.assertIsInstance(v, str)
            self.assertTrue(v, f"variant id must not be empty, got {v!r}")

    def test_navigation_xpath_is_subset_of_variants(self):
        """navigation_xpath keys must be a subset of variants."""
        info = MockExtractor.get_info()
        xpath_keys = set(info.get('navigation_xpath', {}).keys())
        variant_ids = set(info['variants'])
        self.assertTrue(xpath_keys.issubset(variant_ids),
                        f"navigation_xpath keys {xpath_keys - variant_ids} not in variants")


class TestExtractionFailurePreservesCollection(unittest.TestCase):
    """
    Test that a PDF is moved into the user-selected collection before extraction
    is attempted, so a failed extraction (e.g. Grobid down) doesn't leave it stuck
    in the upload-time default "_inbox" collection (#477).
    """

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_failed_extraction_still_moves_pdf_out_of_inbox(self):
        import hashlib
        from unittest.mock import patch
        from fastapi.testclient import TestClient

        from fastapi_app.config import Settings, get_settings
        from fastapi_app.lib.core.database import DatabaseManager
        from fastapi_app.lib.repository.file_repository import FileRepository
        from fastapi_app.lib.storage.file_storage import FileStorage
        from fastapi_app.lib.models.models import FileCreate
        from fastapi_app.lib.core.dependencies import (
            get_file_repository,
            get_file_storage,
            require_authenticated_user,
        )
        from fastapi_app.main import app

        db = DatabaseManager(self.test_dir / "test.db")
        repo = FileRepository(db)
        storage = FileStorage(self.test_dir / "files", db)

        pdf_content = b"%PDF-1.4 test content for issue 477"
        file_hash = hashlib.sha256(pdf_content).hexdigest()
        storage.save_file(pdf_content, 'pdf')
        repo.insert_file(FileCreate(
            id=file_hash,
            filename=f"{file_hash}.pdf",
            doc_id="test-doc-477",
            file_type='pdf',
            file_size=len(pdf_content),
            label="Test doc",
            doc_collections=["_inbox"],
        ))

        class _FailingExtractor:
            """Stands in for an extractor whose backend (e.g. Grobid) is down."""

            @classmethod
            def get_info(cls):
                return {'input': ['pdf'], 'output': ['tei-document']}

            async def extract(self, pdf_path=None, xml_content=None, options=None):
                raise RuntimeError("Grobid server down")

        fake_settings = Settings(DATA_ROOT=str(self.test_dir))

        app.dependency_overrides[get_file_repository] = lambda: repo
        app.dependency_overrides[get_file_storage] = lambda: storage
        app.dependency_overrides[require_authenticated_user] = lambda: {
            "username": "testuser", "roles": ["admin"]
        }
        app.dependency_overrides[get_settings] = lambda: fake_settings

        try:
            with patch("fastapi_app.routers.extraction.create_extractor", return_value=_FailingExtractor()):
                client = TestClient(app)
                with self.assertLogs('fastapi_app.routers.extraction', level='ERROR'):
                    response = client.post(
                        "/api/v1/extract",
                        json={
                            "extractor": "mock-extractor",
                            "file_id": file_hash,
                            "options": {"collection": "my_project_collection"}
                        }
                    )
            self.assertEqual(response.status_code, 500)

            updated = repo.get_file_by_id(file_hash)
            self.assertEqual(
                updated.doc_collections,
                ["my_project_collection"],
                "PDF should be moved to the selected collection even though extraction failed"
            )
        finally:
            app.dependency_overrides.clear()


if __name__ == '__main__':
    unittest.main()

"""
Unit tests for extraction functionality

Tests that extractors set the correct fileref (doc_id) in extracted TEI.

@testCovers fastapi_app/plugins/test_plugin/extractor.py
@testCovers fastapi_app/plugins/grobid/extractor.py
@testCovers fastapi_app/plugins/llamore/extractor.py
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


if __name__ == '__main__':
    unittest.main()

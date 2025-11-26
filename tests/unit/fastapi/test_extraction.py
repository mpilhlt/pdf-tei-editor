"""
Unit tests for extraction functionality

Tests that extractors set the correct fileref (doc_id) in extracted TEI.

@testCovers fastapi_app/extractors/mock_extractor.py
@testCovers fastapi_app/extractors/grobid_training_extractor.py
@testCovers fastapi_app/extractors/llamore_extractor.py
"""

import unittest
from pathlib import Path
import sys
from lxml import etree

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.extractors.mock_extractor import MockExtractor


class TestExtractionFileref(unittest.TestCase):
    """Test that extractors use doc_id from options for fileref."""

    def test_mock_extractor_uses_doc_id_from_options(self):
        """Test that MockExtractor uses doc_id from options instead of deriving from PDF path."""
        extractor = MockExtractor()

        # Simulate extraction with hash-based storage path but doc_id in options
        pdf_path = "/path/to/storage/a1b2c3d4e5f6.pdf"
        doc_id = "my-document-2024"

        result = extractor.extract(
            pdf_path=pdf_path,
            options={'doc_id': doc_id}
        )

        # Parse the result to check fileref
        root = etree.fromstring(result.encode('utf-8'))
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}
        fileref_elem = root.find('.//tei:idno[@type="fileref"]', ns)

        self.assertIsNotNone(fileref_elem, "fileref element should exist")
        self.assertEqual(fileref_elem.text, doc_id,
                        f"fileref should be '{doc_id}', not derived from storage path")

    def test_mock_extractor_fallback_to_pdf_path(self):
        """Test that MockExtractor falls back to PDF path when no doc_id in options."""
        extractor = MockExtractor()

        pdf_path = "/path/to/my-document.pdf"

        result = extractor.extract(
            pdf_path=pdf_path,
            options={}
        )

        # Parse the result to check fileref
        root = etree.fromstring(result.encode('utf-8'))
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}
        fileref_elem = root.find('.//tei:idno[@type="fileref"]', ns)

        self.assertIsNotNone(fileref_elem, "fileref element should exist")
        self.assertEqual(fileref_elem.text, "my-document",
                        "fileref should be derived from PDF filename when no doc_id provided")

    def test_mock_extractor_without_pdf_path(self):
        """Test that MockExtractor generates a fileref when no PDF path provided."""
        extractor = MockExtractor()

        result = extractor.extract(
            xml_content="<TEI></TEI>",
            options={}
        )

        # Parse the result to check fileref
        root = etree.fromstring(result.encode('utf-8'))
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}
        fileref_elem = root.find('.//tei:idno[@type="fileref"]', ns)

        self.assertIsNotNone(fileref_elem, "fileref element should exist")
        self.assertTrue(fileref_elem.text.startswith("mock-extracted-"),
                       "fileref should be auto-generated when no PDF path")


if __name__ == '__main__':
    unittest.main()

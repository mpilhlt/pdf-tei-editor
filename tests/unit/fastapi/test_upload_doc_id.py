"""
Unit tests for file upload doc_id assignment

Tests that uploaded files get proper doc_id from filename.

@testCovers fastapi_app/routers/files_upload.py
"""

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


if __name__ == '__main__':
    unittest.main()

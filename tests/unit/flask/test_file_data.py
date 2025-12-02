#!/usr/bin/env python3
"""
@testCovers server/lib/file_data.py

Unit tests for TEI metadata extraction functions in file_data.py.
"""

import unittest
import sys
from pathlib import Path
from lxml import etree

# Add server directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'server'))

from lib.file_data import get_tei_metadata


class TestTeiMetadataExtraction(unittest.TestCase):
    """Test cases for TEI metadata extraction."""

    def setUp(self):
        """Set up test environment by parsing the fixture file."""
        self.fixture_path = Path(__file__).parent / 'fixtures' / 'data' / 'sample_tei.xml'
        try:
            self.xml_tree = etree.parse(str(self.fixture_path))
            self.xml_root = self.xml_tree.getroot()
        except Exception as e:
            self.fail(f"Failed to parse fixture file {self.fixture_path}: {e}")

    def test_get_tei_metadata_extraction(self):
        """Test that various metadata fields are correctly extracted."""
        metadata = get_tei_metadata(str(self.fixture_path))
        
        self.assertIsNotNone(metadata)
        self.assertEqual(metadata.get('variant_id'), 'grobid.training.segmentation')
        self.assertEqual(metadata.get('doi'), '10.5771/2699-1284-2024-3-149')
        self.assertEqual(metadata.get('title'), 'Legal status of Derived Text Formats – 2nd deliverable of Text+ AG Legal and Ethical Issues –')
        self.assertEqual(metadata.get('author'), 'Iacino')
        self.assertEqual(metadata.get('date'), '2024')
        self.assertEqual(metadata.get('fileref'), '') # fileref is now an empty string if not found


if __name__ == '__main__':
    unittest.main()

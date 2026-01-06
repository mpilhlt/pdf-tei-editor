"""
Unit tests for TEI utilities.
"""

import unittest
import tempfile
import json
from pathlib import Path
from lxml import etree
from fastapi_app.lib.tei_utils import (
    serialize_tei_with_formatted_header,
    create_schema_processing_instruction
)


class TestSerializeTeiWithFormattedHeader(unittest.TestCase):
    """Test serialize_tei_with_formatted_header function."""

    def test_preserves_processing_instructions(self):
        """Test that processing instructions are preserved during serialization."""
        # Create a simple TEI document
        tei_xml = """<?xml version="1.0"?>
<?xml-model href="https://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <p>Test content</p>
    </body>
  </text>
</TEI>"""

        # Parse the XML
        xml_root = etree.fromstring(tei_xml.encode('utf-8'))

        # Extract processing instructions manually (simulating what _extract_processing_instructions does)
        processing_instructions = [
            '<?xml-model href="https://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>'
        ]

        # Serialize with processing instructions
        result = serialize_tei_with_formatted_header(xml_root, processing_instructions)

        # Verify processing instruction is preserved
        self.assertIn('<?xml-model', result)
        self.assertIn('https://example.com/schema.rng', result)

    def test_preserves_multiple_processing_instructions(self):
        """Test that multiple processing instructions are preserved."""
        tei_xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>"""

        xml_root = etree.fromstring(tei_xml.encode('utf-8'))

        processing_instructions = [
            '<?xml-model href="schema1.rng" type="application/xml"?>',
            '<?xml-stylesheet href="style.xsl" type="text/xsl"?>'
        ]

        result = serialize_tei_with_formatted_header(xml_root, processing_instructions)

        # Both PIs should be present
        self.assertIn('schema1.rng', result)
        self.assertIn('style.xsl', result)

        # PIs should come before the TEI element
        pi1_pos = result.find('<?xml-model')
        pi2_pos = result.find('<?xml-stylesheet')
        tei_pos = result.find('<TEI')

        self.assertLess(pi1_pos, tei_pos, "Processing instructions should come before TEI element")
        self.assertLess(pi2_pos, tei_pos, "Processing instructions should come before TEI element")

    def test_works_without_processing_instructions(self):
        """Test that serialization works when no processing instructions are provided."""
        tei_xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>"""

        xml_root = etree.fromstring(tei_xml.encode('utf-8'))

        # No processing instructions
        result = serialize_tei_with_formatted_header(xml_root)

        # Should still serialize correctly
        self.assertIn('<TEI', result)
        self.assertIn('<teiHeader>', result)
        self.assertIn('Test', result)

    def test_does_not_include_xml_declaration(self):
        """Test that XML declaration is not included in output."""
        tei_xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>"""

        xml_root = etree.fromstring(tei_xml.encode('utf-8'))
        result = serialize_tei_with_formatted_header(xml_root)

        # XML declaration should NOT be present
        self.assertNotIn('<?xml version=', result)

    def test_preserves_text_element_formatting(self):
        """Test that text elements maintain their original formatting."""
        tei_xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <p>Line1
Line2</p>
    </body>
  </text>
</TEI>"""

        xml_root = etree.fromstring(tei_xml.encode('utf-8'))
        result = serialize_tei_with_formatted_header(xml_root)

        # Text content should be preserved
        self.assertIn('Line1', result)
        self.assertIn('Line2', result)


class TestProcessingInstructionsExtraction(unittest.TestCase):
    """Test processing instruction extraction from files_save.py."""

    def test_extract_processing_instructions(self):
        """Test extraction of processing instructions from XML string."""
        from fastapi_app.routers.files_save import _extract_processing_instructions

        xml_string = """<?xml version="1.0"?>
<?xml-model href="https://example.com/schema.rng" type="application/xml"?>
<?xml-stylesheet href="style.xsl" type="text/xsl"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>"""

        pis = _extract_processing_instructions(xml_string)

        # Should extract 2 PIs (not the xml declaration)
        self.assertEqual(len(pis), 2)
        self.assertIn('xml-model', pis[0])
        self.assertIn('xml-stylesheet', pis[1])

    def test_does_not_extract_xml_declaration(self):
        """Test that XML declaration is not extracted as a processing instruction."""
        from fastapi_app.routers.files_save import _extract_processing_instructions

        xml_string = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader/>
</TEI>"""

        pis = _extract_processing_instructions(xml_string)

        # Should be empty - xml declaration is not a processing instruction
        self.assertEqual(len(pis), 0)

    def test_grobid_training_schema_extraction(self):
        """Test extraction of grobid training schema processing instruction."""
        from fastapi_app.routers.files_save import _extract_processing_instructions

        xml_string = """<?xml version="1.0"?>
<?xml-model href="https://mpilhlt.github.io/grobid-footnote-flavour/schema/grobid.training.segmentation.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader/>
</TEI>"""

        pis = _extract_processing_instructions(xml_string)

        self.assertEqual(len(pis), 1)
        self.assertIn('grobid.training.segmentation.rng', pis[0])
        self.assertIn('http://relaxng.org/ns/structure/1.0', pis[0])


class TestCreateSchemaProcessingInstruction(unittest.TestCase):
    """Test create_schema_processing_instruction function."""

    def test_creates_correct_processing_instruction(self):
        """Test that the function creates a valid processing instruction."""
        schema_url = "https://mpilhlt.github.io/grobid-footnote-flavour/schema/grobid.training.segmentation.rng"
        result = create_schema_processing_instruction(schema_url)

        expected = '<?xml-model href="https://mpilhlt.github.io/grobid-footnote-flavour/schema/grobid.training.segmentation.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>'
        self.assertEqual(result, expected)

    def test_works_with_llamore_schema(self):
        """Test that it works with llamore schema URLs."""
        schema_url = "https://mpilhlt.github.io/llamore/schema/llamore.rng"
        result = create_schema_processing_instruction(schema_url)

        self.assertIn("llamore.rng", result)
        self.assertIn('type="application/xml"', result)
        self.assertIn('schematypens="http://relaxng.org/ns/structure/1.0"', result)

    def test_works_with_mock_schema(self):
        """Test that it works with mock extractor schema URLs."""
        schema_url = "https://example.com/schema/mock-default.rng"
        result = create_schema_processing_instruction(schema_url)

        self.assertIn("mock-default.rng", result)
        self.assertIn('type="application/xml"', result)


if __name__ == '__main__':
    unittest.main()

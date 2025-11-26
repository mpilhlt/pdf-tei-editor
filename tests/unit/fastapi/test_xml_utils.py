"""
Unit tests for xml_utils.py

Tests XML entity encoding with configurable quote encoding.

@testCovers fastapi_app/lib/xml_utils.py
"""

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.xml_utils import encode_xml_entities, EncodeOptions


class TestXmlEntityEncoding(unittest.TestCase):
    """Test XML entity encoding functionality."""

    def test_encode_required_entities_by_default(self):
        """Test that required entities (&, <, >) are always encoded."""
        # Note: Input has well-formed XML structure (no unescaped < > in content)
        xml_input = "<root>Test &amp; text</root>"
        expected = "<root>Test &amp; text</root>"
        result = encode_xml_entities(xml_input)
        self.assertEqual(result, expected)

        # Test with actual & character that needs escaping
        xml_input2 = "<root>Test & text</root>"
        expected2 = "<root>Test &amp; text</root>"
        result2 = encode_xml_entities(xml_input2)
        self.assertEqual(result2, expected2)

    def test_preserve_quotes_by_default(self):
        """Test that quotes and apostrophes are NOT encoded by default."""
        xml_input = """<root>Test "quoted" and 'apostrophe' text</root>"""
        expected = """<root>Test "quoted" and 'apostrophe' text</root>"""
        result = encode_xml_entities(xml_input)
        self.assertEqual(result, expected)

    def test_encode_quotes_when_option_enabled(self):
        """Test that quotes are encoded when encode_quotes option is True."""
        xml_input = """<root>Test "quoted" and 'apostrophe' text</root>"""
        expected = """<root>Test &quot;quoted&quot; and &apos;apostrophe&apos; text</root>"""
        options: EncodeOptions = {'encode_quotes': True}
        result = encode_xml_entities(xml_input, options)
        self.assertEqual(result, expected)

    def test_encode_mixed_content(self):
        """Test encoding with mixed special characters."""
        # Note: Well-formed XML structure (no unescaped < > in content)
        xml_input = """<root>Test &amp; "quotes" 'apos'</root>"""
        expected_default = """<root>Test &amp; "quotes" 'apos'</root>"""
        expected_with_quotes = """<root>Test &amp; &quot;quotes&quot; &apos;apos&apos;</root>"""

        # Default behavior
        result_default = encode_xml_entities(xml_input)
        self.assertEqual(result_default, expected_default)

        # With quote encoding
        options: EncodeOptions = {'encode_quotes': True}
        result_with_quotes = encode_xml_entities(xml_input, options)
        self.assertEqual(result_with_quotes, expected_with_quotes)

    def test_preserve_tags(self):
        """Test that content within tags is not encoded."""
        xml_input = '<root attr="value">Content & text</root>'
        expected = '<root attr="value">Content &amp; text</root>'
        result = encode_xml_entities(xml_input)
        self.assertEqual(result, expected)

    def test_prevent_double_encoding(self):
        """Test that already-encoded entities are not double-encoded."""
        xml_input = "<root>Already &amp; encoded &lt;text&gt;</root>"
        expected = "<root>Already &amp; encoded &lt;text&gt;</root>"
        result = encode_xml_entities(xml_input)
        self.assertEqual(result, expected)

    def test_empty_string(self):
        """Test encoding of empty string."""
        result = encode_xml_entities("")
        self.assertEqual(result, "")

    def test_none_options(self):
        """Test that None options work correctly (use defaults)."""
        xml_input = """<root>Test "quoted" text</root>"""
        expected = """<root>Test "quoted" text</root>"""
        result = encode_xml_entities(xml_input, None)
        self.assertEqual(result, expected)

    def test_xml_declaration_preserved(self):
        """Test that XML declaration is preserved."""
        xml_input = """<?xml version="1.0"?><root>Test & text</root>"""
        expected = """<?xml version="1.0"?><root>Test &amp; text</root>"""
        result = encode_xml_entities(xml_input)
        self.assertEqual(result, expected)


if __name__ == '__main__':
    unittest.main()

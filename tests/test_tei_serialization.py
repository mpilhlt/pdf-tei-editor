#!/usr/bin/env python3
"""
Unit tests for TEI serialization functions.

Tests the TEI utility functions, especially the serialize_tei_with_formatted_header
function to ensure it doesn't create self-closing TEI tags.
"""

import unittest
import sys
import os

# Add parent directory to path to import server modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lxml import etree
from server.lib.tei_utils import (
    create_tei_document,
    create_tei_header, 
    serialize_tei_with_formatted_header,
    serialize_tei_xml
)


class TestTeiSerialization(unittest.TestCase):
    """Test TEI document serialization functions."""
    
    def test_serialize_tei_with_formatted_header_no_self_closing(self):
        """Test that serialize_tei_with_formatted_header doesn't create self-closing TEI tags."""
        
        # Create a minimal TEI document
        tei_doc = create_tei_document("relaxng")
        
        # Add a simple header
        tei_header = create_tei_header(doi="10.1000/test.doi", metadata={
            "title": "Test Document",
            "authors": [{"given": "John", "family": "Doe"}],
            "date": "2025"
        })
        tei_doc.append(tei_header)
        
        # Serialize using the function under test
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Debug output
        print("\n=== Serialization Result ===")
        print(result[:500] + "..." if len(result) > 500 else result)
        
        # The key assertion: should NOT contain self-closing TEI tag
        self.assertNotIn('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>', result,
                        "TEI tag should not be self-closing")
        
        # Should contain proper opening and closing tags
        self.assertRegex(result, r'<TEI[^>]*xmlns="http://www\.tei-c\.org/ns/1\.0"[^>]*>',
                        "Should contain opening TEI tag with namespace")
        self.assertIn('</TEI>', result,
                     "Should contain closing TEI tag")
        
        # Should contain the header content (might have xmlns attribute)
        self.assertIn('teiHeader', result,
                     "Should contain teiHeader")
        self.assertIn('Test Document', result,
                     "Should contain the document title")
    
    def test_serialize_tei_with_formatted_header_with_text_element(self):
        """Test serialization with text elements to preserve their formatting."""
        
        # Create TEI document with text content
        tei_doc = create_tei_document("relaxng")
        
        # Add header
        tei_header = create_tei_header(doi="10.1000/test.doi")
        tei_doc.append(tei_header)
        
        # Add text element (this should preserve formatting)
        text_elem = etree.SubElement(tei_doc, "text")
        body_elem = etree.SubElement(text_elem, "body")
        p_elem = etree.SubElement(body_elem, "p")
        p_elem.text = "This is some body content that should preserve formatting."
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Debug output
        print("\n=== With Text Element Result ===")
        print(result[:300] + "..." if len(result) > 300 else result)
        
        # Should NOT be self-closing
        self.assertNotIn('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>', result,
                        "TEI tag should not be self-closing even with text content")
        
        # Should contain proper tags
        self.assertRegex(result, r'<TEI[^>]*xmlns="http://www\.tei-c\.org/ns/1\.0"[^>]*>',
                        "Should contain opening TEI tag with namespace")
        self.assertIn('</TEI>', result)
        
        # Should contain the text content (might have xmlns attribute)
        self.assertIn('text', result,
                     "Should contain text element")
        self.assertIn('preserve formatting', result,
                     "Should contain the text content")
    
    def test_serialize_tei_with_formatted_header_preserves_non_header_formatting(self):
        """Test that non-header elements preserve their original formatting."""
        
        # Create TEI document
        tei_doc = create_tei_document("relaxng")
        
        # Add header
        tei_header = create_tei_header()
        tei_doc.append(tei_header)
        
        # Add complex text structure that should preserve formatting
        text_elem = etree.SubElement(tei_doc, "text")
        body_elem = etree.SubElement(text_elem, "body")
        
        # Add a div with specific formatting
        div_elem = etree.SubElement(body_elem, "div", type="references")
        listBibl_elem = etree.SubElement(div_elem, "listBibl")
        
        # Add a reference with specific attributes
        bibl_elem = etree.SubElement(listBibl_elem, "bibl", n="1")
        bibl_elem.text = "Reference text here"
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        print("\n=== Complex Structure Result ===")
        lines = result.split('\n')
        for i, line in enumerate(lines):
            print(f"{i:2}: {line}")
        
        # Key assertions
        self.assertNotIn('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>', result,
                        "TEI tag should not be self-closing")
        
        # Should contain both formatted header and preserved text content
        self.assertIn('teiHeader>', result, "Should contain header")
        # Text elements have xmlns added by lxml during serialization
        self.assertIn('<text', result, "Should contain text element")
        self.assertIn('<div type="references">', result, "Should preserve div type attribute")
        self.assertIn('bibl n="1"', result, "Should preserve bibl attributes")
    
    def test_empty_tei_document_not_self_closing(self):
        """Test that even an empty TEI document doesn't become self-closing."""
        
        # Create minimal TEI document with no content
        tei_doc = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        print("\n=== Empty TEI Document Result ===")
        print(result)
        
        # Should not be self-closing
        self.assertNotIn('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>', result,
                        "Even empty TEI should not be self-closing")
        
        # Should have proper open/close tags
        self.assertRegex(result, r'<TEI[^>]*xmlns="http://www\.tei-c\.org/ns/1\.0"[^>]*>',
                        "Should contain opening TEI tag with namespace")
        self.assertIn('</TEI>', result)
    
    def test_comparison_with_standard_serialize(self):
        """Compare the custom serializer with standard TEI serialization."""
        
        # Create a TEI document
        tei_doc = create_tei_document("relaxng")
        tei_header = create_tei_header(doi="10.1000/test")
        tei_doc.append(tei_header)
        
        # Serialize with both methods
        custom_result = serialize_tei_with_formatted_header(tei_doc)
        standard_result = serialize_tei_xml(tei_doc)
        
        print("\n=== Custom Serialization ===")
        print(custom_result[:200] + "..." if len(custom_result) > 200 else custom_result)
        
        print("\n=== Standard Serialization ===") 
        print(standard_result[:200] + "..." if len(standard_result) > 200 else standard_result)
        
        # Custom serializer should avoid self-closing tags
        self.assertNotIn('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>', custom_result,
                        "Custom serializer should not create self-closing TEI")
        
        # Verify custom serializer produces proper opening tag
        self.assertRegex(custom_result, r'<TEI[^>]*xmlns="http://www\.tei-c\.org/ns/1\.0"[^>]*>',
                        "Custom serializer should contain opening TEI tag with namespace")
        self.assertIn('</TEI>', custom_result, "Custom serializer should contain closing TEI tag")


def run_tests():
    """Run the tests when this file is executed directly."""
    unittest.main(verbosity=2)


if __name__ == '__main__':
    run_tests()
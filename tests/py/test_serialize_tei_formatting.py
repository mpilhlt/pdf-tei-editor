"""
Comprehensive unit tests for serialize_tei_with_formatted_header function.

This test suite ensures that the TEI serialization function:
1. Preserves document structure and content
2. Produces valid XML output
3. Handles various TEI document types correctly
4. Does not corrupt or lose data during serialization
"""

import unittest
import sys
import os
from lxml import etree

# Add parent directory to path to import server modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from server.lib.tei_utils import (
    serialize_tei_with_formatted_header,
    create_tei_document,
    create_tei_header
)


class TestSerializeTeiFormatting(unittest.TestCase):
    """Test TEI document serialization to ensure data integrity."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.maxDiff = None  # Show full diff on failure
    
    def test_basic_tei_document_with_text(self):
        """Test serialization of a basic TEI document with text content."""
        # Create a TEI document with header and text
        tei_doc = create_tei_document("relaxng")
        
        # Add header
        tei_header = create_tei_header(
            doi="10.1000/test.doi",
            metadata={
                "title": "Test Document",
                "authors": [{"given": "John", "family": "Doe"}],
                "date": "2025"
            }
        )
        tei_doc.append(tei_header)
        
        # Add text element with content
        text_elem = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}text")
        body_elem = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}body")
        p_elem = etree.SubElement(body_elem, "{http://www.tei-c.org/ns/1.0}p")
        p_elem.text = "This is test content that must be preserved."
        
        # Add another paragraph
        p2_elem = etree.SubElement(body_elem, "{http://www.tei-c.org/ns/1.0}p")
        p2_elem.text = "This is a second paragraph with special characters: äöü & <test>"
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Verify result is valid XML
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML")
        
        # Parse result and verify structure
        parsed = etree.fromstring(result)
        
        # Verify TEI root element
        self.assertEqual(parsed.tag, "{http://www.tei-c.org/ns/1.0}TEI")
        
        # Verify teiHeader exists
        header = parsed.find(".//{http://www.tei-c.org/ns/1.0}teiHeader")
        self.assertIsNotNone(header, "teiHeader must be preserved")
        
        # Verify text element exists
        text = parsed.find(".//{http://www.tei-c.org/ns/1.0}text")
        self.assertIsNotNone(text, "text element must be preserved")
        
        # Verify body content
        body = parsed.find(".//{http://www.tei-c.org/ns/1.0}body")
        self.assertIsNotNone(body, "body element must be preserved")
        
        # Verify paragraphs and their content
        paragraphs = body.findall(".//{http://www.tei-c.org/ns/1.0}p")
        self.assertEqual(len(paragraphs), 2, "All paragraphs must be preserved")
        self.assertEqual(paragraphs[0].text, "This is test content that must be preserved.")
        self.assertEqual(paragraphs[1].text, "This is a second paragraph with special characters: äöü & <test>")
        
        # Verify title is preserved
        title = parsed.find(".//{http://www.tei-c.org/ns/1.0}title")
        self.assertIsNotNone(title, "Title must be preserved")
        self.assertEqual(title.text, "Test Document")
    
    def test_complex_tei_document_with_multiple_elements(self):
        """Test serialization of complex TEI document with various elements."""
        # Create a more complex TEI document
        tei_doc = etree.Element("{http://www.tei-c.org/ns/1.0}TEI", 
                               nsmap={None: "http://www.tei-c.org/ns/1.0"})
        
        # Add header with metadata
        tei_header = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}teiHeader")
        file_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}fileDesc")
        title_stmt = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}titleStmt")
        title = etree.SubElement(title_stmt, "{http://www.tei-c.org/ns/1.0}title")
        title.text = "Complex Test Document"
        
        # Add encoding desc with applications
        encoding_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}encodingDesc")
        app_info = etree.SubElement(encoding_desc, "{http://www.tei-c.org/ns/1.0}appInfo")
        app = etree.SubElement(app_info, "{http://www.tei-c.org/ns/1.0}application")
        app.set("ident", "test-app")
        app.set("version", "1.0")
        app.set("type", "extractor")
        
        # Add variant label
        variant_label = etree.SubElement(app, "{http://www.tei-c.org/ns/1.0}label")
        variant_label.set("type", "variant-id")
        variant_label.text = "test.variant"
        
        # Add facsimile element (should be preserved)
        facsimile = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}facsimile")
        surface = etree.SubElement(facsimile, "{http://www.tei-c.org/ns/1.0}surface")
        surface.set("{http://www.w3.org/XML/1998/namespace}id", "page1")
        graphic = etree.SubElement(surface, "{http://www.tei-c.org/ns/1.0}graphic")
        graphic.set("url", "page1.jpg")
        
        # Add text with nested structure
        text_elem = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}text")
        
        # Add front matter
        front = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}front")
        front_p = etree.SubElement(front, "{http://www.tei-c.org/ns/1.0}p")
        front_p.text = "Front matter content"
        
        # Add body
        body = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}body")
        div = etree.SubElement(body, "{http://www.tei-c.org/ns/1.0}div")
        div.set("type", "section")
        
        # Add multiple paragraphs with different content
        for i in range(3):
            p = etree.SubElement(div, "{http://www.tei-c.org/ns/1.0}p")
            p.text = f"Paragraph {i+1} with content that must be preserved exactly."
        
        # Add back matter
        back = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}back")
        back_div = etree.SubElement(back, "{http://www.tei-c.org/ns/1.0}div")
        back_div.set("type", "bibliography")
        bibl = etree.SubElement(back_div, "{http://www.tei-c.org/ns/1.0}bibl")
        bibl.text = "Bibliography entry"
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Verify result is valid XML
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML")
        
        # Parse and verify all elements are preserved
        parsed = etree.fromstring(result)
        
        # Verify root structure
        self.assertEqual(parsed.tag, "{http://www.tei-c.org/ns/1.0}TEI")
        
        # Verify all major sections exist
        self.assertIsNotNone(parsed.find(".//{http://www.tei-c.org/ns/1.0}teiHeader"))
        self.assertIsNotNone(parsed.find(".//{http://www.tei-c.org/ns/1.0}facsimile"))
        self.assertIsNotNone(parsed.find(".//{http://www.tei-c.org/ns/1.0}text"))
        
        # Verify facsimile content
        facsimile_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}facsimile")
        surface_parsed = facsimile_parsed.find(".//{http://www.tei-c.org/ns/1.0}surface")
        self.assertEqual(surface_parsed.get("{http://www.w3.org/XML/1998/namespace}id"), "page1")
        
        # Verify text structure
        text_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}text")
        front_parsed = text_parsed.find(".//{http://www.tei-c.org/ns/1.0}front")
        body_parsed = text_parsed.find(".//{http://www.tei-c.org/ns/1.0}body")
        back_parsed = text_parsed.find(".//{http://www.tei-c.org/ns/1.0}back")
        
        self.assertIsNotNone(front_parsed)
        self.assertIsNotNone(body_parsed)
        self.assertIsNotNone(back_parsed)
        
        # Verify content preservation
        front_p_parsed = front_parsed.find(".//{http://www.tei-c.org/ns/1.0}p")
        self.assertEqual(front_p_parsed.text, "Front matter content")
        
        # Verify all body paragraphs
        body_paragraphs = body_parsed.findall(".//{http://www.tei-c.org/ns/1.0}p")
        self.assertEqual(len(body_paragraphs), 3)
        for i, p in enumerate(body_paragraphs):
            expected_text = f"Paragraph {i+1} with content that must be preserved exactly."
            self.assertEqual(p.text, expected_text)
        
        # Verify bibliography
        bibl_parsed = back_parsed.find(".//{http://www.tei-c.org/ns/1.0}bibl")
        self.assertEqual(bibl_parsed.text, "Bibliography entry")
        
        # Verify variant metadata is preserved
        variant_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}label[@type='variant-id']")
        self.assertIsNotNone(variant_parsed, "Variant ID must be preserved")
        self.assertEqual(variant_parsed.text, "test.variant")
    
    def test_header_only_document(self):
        """Test serialization of TEI document with only header (no text element)."""
        tei_doc = create_tei_document("relaxng")
        
        # Add only header
        tei_header = create_tei_header(
            doi="10.1000/header.only",
            metadata={
                "title": "Header Only Document",
                "authors": [{"given": "Jane", "family": "Smith"}],
                "date": "2025"
            }
        )
        tei_doc.append(tei_header)
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Verify result is valid XML
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML")
        
        # Parse and verify structure
        parsed = etree.fromstring(result)
        
        # Should not be self-closing
        self.assertNotIn('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>', result)
        self.assertIn('</TEI>', result)
        
        # Verify header content
        title = parsed.find(".//{http://www.tei-c.org/ns/1.0}title")
        self.assertIsNotNone(title)
        self.assertEqual(title.text, "Header Only Document")
    
    def test_empty_elements_preservation(self):
        """Test that empty elements are preserved correctly."""
        tei_doc = etree.Element("{http://www.tei-c.org/ns/1.0}TEI", 
                               nsmap={None: "http://www.tei-c.org/ns/1.0"})
        
        # Add header with empty elements
        tei_header = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}teiHeader")
        file_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}fileDesc")
        title_stmt = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}titleStmt")
        title = etree.SubElement(title_stmt, "{http://www.tei-c.org/ns/1.0}title")
        title.text = "Test with Empty Elements"
        
        # Add empty elements
        empty_author = etree.SubElement(title_stmt, "{http://www.tei-c.org/ns/1.0}author")
        empty_note = etree.SubElement(empty_author, "{http://www.tei-c.org/ns/1.0}note")
        
        # Add text with empty paragraphs
        text_elem = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}text")
        body = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}body")
        
        # Mix of empty and non-empty elements
        p1 = etree.SubElement(body, "{http://www.tei-c.org/ns/1.0}p")
        p1.text = "Non-empty paragraph"
        
        p2 = etree.SubElement(body, "{http://www.tei-c.org/ns/1.0}p")  # Empty
        
        p3 = etree.SubElement(body, "{http://www.tei-c.org/ns/1.0}p")
        p3.text = "Another non-empty paragraph"
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Verify result is valid XML
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML")
        
        # Parse and verify all elements are preserved
        parsed = etree.fromstring(result)
        
        # Verify empty elements exist
        author = parsed.find(".//{http://www.tei-c.org/ns/1.0}author")
        self.assertIsNotNone(author, "Empty author element must be preserved")
        
        note = author.find(".//{http://www.tei-c.org/ns/1.0}note")
        self.assertIsNotNone(note, "Empty note element must be preserved")
        
        # Verify paragraphs
        paragraphs = parsed.findall(".//{http://www.tei-c.org/ns/1.0}p")
        self.assertEqual(len(paragraphs), 3, "All paragraphs must be preserved")
        self.assertEqual(paragraphs[0].text, "Non-empty paragraph")
        self.assertIsNone(paragraphs[1].text, "Empty paragraph should remain empty")
        self.assertEqual(paragraphs[2].text, "Another non-empty paragraph")
    
    def test_special_characters_preservation(self):
        """Test that special characters and entities are preserved."""
        tei_doc = create_tei_document("relaxng")
        
        # Add header
        tei_header = create_tei_header(
            doi="10.1000/special.chars",
            metadata={
                "title": "Special Characters: äöü ñ & < > \" '",
                "authors": [{"given": "José", "family": "Müller"}],
                "date": "2025"
            }
        )
        tei_doc.append(tei_header)
        
        # Add text with various special characters
        text_elem = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}text")
        body = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}body")
        
        # Test various special character scenarios
        test_cases = [
            "Unicode: äöüß ñáéíóú çÇ",
            "XML entities: &amp; &lt; &gt; &quot; &apos;",
            "Mixed: José says \"Hello & welcome\" to <everyone>",
            "Numbers & symbols: 123 + 456 = 579 (100%)",
            "Quotes: 'single' and \"double\" quotes"
        ]
        
        for i, test_text in enumerate(test_cases):
            p = etree.SubElement(body, "{http://www.tei-c.org/ns/1.0}p")
            p.text = test_text
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Verify result is valid XML
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML")
        
        # Parse and verify content
        parsed = etree.fromstring(result)
        
        # Verify title with special characters
        title = parsed.find(".//{http://www.tei-c.org/ns/1.0}title")
        self.assertEqual(title.text, "Special Characters: äöü ñ & < > \" '")
        
        # Verify all test paragraphs
        paragraphs = parsed.findall(".//{http://www.tei-c.org/ns/1.0}p")
        self.assertEqual(len(paragraphs), len(test_cases))
        
        for i, expected_text in enumerate(test_cases):
            self.assertEqual(paragraphs[i].text, expected_text, 
                           f"Special characters not preserved in paragraph {i+1}")
    
    def test_attributes_preservation(self):
        """Test that element attributes are preserved during serialization."""
        tei_doc = etree.Element("{http://www.tei-c.org/ns/1.0}TEI", 
                               nsmap={None: "http://www.tei-c.org/ns/1.0"})
        tei_doc.set("{http://www.w3.org/XML/1998/namespace}lang", "en")
        tei_doc.set("{http://www.w3.org/XML/1998/namespace}id", "test-doc")
        
        # Add header with attributes
        tei_header = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}teiHeader")
        file_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}fileDesc")
        title_stmt = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}titleStmt")
        title = etree.SubElement(title_stmt, "{http://www.tei-c.org/ns/1.0}title")
        title.set("level", "a")
        title.set("type", "main")
        title.text = "Attributes Test"
        
        # Add text with elements having various attributes
        text_elem = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}text")
        text_elem.set("{http://www.w3.org/XML/1998/namespace}lang", "de")
        
        body = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}body")
        div = etree.SubElement(body, "{http://www.tei-c.org/ns/1.0}div")
        div.set("type", "chapter")
        div.set("n", "1")
        div.set("{http://www.w3.org/XML/1998/namespace}id", "ch1")
        
        p = etree.SubElement(div, "{http://www.tei-c.org/ns/1.0}p")
        p.set("rend", "center")
        p.text = "Paragraph with attributes"
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Verify result is valid XML
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML")
        
        # Parse and verify attributes
        parsed = etree.fromstring(result)
        
        # Verify TEI attributes
        self.assertEqual(parsed.get("{http://www.w3.org/XML/1998/namespace}lang"), "en")
        self.assertEqual(parsed.get("{http://www.w3.org/XML/1998/namespace}id"), "test-doc")
        
        # Verify title attributes
        title_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}title")
        self.assertEqual(title_parsed.get("level"), "a")
        self.assertEqual(title_parsed.get("type"), "main")
        
        # Verify text attributes
        text_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}text")
        self.assertEqual(text_parsed.get("{http://www.w3.org/XML/1998/namespace}lang"), "de")
        
        # Verify div attributes
        div_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}div")
        self.assertEqual(div_parsed.get("type"), "chapter")
        self.assertEqual(div_parsed.get("n"), "1")
        self.assertEqual(div_parsed.get("{http://www.w3.org/XML/1998/namespace}id"), "ch1")
        
        # Verify paragraph attributes
        p_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}p")
        self.assertEqual(p_parsed.get("rend"), "center")
    
    def test_no_self_closing_tei_tag(self):
        """Test that TEI tag is never self-closing, even with minimal content."""
        # Test various minimal TEI documents
        test_cases = [
            # Minimal header only
            create_tei_document("relaxng"),
            
            # Header with minimal content
            lambda: self._create_minimal_tei_with_header(),
            
            # Empty text element
            lambda: self._create_tei_with_empty_text(),
        ]
        
        for i, tei_doc_or_func in enumerate(test_cases):
            with self.subTest(case=i):
                if callable(tei_doc_or_func):
                    tei_doc = tei_doc_or_func()
                else:
                    tei_doc = tei_doc_or_func
                
                result = serialize_tei_with_formatted_header(tei_doc)
                
                # Critical assertion: TEI tag should NEVER be self-closing
                self.assertNotIn('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>', result,
                                "TEI tag must not be self-closing")
                self.assertNotRegex(result, r'<TEI[^>]*/>',
                                   "TEI tag must not be self-closing (any attributes)")
                
                # Should have proper opening and closing tags
                self.assertRegex(result, r'<TEI[^>]*xmlns="http://www\.tei-c\.org/ns/1\.0"[^>]*>',
                                "Should have opening TEI tag with namespace")
                self.assertIn('</TEI>', result, "Should have closing TEI tag")
                
                # Verify it's valid XML
                self.assertTrue(self._is_valid_xml(result), f"Case {i} must produce valid XML")
    
    def test_lowercase_source_tei_tags(self):
        """Test handling of source documents with lowercase TEI tags."""
        # Create a document with lowercase root tag (simulating malformed input)
        tei_doc = etree.Element("tei", nsmap={None: "http://www.tei-c.org/ns/1.0"})
        tei_doc.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        
        # Add header with mixed case (some systems produce this)
        tei_header = etree.SubElement(tei_doc, "teiHeader")
        file_desc = etree.SubElement(tei_header, "fileDesc")
        title_stmt = etree.SubElement(file_desc, "titleStmt")
        title = etree.SubElement(title_stmt, "title")
        title.set("level", "a")
        title.text = "Document with Lowercase Root Tag"
        
        # Add encoding description
        encoding_desc = etree.SubElement(tei_header, "encodingDesc")
        app_info = etree.SubElement(encoding_desc, "appInfo")
        app = etree.SubElement(app_info, "application")
        app.set("ident", "test-system")
        app.set("version", "1.0")
        
        # Add text content
        text_elem = etree.SubElement(tei_doc, "text")
        text_elem.set("{http://www.w3.org/XML/1998/namespace}lang", "en")
        
        body = etree.SubElement(text_elem, "body")
        p1 = etree.SubElement(body, "p")
        p1.text = "First paragraph content that must be preserved exactly."
        
        p2 = etree.SubElement(body, "p")
        p2.text = "Second paragraph with important data."
        
        # Test the serialization
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Critical: Result must be valid XML
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML despite lowercase input")
        
        # Parse the result
        parsed = etree.fromstring(result)
        
        # The output should preserve the original case of the input
        self.assertEqual(parsed.tag, "{http://www.tei-c.org/ns/1.0}tei", 
                        "Output root tag should preserve the case of the input tag")
        
        # Verify header structure is preserved
        header = parsed.find(".//{http://www.tei-c.org/ns/1.0}teiHeader")
        self.assertIsNotNone(header, "teiHeader must be preserved")
        
        title_parsed = header.find(".//{http://www.tei-c.org/ns/1.0}title")
        self.assertIsNotNone(title_parsed, "Title must be preserved")
        self.assertEqual(title_parsed.text, "Document with Lowercase Root Tag")
        
        # Verify all content is preserved
        text_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}text")
        self.assertIsNotNone(text_parsed, "Text element must be preserved")
        
        paragraphs = text_parsed.findall(".//{http://www.tei-c.org/ns/1.0}p")
        self.assertEqual(len(paragraphs), 2, "All paragraphs must be preserved")
        self.assertEqual(paragraphs[0].text, "First paragraph content that must be preserved exactly.")
        self.assertEqual(paragraphs[1].text, "Second paragraph with important data.")
        
        # Check for corruption patterns - no mixed case or duplicate closing tags
        self.assertNotIn('</TEI>', result, "Should not have uppercase closing tag when input was lowercase")
        
        # Verify proper structure - should preserve original case and have matching tags
        self.assertIn('<tei xmlns="http://www.tei-c.org/ns/1.0"', result, "Should have proper opening tei tag")
        self.assertIn('</tei>', result, "Should have proper closing tei tag")
        
        # Critical: ensure no duplicate closing tags (this was the corruption bug)
        import re
        opening_tei_matches = re.findall(r'<tei\b[^>]*>', result, re.IGNORECASE)
        closing_tei_matches = re.findall(r'</tei>', result, re.IGNORECASE)
        
        self.assertEqual(len(opening_tei_matches), len(closing_tei_matches), 
                        f"Opening and closing tags must match. Found {len(opening_tei_matches)} opening, {len(closing_tei_matches)} closing")
        self.assertEqual(len(opening_tei_matches), 1, "Should have exactly one root element")
        
        # Ensure no extra content after closing tag
        lines = result.split('\n')
        last_line = lines[-1].strip()
        self.assertTrue(last_line.endswith('</tei>'), "Document should end with proper closing tag")
    
    def test_mixed_case_source_tags(self):
        """Test handling of source documents with mixed case TEI tags."""
        # Create document with various case inconsistencies 
        tei_doc = etree.Element("tei", nsmap={None: "http://www.tei-c.org/ns/1.0"})
        
        # Mix of lowercase and proper case tags
        tei_header = etree.SubElement(tei_doc, "teiheader")  # lowercase
        file_desc = etree.SubElement(tei_header, "fileDesc")  # proper case
        title_stmt = etree.SubElement(file_desc, "titlestmt")  # lowercase
        title = etree.SubElement(title_stmt, "title")
        title.text = "Mixed Case Test"
        
        # Add text with various case tags
        text_elem = etree.SubElement(tei_doc, "TEXT")  # uppercase
        body = etree.SubElement(text_elem, "Body")  # mixed case
        p = etree.SubElement(body, "P")  # uppercase
        p.text = "Content with mixed case source tags"
        
        # Test serialization
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Must be valid XML
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML despite mixed case input")
        
        # Parse and verify content is preserved
        parsed = etree.fromstring(result)
        
        # Content must be preserved regardless of source tag case
        title_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}title")
        self.assertIsNotNone(title_parsed)
        self.assertEqual(title_parsed.text, "Mixed Case Test")
        
        # The paragraph was created as uppercase "P", so we need to find it as "P"
        p_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}P")
        self.assertIsNotNone(p_parsed)
        self.assertEqual(p_parsed.text, "Content with mixed case source tags")
        
        # Verify no structural corruption - this test uses lowercase tei
        import re
        opening_root_matches = re.findall(r'<tei\b[^>]*>', result, re.IGNORECASE)
        closing_root_matches = re.findall(r'</tei>', result, re.IGNORECASE)
        self.assertEqual(len(opening_root_matches), 1, "Should have exactly one opening root tag")
        self.assertEqual(len(closing_root_matches), 1, "Should have exactly one closing root tag")

    def test_regression_corrupted_structure(self):
        """Regression test for the specific corruption pattern that was causing issues."""
        # Create a TEI document similar to the one that was getting corrupted
        tei_doc = etree.Element("{http://www.tei-c.org/ns/1.0}TEI", 
                               nsmap={None: "http://www.tei-c.org/ns/1.0"})
        
        # Add comprehensive header
        tei_header = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}teiHeader")
        file_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}fileDesc")
        title_stmt = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}titleStmt")
        
        title = etree.SubElement(title_stmt, "{http://www.tei-c.org/ns/1.0}title")
        title.set("level", "a")
        title.text = "Regression Test Document"
        
        # Add encoding description with application info (like GROBID output)
        encoding_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}encodingDesc")
        app_info = etree.SubElement(encoding_desc, "{http://www.tei-c.org/ns/1.0}appInfo")
        
        # PDF-TEI-Editor application
        app1 = etree.SubElement(app_info, "{http://www.tei-c.org/ns/1.0}application")
        app1.set("version", "1.0")
        app1.set("ident", "pdf-tei-editor")
        app1.set("type", "editor")
        
        # GROBID application with variant
        app2 = etree.SubElement(app_info, "{http://www.tei-c.org/ns/1.0}application")
        app2.set("version", "0.8.3-SNAPSHOT")
        app2.set("ident", "GROBID")
        app2.set("type", "extractor")
        app2.set("when", "2025-08-07T14:15:00.573667Z")
        
        variant_label = etree.SubElement(app2, "{http://www.tei-c.org/ns/1.0}label")
        variant_label.set("type", "variant-id")
        variant_label.text = "grobid.training.segmentation"
        
        # Add revision description
        revision_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}revisionDesc")
        change = etree.SubElement(revision_desc, "{http://www.tei-c.org/ns/1.0}change")
        change.set("when", "2025-07-27T16:42:42.613Z")
        change.set("status", "draft")
        change.set("who", "#cb")
        desc = etree.SubElement(change, "{http://www.tei-c.org/ns/1.0}desc")
        desc.text = "Corrections + mixed-reference annotation"
        
        # Add substantial text content (the part that was getting lost)
        text_elem = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}text")
        text_elem.set("{http://www.w3.org/XML/1998/namespace}lang", "de")
        
        # Add front matter
        front = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}front")
        front.text = "Front matter with special content"
        
        # Add body with multiple nested elements
        body = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}body")
        
        for section in range(3):
            div = etree.SubElement(body, "{http://www.tei-c.org/ns/1.0}div")
            div.set("type", "section")
            div.set("n", str(section + 1))
            
            for para in range(2):
                p = etree.SubElement(div, "{http://www.tei-c.org/ns/1.0}p")
                p.text = f"Section {section + 1}, Paragraph {para + 1}: This content must not be lost during serialization. It contains important research data that cannot be recreated if corrupted."
        
        # Add back matter with bibliography
        back = etree.SubElement(text_elem, "{http://www.tei-c.org/ns/1.0}back")
        listBibl = etree.SubElement(back, "{http://www.tei-c.org/ns/1.0}listBibl")
        
        for i in range(5):
            bibl = etree.SubElement(listBibl, "{http://www.tei-c.org/ns/1.0}bibl")
            bibl.text = f"Bibliography entry {i + 1}: Author, Title, Journal, Year."
        
        # Serialize
        result = serialize_tei_with_formatted_header(tei_doc)
        
        # Critical checks to prevent the regression
        self.assertTrue(self._is_valid_xml(result), "Result must be valid XML")
        
        # Parse the result
        parsed = etree.fromstring(result)
        
        # Verify no corruption patterns - tags should be properly cased
        self.assertNotIn('</tei>', result, "Must not contain lowercase closing tei tag")
        self.assertNotIn('<tei ', result, "Must not contain lowercase opening tei tag")
        
        # Verify structure integrity
        self.assertEqual(parsed.tag, "{http://www.tei-c.org/ns/1.0}TEI")
        
        # Verify header is present and formatted
        header = parsed.find(".//{http://www.tei-c.org/ns/1.0}teiHeader")
        self.assertIsNotNone(header, "Header must be preserved")
        
        # Verify ALL text content is preserved
        text_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}text")
        self.assertIsNotNone(text_parsed, "Text element must be preserved")
        
        # Verify front matter
        front_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}front")
        self.assertIsNotNone(front_parsed, "Front matter must be preserved")
        self.assertEqual(front_parsed.text, "Front matter with special content")
        
        # Verify body content - all sections and paragraphs
        body_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}body")
        self.assertIsNotNone(body_parsed, "Body must be preserved")
        
        divs = body_parsed.findall(".//{http://www.tei-c.org/ns/1.0}div")
        self.assertEqual(len(divs), 3, "All sections must be preserved")
        
        all_paragraphs = body_parsed.findall(".//{http://www.tei-c.org/ns/1.0}p")
        self.assertEqual(len(all_paragraphs), 6, "All paragraphs must be preserved")
        
        # Verify each paragraph content
        for i, p in enumerate(all_paragraphs):
            section_num = (i // 2) + 1
            para_num = (i % 2) + 1
            expected = f"Section {section_num}, Paragraph {para_num}: This content must not be lost during serialization. It contains important research data that cannot be recreated if corrupted."
            self.assertEqual(p.text, expected, f"Paragraph {i+1} content must be preserved exactly")
        
        # Verify bibliography
        back_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}back")
        self.assertIsNotNone(back_parsed, "Back matter must be preserved")
        
        bibls = back_parsed.findall(".//{http://www.tei-c.org/ns/1.0}bibl")
        self.assertEqual(len(bibls), 5, "All bibliography entries must be preserved")
        
        for i, bibl in enumerate(bibls):
            expected = f"Bibliography entry {i + 1}: Author, Title, Journal, Year."
            self.assertEqual(bibl.text, expected, f"Bibliography entry {i+1} must be preserved")
        
        # Verify variant metadata is preserved
        variant_parsed = parsed.find(".//{http://www.tei-c.org/ns/1.0}label[@type='variant-id']")
        self.assertIsNotNone(variant_parsed, "Variant ID must be preserved")
        self.assertEqual(variant_parsed.text, "grobid.training.segmentation")
    
    # Helper methods
    
    def _is_valid_xml(self, xml_string):
        """Check if a string is valid XML."""
        try:
            etree.fromstring(xml_string)
            return True
        except etree.XMLSyntaxError:
            return False
    
    def _create_minimal_tei_with_header(self):
        """Create a minimal TEI document with basic header."""
        tei_doc = create_tei_document("relaxng")
        tei_header = create_tei_header(doi="10.1000/minimal")
        tei_doc.append(tei_header)
        return tei_doc
    
    def _create_tei_with_empty_text(self):
        """Create a TEI document with empty text element."""
        tei_doc = self._create_minimal_tei_with_header()
        text_elem = etree.SubElement(tei_doc, "{http://www.tei-c.org/ns/1.0}text")
        return tei_doc


if __name__ == '__main__':
    unittest.main()
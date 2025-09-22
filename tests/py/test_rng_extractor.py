#!/usr/bin/env python3
"""
@testCovers server/extractors/rng_extractor.py

Unit tests for the RelaxNG Schema Extractor.

Tests namespace handling, schema generation, and XML structure analysis
with focus on proper handling of embedded namespaces like xml:id.
"""

import unittest
import sys
import os
from pathlib import Path

# Add server directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'server'))

from extractors.rng_extractor import RelaxNGExtractor, SchemaAnalyzer, RelaxNGGenerator


class TestRelaxNGExtractor(unittest.TestCase):
    """Test cases for RelaxNG extractor namespace handling."""

    def setUp(self):
        """Set up test environment."""
        self.extractor = RelaxNGExtractor()
        self.options = {
            'schema_strictness': 'balanced',
            'include_namespaces': True,
            'add_documentation': True
        }

    def test_xml_namespace_attribute_handling(self):
        """Test that xml:id and xml:lang attributes are properly preserved."""
        xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0" xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <author>
          <persName xml:id="author1">John Doe</persName>
        </author>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <text xml:lang="en">
    <body>
      <p xml:id="p1">Test paragraph</p>
    </body>
  </text>
</TEI>'''

        schema = self.extractor.extract(xml_content=xml_content, options=self.options)

        # Check that xml:id attributes are properly handled
        self.assertIn('name="id" ns="http://www.w3.org/XML/1998/namespace"', schema,
                      "xml:id attributes should be preserved with proper namespace")

        # Check that xml:lang attributes are properly handled
        self.assertIn('name="lang" ns="http://www.w3.org/XML/1998/namespace"', schema,
                      "xml:lang attributes should be preserved with proper namespace")

        # Check that xml namespace is declared
        self.assertIn('xmlns:xml="http://www.w3.org/XML/1998/namespace"', schema,
                      "xml namespace should be declared in grammar")

    def test_namespace_declaration_handling(self):
        """Test that namespace declarations are properly included in generated schema."""
        xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0" xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <text xml:lang="en">
    <body>
      <p xml:id="test">Content</p>
    </body>
  </text>
</TEI>'''

        schema = self.extractor.extract(xml_content=xml_content, options=self.options)

        # Check grammar opening tag includes namespaces
        self.assertIn('<grammar xmlns="http://relaxng.org/ns/structure/1.0"', schema)
        self.assertIn('xmlns:xml="http://www.w3.org/XML/1998/namespace"', schema)
        self.assertIn('ns="http://www.tei-c.org/ns/1.0"', schema)

    def test_schema_analyzer_namespace_preservation(self):
        """Test that SchemaAnalyzer preserves namespace prefixes in attributes."""
        from lxml import etree

        xml_content = '''<root xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <element xml:id="test" xml:lang="en" regular="value"/>
</root>'''

        root = etree.fromstring(xml_content.encode('utf-8'))
        analyzer = SchemaAnalyzer(self.options)
        structure = analyzer.analyze(root)

        # Check that xml:id and xml:lang are preserved
        element_attrs = structure['elements']['element']['attributes']
        self.assertIn('xml:id', element_attrs, "xml:id should be preserved with prefix")
        self.assertIn('xml:lang', element_attrs, "xml:lang should be preserved with prefix")
        self.assertIn('regular', element_attrs, "Regular attributes should be preserved")

    def test_relaxng_generator_xml_namespace_attributes(self):
        """Test that RelaxNGGenerator properly handles xml namespace attributes."""
        structure = {
            'root_element': 'test',
            'namespaces': {'xml': 'http://www.w3.org/XML/1998/namespace'},
            'elements': {
                'test': {
                    'children': {},
                    'text_content': True,
                    'attributes': {'xml:id', 'xml:lang', 'type'},
                    'occurrences': 1
                }
            },
            'attributes': {}
        }

        generator = RelaxNGGenerator(self.options)
        schema = generator.generate(structure)

        # Check that xml namespace attributes use proper namespace syntax
        self.assertIn('name="id" ns="http://www.w3.org/XML/1998/namespace"', schema)
        self.assertIn('name="lang" ns="http://www.w3.org/XML/1998/namespace"', schema)
        self.assertIn('name="type"', schema)

    def test_mixed_namespace_attributes(self):
        """Test handling of documents with multiple namespace prefixes."""
        xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<root xmlns:xml="http://www.w3.org/XML/1998/namespace"
      xmlns:custom="http://example.com/custom">
  <element xml:id="test" custom:attr="value" regular="normal"/>
</root>'''

        schema = self.extractor.extract(xml_content=xml_content, options=self.options)

        # Check xml namespace handling
        self.assertIn('name="id" ns="http://www.w3.org/XML/1998/namespace"', schema)

        # Check that custom namespace attributes are preserved (may not have namespace syntax)
        self.assertTrue(
            'custom:attr' in schema or 'name="attr"' in schema,
            "Custom namespace attributes should be preserved"
        )

        # Check regular attributes
        self.assertIn('name="regular"', schema)

    def test_no_xml_attributes_no_xml_namespace(self):
        """Test that xml namespace is not declared when no xml: attributes are present."""
        xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="http://example.com">
  <element attr="value">Content</element>
</root>'''

        schema = self.extractor.extract(xml_content=xml_content, options=self.options)

        # xml namespace should not be declared if no xml: attributes are used
        xml_declared_unnecessarily = (
            'xmlns:xml="http://www.w3.org/XML/1998/namespace"' in schema and
            'ns="http://www.w3.org/XML/1998/namespace"' not in schema
        )
        self.assertFalse(xml_declared_unnecessarily,
                         "xml namespace should not be declared when no xml: attributes are present")

    def test_tei_document_structure(self):
        """Test with a realistic TEI document structure."""
        xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Sample Document</title>
        <author>
          <persName xml:id="author1">Jane Smith</persName>
        </author>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <text xml:lang="en">
    <body>
      <div xml:id="div1">
        <head>Introduction</head>
        <p xml:id="p1">This is the first paragraph.</p>
        <note xml:id="note1" type="footnote">A footnote.</note>
      </div>
    </body>
  </text>
</TEI>'''

        schema = self.extractor.extract(xml_content=xml_content, options=self.options)

        # Verify basic structure
        self.assertIn('<start>', schema)
        self.assertIn('<ref name="TEI"/>', schema)

        # Verify xml namespace attributes are handled
        xml_id_count = schema.count('name="id" ns="http://www.w3.org/XML/1998/namespace"')
        xml_lang_count = schema.count('name="lang" ns="http://www.w3.org/XML/1998/namespace"')

        self.assertGreater(xml_id_count, 0, "Should find xml:id attributes")
        self.assertGreater(xml_lang_count, 0, "Should find xml:lang attributes")

        # Verify TEI namespace is set as default
        self.assertIn('ns="http://www.tei-c.org/ns/1.0"', schema)

    def test_error_handling_invalid_xml(self):
        """Test that invalid XML raises appropriate errors."""
        invalid_xml = '''<?xml version="1.0"?>
<root>
  <unclosed>
</root>'''

        with self.assertRaises(RuntimeError) as context:
            self.extractor.extract(xml_content=invalid_xml, options=self.options)

        self.assertIn("Invalid XML syntax", str(context.exception))

    def test_error_handling_no_xml_content(self):
        """Test that missing xml_content raises appropriate error."""
        with self.assertRaises(ValueError) as context:
            self.extractor.extract(xml_content=None, options=self.options)

        self.assertIn("xml_content is required", str(context.exception))

    def test_schema_strictness_options(self):
        """Test that different strictness levels affect attribute optionality."""
        xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<root xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <element xml:id="test" attr="value"/>
</root>'''

        # Test balanced mode (attributes should be optional)
        balanced_options = dict(self.options)
        balanced_options['schema_strictness'] = 'balanced'
        balanced_schema = self.extractor.extract(xml_content=xml_content, options=balanced_options)
        self.assertIn('<optional>', balanced_schema, "Balanced mode should make attributes optional")

        # Test strict mode (attributes should be required)
        strict_options = dict(self.options)
        strict_options['schema_strictness'] = 'strict'
        strict_schema = self.extractor.extract(xml_content=xml_content, options=strict_options)

        # In strict mode, there should be fewer <optional> wrappers
        balanced_optional_count = balanced_schema.count('<optional>')
        strict_optional_count = strict_schema.count('<optional>')
        self.assertLessEqual(strict_optional_count, balanced_optional_count,
                             "Strict mode should have fewer optional attributes")

    def test_content_model_accuracy(self):
        """Test that content models are generated accurately based on actual XML content."""
        xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="http://www.tei-c.org/ns/1.0">
  <date when="2025-01-01">2025-01-01</date>
  <idno type="DOI">10.1000/example</idno>
  <page>84 <lb/></page>
  <empty-elem/>
  <container>
    <child1>content</child1>
    <child2>more content</child2>
  </container>
</root>'''

        schema = self.extractor.extract(xml_content=xml_content, options=self.options)

        # Elements with only text content should use <text/>
        self.assertIn('<define name="date">', schema)
        self.assertIn('<text/>', schema)  # date element should have text content

        self.assertIn('<define name="idno">', schema)
        # idno should also have text content, not be empty

        # Elements with mixed content should use interleave
        self.assertIn('<define name="page">', schema)
        page_def_start = schema.find('<define name="page">')
        page_def_end = schema.find('</define>', page_def_start)
        page_definition = schema[page_def_start:page_def_end]
        self.assertIn('<interleave>', page_definition, "Page should have mixed content model")
        self.assertIn('<text/>', page_definition, "Page should allow text content")

        # Empty elements should use <empty/>
        self.assertIn('<define name="empty-elem">', schema)
        empty_def_start = schema.find('<define name="empty-elem">')
        empty_def_end = schema.find('</define>', empty_def_start)
        empty_definition = schema[empty_def_start:empty_def_end]
        self.assertIn('<empty/>', empty_definition, "Empty element should use empty content model")

        # Elements with only child elements should use choice patterns
        self.assertIn('<define name="container">', schema)
        container_def_start = schema.find('<define name="container">')
        container_def_end = schema.find('</define>', container_def_start)
        container_definition = schema[container_def_start:container_def_end]
        self.assertIn('<choice>', container_definition, "Container should use choice pattern for multiple children")


if __name__ == '__main__':
    unittest.main()
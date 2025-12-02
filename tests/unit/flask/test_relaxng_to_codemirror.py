#!/usr/bin/env python3
"""
@testCovers server/lib/relaxng_to_codemirror.py

Unit tests for the RelaxNG to CodeMirror Autocomplete Converter.

Tests proper parsing of RelaxNG schemas and generation of CodeMirror autocomplete data,
with focus on handling different RelaxNG patterns like interleave, choice, and references.
"""

import unittest
import sys
import os
import tempfile
import json
from pathlib import Path

# Add server directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'server'))

from lib.relaxng_to_codemirror import RelaxNGParser, generate_autocomplete_map


class TestRelaxNGToCodeMirror(unittest.TestCase):
    """Test cases for RelaxNG to CodeMirror converter."""

    def setUp(self):
        """Set up test environment."""
        self.parser = RelaxNGParser()

    def create_temp_rng_file(self, content):
        """Create a temporary RNG file with the given content."""
        fd, path = tempfile.mkstemp(suffix='.rng')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(content)
            return path
        except:
            os.close(fd)
            raise

    def test_basic_element_children_detection(self):
        """Test that basic element children are detected correctly."""
        rng_content = '''<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0">
  <start>
    <ref name="root"/>
  </start>
  <define name="root">
    <element name="root">
      <zeroOrMore>
        <choice>
          <ref name="child1"/>
          <ref name="child2"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>
  <define name="child1">
    <element name="child1">
      <text/>
    </element>
  </define>
  <define name="child2">
    <element name="child2">
      <text/>
    </element>
  </define>
</grammar>'''

        temp_file = self.create_temp_rng_file(rng_content)
        try:
            result = self.parser.parse_file(temp_file)

            # Check that root element has the correct children
            self.assertIn('root', result)
            self.assertEqual(sorted(result['root']['children']), ['child1', 'child2'])

            # Check that child elements have no children (text only)
            self.assertIn('child1', result)
            self.assertNotIn('children', result['child1'])

            self.assertIn('child2', result)
            self.assertNotIn('children', result['child2'])

        finally:
            os.unlink(temp_file)

    def test_interleave_children_detection(self):
        """Test that children in interleave elements are detected correctly."""
        rng_content = '''<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
  xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <start>
    <ref name="persName"/>
  </start>
  <define name="persName">
    <element name="persName">
      <optional>
        <attribute name="id" ns="http://www.w3.org/XML/1998/namespace"/>
      </optional>
      <interleave>
        <text/>
        <zeroOrMore>
          <ref name="forename"/>
        </zeroOrMore>
        <zeroOrMore>
          <ref name="surname"/>
        </zeroOrMore>
      </interleave>
    </element>
  </define>
  <define name="forename">
    <element name="forename">
      <text/>
    </element>
  </define>
  <define name="surname">
    <element name="surname">
      <text/>
    </element>
  </define>
</grammar>'''

        temp_file = self.create_temp_rng_file(rng_content)
        try:
            result = self.parser.parse_file(temp_file)

            # Check that persName element has children from interleave
            self.assertIn('persName', result)
            self.assertIn('children', result['persName'])
            self.assertEqual(sorted(result['persName']['children']), ['forename', 'surname'])

            # Check that xml:id attribute is properly handled
            self.assertIn('attrs', result['persName'])
            self.assertIn('id', result['persName']['attrs'])

        finally:
            os.unlink(temp_file)

    def test_nested_interleave_and_choice(self):
        """Test complex nested structures with both interleave and choice."""
        rng_content = '''<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
  xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <start>
    <ref name="text"/>
  </start>
  <define name="text">
    <element name="text">
      <optional>
        <attribute name="lang" ns="http://www.w3.org/XML/1998/namespace"/>
      </optional>
      <interleave>
        <text/>
        <zeroOrMore>
          <ref name="body"/>
        </zeroOrMore>
        <zeroOrMore>
          <ref name="front"/>
        </zeroOrMore>
        <zeroOrMore>
          <ref name="note"/>
        </zeroOrMore>
      </interleave>
    </element>
  </define>
  <define name="body">
    <element name="body">
      <zeroOrMore>
        <choice>
          <ref name="p"/>
          <ref name="div"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>
  <define name="front">
    <element name="front">
      <text/>
    </element>
  </define>
  <define name="note">
    <element name="note">
      <optional>
        <attribute name="type"/>
      </optional>
      <text/>
    </element>
  </define>
  <define name="p">
    <element name="p">
      <text/>
    </element>
  </define>
  <define name="div">
    <element name="div">
      <text/>
    </element>
  </define>
</grammar>'''

        temp_file = self.create_temp_rng_file(rng_content)
        try:
            result = self.parser.parse_file(temp_file)

            # Check text element children from interleave
            self.assertIn('text', result)
            self.assertEqual(sorted(result['text']['children']), ['body', 'front', 'note'])

            # Check body element children from choice
            self.assertIn('body', result)
            self.assertEqual(sorted(result['body']['children']), ['div', 'p'])

            # Check attributes
            self.assertIn('lang', result['text']['attrs'])
            self.assertIn('type', result['note']['attrs'])

        finally:
            os.unlink(temp_file)

    def test_attributes_in_interleave(self):
        """Test that attributes within interleave elements are detected."""
        rng_content = '''<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0">
  <start>
    <ref name="change"/>
  </start>
  <define name="change">
    <element name="change">
      <interleave>
        <optional>
          <attribute name="status"/>
        </optional>
        <optional>
          <attribute name="when"/>
        </optional>
        <text/>
        <zeroOrMore>
          <ref name="desc"/>
        </zeroOrMore>
      </interleave>
    </element>
  </define>
  <define name="desc">
    <element name="desc">
      <text/>
    </element>
  </define>
</grammar>'''

        temp_file = self.create_temp_rng_file(rng_content)
        try:
            result = self.parser.parse_file(temp_file)

            # Check change element has both attributes and children
            self.assertIn('change', result)
            self.assertIn('children', result['change'])
            self.assertEqual(result['change']['children'], ['desc'])

            self.assertIn('attrs', result['change'])
            self.assertIn('status', result['change']['attrs'])
            self.assertIn('when', result['change']['attrs'])

        finally:
            os.unlink(temp_file)

    def test_real_tei_schema_sample(self):
        """Test with a realistic TEI schema fragment to ensure practical functionality."""
        rng_content = '''<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
  xmlns:xml="http://www.w3.org/XML/1998/namespace"
  ns="http://www.tei-c.org/ns/1.0">
  <start>
    <ref name="TEI"/>
  </start>
  <define name="TEI">
    <element name="TEI">
      <zeroOrMore>
        <choice>
          <ref name="teiHeader"/>
          <ref name="text"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>
  <define name="teiHeader">
    <element name="teiHeader">
      <zeroOrMore>
        <choice>
          <ref name="fileDesc"/>
          <ref name="encodingDesc"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>
  <define name="fileDesc">
    <element name="fileDesc">
      <zeroOrMore>
        <ref name="titleStmt"/>
      </zeroOrMore>
    </element>
  </define>
  <define name="titleStmt">
    <element name="titleStmt">
      <zeroOrMore>
        <choice>
          <ref name="title"/>
          <ref name="author"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>
  <define name="title">
    <element name="title">
      <optional>
        <attribute name="level"/>
      </optional>
      <text/>
    </element>
  </define>
  <define name="author">
    <element name="author">
      <zeroOrMore>
        <ref name="persName"/>
      </zeroOrMore>
    </element>
  </define>
  <define name="persName">
    <element name="persName">
      <optional>
        <attribute name="id" ns="http://www.w3.org/XML/1998/namespace"/>
      </optional>
      <interleave>
        <text/>
        <zeroOrMore>
          <ref name="forename"/>
        </zeroOrMore>
        <zeroOrMore>
          <ref name="surname"/>
        </zeroOrMore>
      </interleave>
    </element>
  </define>
  <define name="forename">
    <element name="forename">
      <text/>
    </element>
  </define>
  <define name="surname">
    <element name="surname">
      <text/>
    </element>
  </define>
  <define name="encodingDesc">
    <element name="encodingDesc">
      <zeroOrMore>
        <ref name="appInfo"/>
      </zeroOrMore>
    </element>
  </define>
  <define name="appInfo">
    <element name="appInfo">
      <text/>
    </element>
  </define>
  <define name="text">
    <element name="text">
      <optional>
        <attribute name="lang" ns="http://www.w3.org/XML/1998/namespace"/>
      </optional>
      <interleave>
        <text/>
        <zeroOrMore>
          <ref name="body"/>
        </zeroOrMore>
        <zeroOrMore>
          <ref name="front"/>
        </zeroOrMore>
      </interleave>
    </element>
  </define>
  <define name="body">
    <element name="body">
      <text/>
    </element>
  </define>
  <define name="front">
    <element name="front">
      <text/>
    </element>
  </define>
</grammar>'''

        temp_file = self.create_temp_rng_file(rng_content)
        try:
            result = self.parser.parse_file(temp_file)

            # Test hierarchical structure
            self.assertEqual(sorted(result['TEI']['children']), ['teiHeader', 'text'])
            self.assertEqual(sorted(result['teiHeader']['children']), ['encodingDesc', 'fileDesc'])
            self.assertEqual(result['fileDesc']['children'], ['titleStmt'])
            self.assertEqual(sorted(result['titleStmt']['children']), ['author', 'title'])
            self.assertEqual(result['author']['children'], ['persName'])

            # Test the critical interleave case
            self.assertEqual(sorted(result['persName']['children']), ['forename', 'surname'])
            self.assertEqual(sorted(result['text']['children']), ['body', 'front'])

            # Test attributes
            self.assertIn('level', result['title']['attrs'])
            self.assertIn('id', result['persName']['attrs'])
            self.assertIn('lang', result['text']['attrs'])

            # Verify that global attributes are added
            self.assertIn('xml:id', result['TEI']['attrs'])
            self.assertIn('xml:lang', result['TEI']['attrs'])

        finally:
            os.unlink(temp_file)

    def test_generate_autocomplete_map_function(self):
        """Test the standalone generate_autocomplete_map function."""
        rng_content = '''<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0">
  <start>
    <ref name="root"/>
  </start>
  <define name="root">
    <element name="root">
      <interleave>
        <text/>
        <zeroOrMore>
          <ref name="child"/>
        </zeroOrMore>
      </interleave>
    </element>
  </define>
  <define name="child">
    <element name="child">
      <optional>
        <attribute name="type"/>
      </optional>
      <text/>
    </element>
  </define>
</grammar>'''

        temp_file = self.create_temp_rng_file(rng_content)
        try:
            # Test with default options
            result = generate_autocomplete_map(temp_file)
            self.assertIn('root', result)
            self.assertEqual(result['root']['children'], ['child'])

            # Test with custom options
            result_no_global = generate_autocomplete_map(temp_file, include_global_attrs=False)
            self.assertIn('root', result_no_global)
            # Should not have global attributes
            if 'attrs' in result_no_global['root']:
                self.assertNotIn('xml:id', result_no_global['root']['attrs'])

            # Test with deduplication
            result_dedup = generate_autocomplete_map(temp_file, deduplicate=True)
            self.assertIn('root', result_dedup)
            # May contain references starting with '#'

        finally:
            os.unlink(temp_file)

    def test_empty_and_text_only_elements(self):
        """Test handling of empty elements and text-only elements."""
        rng_content = '''<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0">
  <start>
    <ref name="root"/>
  </start>
  <define name="root">
    <element name="root">
      <zeroOrMore>
        <choice>
          <ref name="empty-elem"/>
          <ref name="text-elem"/>
        </choice>
      </zeroOrMore>
    </element>
  </define>
  <define name="empty-elem">
    <element name="empty-elem">
      <empty/>
    </element>
  </define>
  <define name="text-elem">
    <element name="text-elem">
      <text/>
    </element>
  </define>
</grammar>'''

        temp_file = self.create_temp_rng_file(rng_content)
        try:
            result = self.parser.parse_file(temp_file)

            # Root should have both children
            self.assertEqual(sorted(result['root']['children']), ['empty-elem', 'text-elem'])

            # Empty and text elements should not have children listed
            self.assertNotIn('children', result['empty-elem'])
            self.assertNotIn('children', result['text-elem'])

        finally:
            os.unlink(temp_file)

    def test_cyclic_references(self):
        """Test handling of cyclic references between elements."""
        rng_content = '''<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0">
  <start>
    <ref name="note"/>
  </start>
  <define name="note">
    <element name="note">
      <interleave>
        <text/>
        <zeroOrMore>
          <ref name="note"/>
        </zeroOrMore>
      </interleave>
    </element>
  </define>
</grammar>'''

        temp_file = self.create_temp_rng_file(rng_content)
        try:
            # This should not cause infinite recursion
            result = self.parser.parse_file(temp_file)

            # Note should reference itself as a child
            self.assertIn('note', result)
            self.assertEqual(result['note']['children'], ['note'])

        finally:
            os.unlink(temp_file)

    def test_invalid_file_handling(self):
        """Test error handling for invalid files."""
        # Test non-existent file
        with self.assertRaises(FileNotFoundError):
            self.parser.parse_file('/non/existent/file.rng')

        # Test invalid XML
        invalid_rng = '''<?xml version="1.0"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0">
  <unclosed>
</grammar>'''

        temp_file = self.create_temp_rng_file(invalid_rng)
        try:
            with self.assertRaises(ValueError):
                self.parser.parse_file(temp_file)
        finally:
            os.unlink(temp_file)


if __name__ == '__main__':
    unittest.main()
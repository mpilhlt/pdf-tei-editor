"""
Unit tests for IAA diff utility functions.

Tests the preprocessing and serialization logic used for semantic diffs.
"""

import pytest
from lxml import etree
from fastapi_app.plugins.iaa_analyzer.diff_utils import (
    preprocess_for_diff,
    serialize_with_linebreaks,
    escape_html,
)


class TestPreprocessForDiff:
    """Test XML preprocessing for diff operations."""

    def test_removes_ignored_tags(self):
        """Should remove elements with ignored tag names."""
        xml = '<text><pb n="1"/><p>Content</p></text>'
        root = etree.fromstring(xml)

        result = preprocess_for_diff(
            root,
            ignore_tags=frozenset(['pb']),
            ignore_attrs=frozenset(),
            inject_line_markers=False
        )

        result_str = etree.tostring(result, encoding='unicode')
        assert '<pb' not in result_str
        assert '<p>Content</p>' in result_str

    def test_removes_ignored_attributes(self):
        """Should remove specified attributes from elements."""
        xml = '<text><p xml:id="p1" type="paragraph">Content</p></text>'
        root = etree.fromstring(xml)

        result = preprocess_for_diff(
            root,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(['xml:id']),
            inject_line_markers=False
        )

        result_str = etree.tostring(result, encoding='unicode')
        assert 'xml:id' not in result_str
        assert 'type="paragraph"' in result_str

    def test_normalizes_whitespace(self):
        """Should collapse whitespace in text content."""
        xml = '<text><p>Hello    \n\n  world</p></text>'
        root = etree.fromstring(xml)

        result = preprocess_for_diff(
            root,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(),
            inject_line_markers=False
        )

        p_elem = result.find('.//p')
        assert p_elem.text == 'Hello world'

    def test_injects_line_markers(self):
        """Should add data-line attributes when requested."""
        xml = '<text><p>Content</p></text>'
        root = etree.fromstring(xml, etree.XMLParser(remove_blank_text=True))

        # lxml assigns sourceline automatically when parsing
        result = preprocess_for_diff(
            root,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(),
            inject_line_markers=True
        )

        # Check that data-line was added
        assert result.get('data-line') is not None
        p_elem = result.find('.//p')
        assert p_elem.get('data-line') is not None

    def test_combined_preprocessing(self):
        """Should handle multiple preprocessing operations together."""
        xml = '''<text>
            <pb n="1"/>
            <p xml:id="p1">First   paragraph</p>
            <note place="footnote">Note   content</note>
        </text>'''
        root = etree.fromstring(xml)

        result = preprocess_for_diff(
            root,
            ignore_tags=frozenset(['pb']),
            ignore_attrs=frozenset(['xml:id', 'place']),
            inject_line_markers=True
        )

        result_str = etree.tostring(result, encoding='unicode')

        # Check tag removal
        assert '<pb' not in result_str

        # Check attribute removal
        assert 'xml:id' not in result_str
        assert 'place=' not in result_str

        # Check whitespace normalization
        p_elem = result.find('.//p')
        assert p_elem.text == 'First paragraph'

        note_elem = result.find('.//note')
        assert note_elem.text == 'Note content'


class TestSerializeWithLinebreaks:
    """Test XML serialization with line breaks."""

    def test_adds_linebreaks_after_closing_tags(self):
        """Should add newline after each closing tag."""
        xml = '<text><p>Content</p><p>More</p></text>'
        root = etree.fromstring(xml)

        result = serialize_with_linebreaks(root)

        # Should have linebreaks after each closing tag
        assert '</p>\n' in result
        assert '</text>\n' in result

    def test_preserves_element_order(self):
        """Should not reorder elements during serialization."""
        xml = '<text><note>A</note><p>First</p><note>B</note><p>Second</p></text>'
        root = etree.fromstring(xml)

        result = serialize_with_linebreaks(root)

        # Check order is preserved by finding content markers
        note_a_pos = result.find('<note>A</note>')
        p1_pos = result.find('<p>First</p>')
        note_b_pos = result.find('<note>B</note>')
        p2_pos = result.find('<p>Second</p>')

        assert note_a_pos < p1_pos < note_b_pos < p2_pos

    def test_handles_nested_elements(self):
        """Should correctly handle nested element structures."""
        xml = '<text><div><p><hi>bold</hi> text</p></div></text>'
        root = etree.fromstring(xml)

        result = serialize_with_linebreaks(root)

        # Each closing tag should have a newline
        assert '</hi>\n' in result
        assert '</p>\n' in result
        assert '</div>\n' in result


class TestSemanticDiffScenarios:
    """Test realistic semantic diff scenarios."""

    def test_identical_content_different_line_numbers(self):
        """
        Should produce identical serialization for same content at different lines.
        This tests the core issue: data-line attributes shouldn't affect diff results.
        """
        xml1 = '<text><p>Hello world</p></text>'
        xml2 = '<text><p>Hello world</p></text>'

        root1 = etree.fromstring(xml1, etree.XMLParser(remove_blank_text=True))
        root2 = etree.fromstring(xml2, etree.XMLParser(remove_blank_text=True))

        # Manually set different source lines
        root1.sourceline = 10
        root1.find('.//p').sourceline = 11
        root2.sourceline = 20
        root2.find('.//p').sourceline = 21

        # Preprocess with line markers
        processed1 = preprocess_for_diff(
            root1,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(),
            inject_line_markers=True
        )
        processed2 = preprocess_for_diff(
            root2,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(),
            inject_line_markers=True
        )

        # Serialize
        serialized1 = serialize_with_linebreaks(processed1)
        serialized2 = serialize_with_linebreaks(processed2)

        # The serialized strings will be different due to data-line attributes
        # This is the problem we need to fix
        assert 'data-line="11"' in serialized1
        assert 'data-line="21"' in serialized2

        # After stripping data-line, they should be identical
        import re
        stripped1 = re.sub(r'\s*data-line="\d+"', '', serialized1)
        stripped2 = re.sub(r'\s*data-line="\d+"', '', serialized2)

        assert stripped1 == stripped2

    def test_semantic_diff_ignores_attributes(self):
        """Should not show differences for ignored attributes."""
        xml1 = '<text><p xml:id="p1">Content</p></text>'
        xml2 = '<text><p xml:id="p2">Content</p></text>'

        root1 = etree.fromstring(xml1)
        root2 = etree.fromstring(xml2)

        # Preprocess to remove xml:id
        processed1 = preprocess_for_diff(
            root1,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(['xml:id']),
            inject_line_markers=False
        )
        processed2 = preprocess_for_diff(
            root2,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(['xml:id']),
            inject_line_markers=False
        )

        # Serialize
        serialized1 = serialize_with_linebreaks(processed1)
        serialized2 = serialize_with_linebreaks(processed2)

        # Should be identical after removing xml:id
        assert serialized1 == serialized2

    def test_semantic_diff_detects_real_differences(self):
        """Should detect actual content differences."""
        xml1 = '<text><p xml:id="p1">Hello</p></text>'
        xml2 = '<text><p xml:id="p2">Goodbye</p></text>'

        root1 = etree.fromstring(xml1)
        root2 = etree.fromstring(xml2)

        # Preprocess to remove xml:id
        processed1 = preprocess_for_diff(
            root1,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(['xml:id']),
            inject_line_markers=False
        )
        processed2 = preprocess_for_diff(
            root2,
            ignore_tags=frozenset(),
            ignore_attrs=frozenset(['xml:id']),
            inject_line_markers=False
        )

        # Serialize
        serialized1 = serialize_with_linebreaks(processed1)
        serialized2 = serialize_with_linebreaks(processed2)

        # Should be different due to text content
        assert serialized1 != serialized2
        assert 'Hello' in serialized1
        assert 'Goodbye' in serialized2


class TestEscapeHtml:
    """Test HTML escaping utility."""

    def test_escapes_special_characters(self):
        """Should escape HTML special characters."""
        assert escape_html('<tag>') == '&lt;tag&gt;'
        assert escape_html('a & b') == 'a &amp; b'
        assert escape_html('"quoted"') == '&quot;quoted&quot;'
        assert escape_html("'single'") == '&#x27;single&#x27;'

    def test_handles_empty_string(self):
        """Should handle empty/None input."""
        assert escape_html('') == ''
        assert escape_html(None) == ''

    def test_handles_combined_characters(self):
        """Should handle multiple special characters together."""
        assert escape_html('<a href="test">Link & Text</a>') == \
               '&lt;a href=&quot;test&quot;&gt;Link &amp; Text&lt;/a&gt;'

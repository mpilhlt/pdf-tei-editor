"""
Unit tests for Inter-Annotator Agreement Analyzer plugin.

@testCovers fastapi_app/plugins/iaa_analyzer/plugin.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.plugins.iaa_analyzer.plugin import IAAAnalyzerPlugin


class TestIAAAnalyzerPlugin(unittest.TestCase):
    """Test cases for IAAAnalyzerPlugin."""

    def setUp(self):
        """Set up test fixtures."""
        self.plugin = IAAAnalyzerPlugin()

    def test_plugin_metadata(self):
        """Test plugin metadata structure."""
        metadata = self.plugin.metadata

        self.assertEqual(metadata["id"], "iaa-analyzer")
        self.assertEqual(metadata["name"], "Inter-Annotator Agreement")
        self.assertEqual(metadata["category"], "analyzer")
        self.assertEqual(metadata["version"], "1.0.0")
        self.assertIn("user", metadata["required_roles"])
        self.assertEqual(len(metadata["endpoints"]), 1)
        self.assertEqual(metadata["endpoints"][0]["name"], "compute_agreement")
        self.assertEqual(
            metadata["endpoints"][0]["state_params"], ["pdf", "variant"]
        )

    def test_normalize_text_basic(self):
        """Test text normalization with basic input."""
        # Normal text
        self.assertEqual(self.plugin._normalize_text("hello world"), "hello world")

        # Text with extra whitespace
        self.assertEqual(
            self.plugin._normalize_text("  hello   world  "), "hello world"
        )

        # Text with newlines and tabs
        self.assertEqual(
            self.plugin._normalize_text("hello\n\t  world"), "hello world"
        )

    def test_normalize_text_edge_cases(self):
        """Test text normalization edge cases."""
        # None input
        self.assertIsNone(self.plugin._normalize_text(None))

        # Empty string
        self.assertIsNone(self.plugin._normalize_text(""))

        # Whitespace only
        self.assertIsNone(self.plugin._normalize_text("   \n\t  "))

        # Single word
        self.assertEqual(self.plugin._normalize_text("hello"), "hello")

    def test_extract_element_sequence_simple(self):
        """Test element extraction from simple TEI document."""
        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <text>
        <body>
            <p>Hello world</p>
        </body>
    </text>
</TEI>"""

        sequence = self.plugin._extract_element_sequence(xml_content)

        # Should have body and p elements
        self.assertEqual(len(sequence), 2)
        self.assertEqual(sequence[0]["tag"], "body")
        self.assertEqual(sequence[1]["tag"], "p")
        self.assertEqual(sequence[1]["text"], "Hello world")

    def test_extract_element_sequence_nested(self):
        """Test element extraction with nested elements and tail text."""
        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <text>
        <body>
            <note place="headnote"><page>1</page>Text of headnote<lb /></note>
        </body>
    </text>
</TEI>"""

        sequence = self.plugin._extract_element_sequence(xml_content)

        # Should have: body, note, page, lb
        self.assertEqual(len(sequence), 4)

        # Check body
        self.assertEqual(sequence[0]["tag"], "body")

        # Check note with attribute
        self.assertEqual(sequence[1]["tag"], "note")
        self.assertEqual(sequence[1]["attrs"].get("place"), "headnote")

        # Check page with text and tail
        self.assertEqual(sequence[2]["tag"], "page")
        self.assertEqual(sequence[2]["text"], "1")
        self.assertEqual(sequence[2]["tail"], "Text of headnote")

        # Check lb
        self.assertEqual(sequence[3]["tag"], "lb")
        self.assertIsNone(sequence[3]["text"])

    def test_extract_element_sequence_attributes(self):
        """Test extraction of relevant attributes."""
        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <text>
        <body>
            <persName type="person" who="John">John Doe</persName>
            <date when="2024-01-15">January 15</date>
        </body>
    </text>
</TEI>"""

        sequence = self.plugin._extract_element_sequence(xml_content)

        # Find persName element
        persName_elem = next(e for e in sequence if e["tag"] == "persName")
        self.assertEqual(persName_elem["attrs"].get("type"), "person")
        self.assertEqual(persName_elem["attrs"].get("who"), "John")

        # Find date element
        date_elem = next(e for e in sequence if e["tag"] == "date")
        self.assertEqual(date_elem["attrs"].get("when"), "2024-01-15")

    def test_extract_element_sequence_whitespace_normalization(self):
        """Test that whitespace in text and tail is normalized."""
        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <text>
        <body>
            <p>  Multiple   spaces  </p>
        </body>
    </text>
</TEI>"""

        sequence = self.plugin._extract_element_sequence(xml_content)

        p_elem = next(e for e in sequence if e["tag"] == "p")
        self.assertEqual(p_elem["text"], "Multiple spaces")

    def test_extract_element_sequence_empty_text(self):
        """Test extraction when <text> element is missing."""
        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc><titleStmt><title>Test</title></titleStmt></fileDesc>
    </teiHeader>
</TEI>"""

        with self.assertLogs("fastapi_app.plugins.iaa_analyzer.plugin", level="WARNING"):
            sequence = self.plugin._extract_element_sequence(xml_content)

        self.assertEqual(len(sequence), 0)

    def test_count_matches_identical_sequences(self):
        """Test counting matches with identical sequences."""
        seq1 = [
            {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
            {"tag": "note", "text": "World", "tail": None, "attrs": {"place": "margin"}},
        ]
        seq2 = [
            {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
            {"tag": "note", "text": "World", "tail": None, "attrs": {"place": "margin"}},
        ]

        matches = self.plugin._count_matches(seq1, seq2)
        self.assertEqual(matches, 2)

    def test_count_matches_different_text(self):
        """Test counting matches with different text content."""
        seq1 = [
            {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
            {"tag": "p", "text": "World", "tail": None, "attrs": {}},
        ]
        seq2 = [
            {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
            {"tag": "p", "text": "Earth", "tail": None, "attrs": {}},
        ]

        matches = self.plugin._count_matches(seq1, seq2)
        self.assertEqual(matches, 1)

    def test_count_matches_different_tags(self):
        """Test counting matches with different tag names."""
        seq1 = [
            {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
        ]
        seq2 = [
            {"tag": "div", "text": "Hello", "tail": None, "attrs": {}},
        ]

        matches = self.plugin._count_matches(seq1, seq2)
        self.assertEqual(matches, 0)

    def test_count_matches_different_tail(self):
        """Test counting matches with different tail text."""
        seq1 = [
            {"tag": "p", "text": "Hello", "tail": "after", "attrs": {}},
        ]
        seq2 = [
            {"tag": "p", "text": "Hello", "tail": "different", "attrs": {}},
        ]

        matches = self.plugin._count_matches(seq1, seq2)
        self.assertEqual(matches, 0)

    def test_count_matches_different_attributes(self):
        """Test counting matches with different attributes."""
        seq1 = [
            {"tag": "note", "text": "Hello", "tail": None, "attrs": {"place": "margin"}},
        ]
        seq2 = [
            {"tag": "note", "text": "Hello", "tail": None, "attrs": {"place": "footnote"}},
        ]

        matches = self.plugin._count_matches(seq1, seq2)
        self.assertEqual(matches, 0)

    def test_count_matches_different_lengths(self):
        """Test counting matches with different sequence lengths."""
        seq1 = [
            {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
            {"tag": "p", "text": "World", "tail": None, "attrs": {}},
            {"tag": "p", "text": "Extra", "tail": None, "attrs": {}},
        ]
        seq2 = [
            {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
            {"tag": "p", "text": "World", "tail": None, "attrs": {}},
        ]

        matches = self.plugin._count_matches(seq1, seq2)
        self.assertEqual(matches, 2)

    def test_compute_pairwise_agreements(self):
        """Test pairwise agreement computation."""
        versions = [
            {
                "file_id": "file1",
                "metadata": {"title": "Version 1", "annotator": "Alice", "stable_id": "v1"},
                "elements": [
                    {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
                    {"tag": "p", "text": "World", "tail": None, "attrs": {}},
                ],
            },
            {
                "file_id": "file2",
                "metadata": {"title": "Version 2", "annotator": "Bob", "stable_id": "v2"},
                "elements": [
                    {"tag": "p", "text": "Hello", "tail": None, "attrs": {}},
                    {"tag": "p", "text": "Earth", "tail": None, "attrs": {}},
                ],
            },
        ]

        comparisons = self.plugin._compute_pairwise_agreements(versions)

        self.assertEqual(len(comparisons), 1)
        comp = comparisons[0]

        self.assertEqual(comp["version1"]["title"], "Version 1")
        self.assertEqual(comp["version2"]["title"], "Version 2")
        self.assertEqual(comp["matches"], 1)
        self.assertEqual(comp["total"], 2)
        self.assertEqual(comp["v1_count"], 2)
        self.assertEqual(comp["v2_count"], 2)
        self.assertEqual(comp["agreement"], 50.0)

    def test_compute_pairwise_agreements_multiple_versions(self):
        """Test pairwise agreements with 3 versions."""
        versions = [
            {
                "file_id": "file1",
                "metadata": {"title": "V1", "annotator": "A1", "stable_id": "v1"},
                "elements": [{"tag": "p", "text": "A", "tail": None, "attrs": {}}],
            },
            {
                "file_id": "file2",
                "metadata": {"title": "V2", "annotator": "A2", "stable_id": "v2"},
                "elements": [{"tag": "p", "text": "A", "tail": None, "attrs": {}}],
            },
            {
                "file_id": "file3",
                "metadata": {"title": "V3", "annotator": "A3", "stable_id": "v3"},
                "elements": [{"tag": "p", "text": "B", "tail": None, "attrs": {}}],
            },
        ]

        comparisons = self.plugin._compute_pairwise_agreements(versions)

        # Should have 3 comparisons: (V1,V2), (V1,V3), (V2,V3)
        self.assertEqual(len(comparisons), 3)

        # V1 vs V2 should have 100% agreement
        comp_v1_v2 = next(
            c
            for c in comparisons
            if c["version1"]["title"] == "V1" and c["version2"]["title"] == "V2"
        )
        self.assertEqual(comp_v1_v2["agreement"], 100.0)

        # V1 vs V3 should have 0% agreement (different text)
        comp_v1_v3 = next(
            c
            for c in comparisons
            if c["version1"]["title"] == "V1" and c["version2"]["title"] == "V3"
        )
        self.assertEqual(comp_v1_v3["agreement"], 0.0)

    def test_generate_html_table(self):
        """Test HTML table generation."""
        comparisons = [
            {
                "version1": {"title": "Version 1", "annotator": "Alice", "stable_id": "v1"},
                "version2": {"title": "Version 2", "annotator": "Bob", "stable_id": "v2"},
                "matches": 5,
                "total": 10,
                "v1_count": 10,
                "v2_count": 10,
                "agreement": 50.0,
            }
        ]

        html = self.plugin._generate_html_table(comparisons, "test-session-id")

        # Check that HTML contains expected content
        self.assertIn("<table", html)
        self.assertIn("Version 1", html)
        self.assertIn("Version 2", html)
        self.assertIn("Alice", html)
        self.assertIn("Bob", html)
        self.assertIn("5/10", html)
        self.assertIn("50.0%", html)

    def test_generate_html_table_color_coding(self):
        """Test HTML table color coding based on agreement percentage."""
        comparisons = [
            {
                "version1": {"title": "High", "annotator": "A1", "stable_id": "h"},
                "version2": {"title": "High2", "annotator": "A2", "stable_id": "h2"},
                "matches": 9,
                "total": 10,
                "v1_count": 10,
                "v2_count": 10,
                "agreement": 90.0,  # Should be green (#d4edda)
            },
            {
                "version1": {"title": "Med", "annotator": "A1", "stable_id": "m"},
                "version2": {"title": "Med2", "annotator": "A2", "stable_id": "m2"},
                "matches": 7,
                "total": 10,
                "v1_count": 10,
                "v2_count": 10,
                "agreement": 70.0,  # Should be yellow (#fff3cd)
            },
            {
                "version1": {"title": "Low", "annotator": "A1", "stable_id": "l"},
                "version2": {"title": "Low2", "annotator": "A2", "stable_id": "l2"},
                "matches": 3,
                "total": 10,
                "v1_count": 10,
                "v2_count": 10,
                "agreement": 30.0,  # Should be red (#f8d7da)
            },
        ]

        html = self.plugin._generate_html_table(comparisons, "test-session-id")

        # Check color coding
        self.assertIn("#d4edda", html)  # Green
        self.assertIn("#fff3cd", html)  # Yellow
        self.assertIn("#f8d7da", html)  # Red

    def test_generate_html_table_empty(self):
        """Test HTML table generation with empty comparisons."""
        html = self.plugin._generate_html_table([], "test-session-id")
        self.assertIn("No comparisons", html)

    def test_escape_html(self):
        """Test HTML escaping."""
        self.assertEqual(
            self.plugin._escape_html("<script>alert('xss')</script>"),
            "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;",
        )
        self.assertEqual(self.plugin._escape_html("A & B"), "A &amp; B")
        self.assertEqual(self.plugin._escape_html('Say "hello"'), "Say &quot;hello&quot;")
        self.assertEqual(self.plugin._escape_html(""), "")
        self.assertEqual(self.plugin._escape_html(None), "")


if __name__ == "__main__":
    unittest.main()

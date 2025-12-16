"""
Unit tests for the Annotation Versions Analyzer plugin.

Tests XML parsing, HTML table generation, and error handling.

@testCovers fastapi_app/plugins/annotation_versions_analyzer/plugin.py
@testCovers fastapi_app/plugins/annotation_versions_analyzer/routes.py
"""

import unittest
from unittest.mock import MagicMock, patch
from datetime import datetime

from fastapi_app.plugins.annotation_versions_analyzer.plugin import (
    AnnotationVersionsAnalyzerPlugin,
)
from fastapi_app.lib.plugin_base import PluginContext


class TestAnnotationVersionsAnalyzerPlugin(unittest.IsolatedAsyncioTestCase):
    """Test AnnotationVersionsAnalyzerPlugin functionality."""

    def setUp(self):
        """Set up test fixtures."""
        self.plugin = AnnotationVersionsAnalyzerPlugin()

    def test_plugin_metadata(self):
        """Test plugin metadata structure."""
        metadata = self.plugin.metadata
        self.assertEqual(metadata["id"], "annotation-versions-analyzer")
        self.assertEqual(metadata["name"], "Annotation Versions Analyzer")
        self.assertEqual(metadata["category"], "analyzer")
        self.assertEqual(metadata["required_roles"], ["user"])
        self.assertIn("endpoints", metadata)
        self.assertEqual(len(metadata["endpoints"]), 1)
        self.assertEqual(metadata["endpoints"][0]["name"], "analyze")

    def test_get_endpoints(self):
        """Test that plugin defines analyze endpoint."""
        endpoints = self.plugin.get_endpoints()
        self.assertIn("analyze", endpoints)
        self.assertTrue(callable(endpoints["analyze"]))

    async def test_analyze_no_pdf_id(self):
        """Test analyze endpoint with no PDF ID."""
        context = MagicMock(spec=PluginContext)
        params = {}

        result = await self.plugin.analyze(context, params)

        self.assertIn("error", result)
        self.assertIn("html", result)
        self.assertEqual(result["error"], "No PDF document selected")

    def test_parse_tei_version_info(self):
        """Test parsing TEI XML to extract version information."""
        # Sample TEI XML with all required fields
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Main Title</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Test Document v1</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-01-15" who="annotator1">
                <desc>Initial annotation</desc>
            </change>
            <change when="2024-01-20T10:30:00" who="annotator2">
                <desc>Final review</desc>
            </change>
        </revisionDesc>
    </teiHeader>
    <text>
        <body>
            <p>Content</p>
        </body>
    </text>
</TEI>"""

        # Mock file metadata
        file_metadata = MagicMock()
        file_metadata.stable_id = "test-stable-id"
        file_metadata.variant = "standard"
        file_metadata.is_gold_standard = False

        result = self.plugin._parse_tei_version_info(tei_xml, file_metadata)

        self.assertIsNotNone(result)
        self.assertEqual(result["title"], "Test Document v1")
        self.assertFalse(result["is_gold"])
        self.assertEqual(result["variant"], "standard")
        self.assertEqual(result["last_change_desc"], "Final review")
        self.assertEqual(result["last_annotator"], "annotator2")
        self.assertIn("2024", result["last_change_date"])
        self.assertEqual(result["last_change_date_raw"], "2024-01-20T10:30:00")
        self.assertEqual(result["stable_id"], "test-stable-id")

    def test_parse_tei_version_info_gold_standard(self):
        """Test parsing TEI with gold standard flag."""
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Gold Standard Document</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Gold Standard Document</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-03-01" who="gold-annotator">
                <desc>Gold annotation complete</desc>
            </change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        # Mock file metadata with is_gold_standard flag
        file_metadata = MagicMock()
        file_metadata.stable_id = "gold-stable-id"
        file_metadata.variant = "grobid"  # Gold files can have any variant
        file_metadata.is_gold_standard = True

        result = self.plugin._parse_tei_version_info(tei_xml, file_metadata)

        self.assertIsNotNone(result)
        self.assertEqual(result["title"], "Gold Standard Document")
        self.assertTrue(result["is_gold"])
        self.assertEqual(result["variant"], "grobid")
        self.assertEqual(result["last_annotator"], "gold-annotator")

    def test_parse_tei_version_info_no_revision(self):
        """Test parsing TEI without revision information."""
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Document Without Revisions</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Document Without Revisions</title>
                </edition>
            </editionStmt>
        </fileDesc>
    </teiHeader>
</TEI>"""

        file_metadata = MagicMock()
        file_metadata.stable_id = "no-revision-id"
        file_metadata.variant = "standard"
        file_metadata.is_gold_standard = False

        result = self.plugin._parse_tei_version_info(tei_xml, file_metadata)

        self.assertIsNotNone(result)
        self.assertEqual(result["title"], "Document Without Revisions")
        self.assertEqual(result["variant"], "standard")
        self.assertEqual(result["last_change_desc"], "")
        self.assertEqual(result["last_annotator"], "")
        self.assertEqual(result["last_change_date"], "")

    def test_parse_tei_version_info_invalid_xml(self):
        """Test parsing invalid XML."""
        invalid_xml = "This is not XML"

        file_metadata = MagicMock()
        file_metadata.stable_id = "invalid-id"

        with self.assertLogs(level="ERROR"):
            result = self.plugin._parse_tei_version_info(invalid_xml, file_metadata)

        self.assertIsNone(result)

    def test_format_date(self):
        """Test date formatting."""
        # Test date only format
        date_only = "2024-01-15"
        formatted = self.plugin._format_date(date_only)
        self.assertIn("January", formatted)
        self.assertIn("15", formatted)
        self.assertIn("2024", formatted)

        # Test datetime format
        datetime_str = "2024-01-15T10:30:00"
        formatted = self.plugin._format_date(datetime_str)
        self.assertIn("January", formatted)
        self.assertIn("15", formatted)
        self.assertIn("2024", formatted)
        self.assertIn("10:30", formatted)

        # Test invalid date (should return original)
        invalid_date = "not-a-date"
        with self.assertLogs(level="WARNING"):
            formatted = self.plugin._format_date(invalid_date)
        self.assertEqual(formatted, invalid_date)

    def test_generate_html_table_empty(self):
        """Test HTML table generation with no versions."""
        html = self.plugin._generate_html_table([])
        self.assertIn("No annotation versions found", html)

    def test_generate_html_table_single_version(self):
        """Test HTML table generation with single version."""
        versions = [
            {
                "title": "Test Document",
                "is_gold": True,
                "variant": "grobid",
                "last_change_desc": "Final review",
                "last_annotator": "annotator1",
                "last_change_date": "January 15, 2024",
                "last_change_date_raw": "2024-01-15",
                "stable_id": "stable-1",
            }
        ]

        html = self.plugin._generate_html_table(versions, show_variant_column=False)

        # Check table structure
        self.assertIn("<table", html)
        self.assertIn("</table>", html)
        self.assertIn("<thead>", html)
        self.assertIn("<tbody>", html)

        # Check headers (without variant column)
        self.assertIn("Title", html)
        self.assertIn("Gold", html)
        self.assertIn("Last Change", html)
        self.assertIn("Annotator", html)
        self.assertIn("Date", html)
        self.assertNotIn("Variant", html)

        # Check content
        self.assertIn("Test Document", html)
        self.assertIn("✓", html)  # Gold checkmark
        self.assertIn("Final review", html)
        self.assertIn("annotator1", html)
        self.assertIn("January 15, 2024", html)

    def test_generate_html_table_multiple_versions(self):
        """Test HTML table generation with multiple versions."""
        versions = [
            {
                "title": "Document A",
                "is_gold": True,
                "variant": "grobid.training.segmentation",  # Gold files can have any variant
                "last_change_desc": "Gold standard",
                "last_annotator": "gold-annotator",
                "last_change_date": "March 1, 2024",
                "last_change_date_raw": "2024-03-01",
                "stable_id": "stable-1",
            },
            {
                "title": "Document B",
                "is_gold": False,
                "variant": "grobid.training.segmentation",
                "last_change_desc": "Initial annotation",
                "last_annotator": "annotator1",
                "last_change_date": "January 15, 2024",
                "last_change_date_raw": "2024-01-15",
                "stable_id": "stable-2",
            },
        ]

        # Test with variant column
        html = self.plugin._generate_html_table(versions, show_variant_column=True)

        # Check both documents are in the table
        self.assertIn("Document A", html)
        self.assertIn("Document B", html)
        self.assertIn("gold-annotator", html)
        self.assertIn("annotator1", html)
        self.assertIn("Variant", html)
        self.assertIn("grobid.training.segmentation", html)

        # Check that gold checkmark appears once (for Document A)
        # and gold checkmark cell is empty for Document B
        gold_count = html.count("✓")
        self.assertEqual(gold_count, 1)

    def test_sort_versions(self):
        """Test sorting versions: gold first, then by date (newest first)."""
        versions = [
            {
                "title": "Document A",
                "is_gold": False,
                "last_change_date_raw": "2024-01-15",
            },
            {
                "title": "Document B",
                "is_gold": True,
                "last_change_date_raw": "2024-02-01",
            },
            {
                "title": "Document C",
                "is_gold": False,
                "last_change_date_raw": "2024-03-01",
            },
            {
                "title": "Document D",
                "is_gold": True,
                "last_change_date_raw": "2024-01-01",
            },
        ]

        self.plugin._sort_versions(versions)

        # Check order: gold files first (B, D), then non-gold by date (C, A)
        # Within gold: newest first (B before D)
        # Within non-gold: newest first (C before A)
        self.assertEqual(versions[0]["title"], "Document B")  # Gold, newest
        self.assertEqual(versions[1]["title"], "Document D")  # Gold, older
        self.assertEqual(versions[2]["title"], "Document C")  # Non-gold, newest
        self.assertEqual(versions[3]["title"], "Document A")  # Non-gold, older

    def test_escape_html(self):
        """Test HTML escaping for security."""
        # Test various HTML special characters
        test_cases = [
            ("simple text", "simple text"),
            ("<script>alert('xss')</script>", "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;"),
            ("Text & More", "Text &amp; More"),
            ('"quoted"', "&quot;quoted&quot;"),
            ("", ""),
        ]

        for input_text, expected in test_cases:
            escaped = self.plugin._escape_html(input_text)
            self.assertEqual(escaped, expected)

    async def test_analyze_with_mocked_files(self):
        """Test analyze endpoint with mocked file repository."""
        context = MagicMock(spec=PluginContext)
        params = {"pdf": "test-pdf-id"}

        # Create sample TEI XML
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Test Document</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Test Document</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-01-15" who="annotator1">
                <desc>Initial annotation</desc>
            </change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        # Mock TEI file metadata
        mock_tei_file = MagicMock()
        mock_tei_file.id = "test-tei-id"
        mock_tei_file.file_type = "tei"
        mock_tei_file.variant = "standard"
        mock_tei_file.is_gold_standard = False

        # Mock dependencies (patch where they are used, not where they are defined)
        with patch("fastapi_app.lib.dependencies.get_db"), \
             patch("fastapi_app.lib.dependencies.get_file_storage") as mock_storage, \
             patch("fastapi_app.lib.file_repository.FileRepository") as mock_repo_class:

            # Setup mock repository
            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = "test-doc-id"
            mock_repo.get_files_by_doc_id.return_value = [mock_tei_file]
            mock_repo_class.return_value = mock_repo

            # Setup mock file storage
            mock_storage_instance = MagicMock()
            mock_storage_instance.read_file.return_value = tei_xml.encode("utf-8")
            mock_storage.return_value = mock_storage_instance

            # Execute analyze
            result = await self.plugin.analyze(context, params)

            # Verify result
            self.assertIn("html", result)
            self.assertNotIn("error", result)
            self.assertIn("pdf", result)
            self.assertIn("variant", result)

            html = result["html"]
            self.assertIn("Test Document", html)
            self.assertIn("annotator1", html)
            self.assertIn("Initial annotation", html)

    async def test_analyze_no_tei_files(self):
        """Test analyze endpoint when no TEI files exist."""
        context = MagicMock(spec=PluginContext)
        params = {"pdf": "test-pdf-id"}

        # Mock dependencies (patch where they are used, not where they are defined)
        with patch("fastapi_app.lib.dependencies.get_db"), \
             patch("fastapi_app.lib.dependencies.get_file_storage"), \
             patch("fastapi_app.lib.file_repository.FileRepository") as mock_repo_class:

            # Setup mock repository with no TEI files
            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = "test-doc-id"
            mock_repo.get_files_by_doc_id.return_value = []
            mock_repo_class.return_value = mock_repo

            # Execute analyze
            result = await self.plugin.analyze(context, params)

            # Verify result
            self.assertIn("html", result)
            html = result["html"]
            self.assertIn("No annotation versions found", html)


if __name__ == "__main__":
    unittest.main()

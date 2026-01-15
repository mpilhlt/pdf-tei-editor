"""
Unit tests for Annotation Progress plugin.

@testCovers fastapi_app/plugins/annotation_progress/plugin.py
@testCovers fastapi_app/plugins/annotation_progress/routes.py
"""

import asyncio
import unittest
from unittest.mock import MagicMock

from fastapi_app.plugins.annotation_progress.plugin import AnnotationProgressPlugin
from fastapi_app.plugins.annotation_progress.routes import (
    _extract_annotation_info,
    _format_version_chains_html,
)


class TestAnnotationProgressPlugin(unittest.TestCase):
    """Test cases for AnnotationProgressPlugin."""

    def setUp(self):
        """Set up test fixtures."""
        self.plugin = AnnotationProgressPlugin()

    def test_metadata(self):
        """Test plugin metadata structure."""
        metadata = self.plugin.metadata

        self.assertEqual(metadata["id"], "annotation-progress")
        self.assertEqual(metadata["name"], "Annotation Progress")
        self.assertEqual(metadata["category"], "collection")
        self.assertEqual(metadata["required_roles"], ["user"])
        self.assertEqual(len(metadata["endpoints"]), 1)

        endpoint = metadata["endpoints"][0]
        self.assertEqual(endpoint["name"], "show_progress")
        self.assertEqual(endpoint["label"], "Show Annotation Progress")
        self.assertIn("collection", endpoint["state_params"])
        self.assertIn("variant", endpoint["state_params"])

    def test_get_endpoints(self):
        """Test endpoint registration."""
        endpoints = self.plugin.get_endpoints()

        self.assertIn("show_progress", endpoints)
        self.assertTrue(callable(endpoints["show_progress"]))

    def test_show_progress_no_collection(self):
        """Test show_progress with no collection parameter."""
        context = MagicMock()
        params = {}

        result = asyncio.run(self.plugin.show_progress(context, params))

        self.assertIn("error", result)
        self.assertIn("html", result)
        self.assertIn("Please select a collection first", result["html"])

    def test_show_progress_with_collection(self):
        """Test show_progress with collection parameter."""
        context = MagicMock()
        params = {"collection": "test-collection", "variant": "test-variant"}

        result = asyncio.run(self.plugin.show_progress(context, params))

        self.assertIn("outputUrl", result)
        self.assertIn("test-collection", result["outputUrl"])
        self.assertIn("test-variant", result["outputUrl"])
        self.assertEqual(result["collection"], "test-collection")
        self.assertEqual(result["variant"], "test-variant")

    def test_extract_annotation_info(self):
        """Test annotation info extraction from TEI XML."""
        from datetime import datetime

        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title level="a">Test Document</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <title>Test Annotation</title>
        </edition>
      </editionStmt>
      <publicationStmt>
        <publisher>Test</publisher>
      </publicationStmt>
      <sourceDesc>
        <bibl>Test</bibl>
      </sourceDesc>
    </fileDesc>
    <revisionDesc>
      <change when="2024-01-01T10:00:00Z" status="created">First version</change>
      <change when="2024-01-02T10:00:00Z" status="updated">Second version</change>
      <change when="2024-01-03T10:00:00Z" status="reviewed">Third version</change>
    </revisionDesc>
  </teiHeader>
  <text>
    <body>
      <p>Test content</p>
    </body>
  </text>
</TEI>"""

        file_metadata = MagicMock()
        file_metadata.stable_id = "test-stable-id"

        result = _extract_annotation_info(xml_content, file_metadata)

        self.assertIsNotNone(result)
        self.assertEqual(result["annotation_label"], "Test Annotation")
        self.assertEqual(result["revision_count"], 3)
        self.assertEqual(result["stable_id"], "test-stable-id")
        self.assertEqual(result["last_change_status"], "reviewed")
        self.assertIsNotNone(result["last_change_timestamp"])
        # Verify timestamp is parsed correctly (timezone stripped)
        expected_timestamp = datetime(2024, 1, 3, 10, 0, 0)
        self.assertEqual(result["last_change_timestamp"], expected_timestamp)
        # Verify change signatures are extracted
        self.assertIn("change_signatures", result)
        self.assertEqual(len(result["change_signatures"]), 3)

    def test_extract_annotation_info_no_edition_title(self):
        """Test annotation info extraction with no edition title."""
        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title level="a">Test Document Title</title>
      </titleStmt>
      <publicationStmt>
        <publisher>Test</publisher>
      </publicationStmt>
      <sourceDesc>
        <bibl>Test</bibl>
      </sourceDesc>
    </fileDesc>
    <revisionDesc>
      <change when="2024-01-01T10:00:00" status="created">First version</change>
    </revisionDesc>
  </teiHeader>
  <text>
    <body>
      <p>Test content</p>
    </body>
  </text>
</TEI>"""

        file_metadata = MagicMock()
        file_metadata.stable_id = "test-stable-id"

        result = _extract_annotation_info(xml_content, file_metadata)

        self.assertIsNotNone(result)
        self.assertEqual(result["annotation_label"], "Test Document Title")
        self.assertEqual(result["revision_count"], 1)


class TestFormatVersionChainsHtml(unittest.TestCase):
    """Test cases for version chain HTML formatting."""

    def test_format_version_chains_html(self):
        """Test HTML formatting of version chains."""
        from datetime import datetime

        annotations = [
            {
                "annotation_label": "Version A",
                "stable_id": "id-a",
                "change_signatures": [("user1", "2024-01-01", "created")],
                "last_change_timestamp": datetime(2024, 1, 1, 10, 0, 0),
            },
            {
                "annotation_label": "Version B",
                "stable_id": "id-b",
                "change_signatures": [
                    ("user1", "2024-01-01", "created"),
                    ("user1", "2024-01-02", "updated"),
                ],
                "last_change_timestamp": datetime(2024, 1, 2, 10, 0, 0),
            },
        ]

        html = _format_version_chains_html(annotations)

        # Should contain version links and arrow
        self.assertIn("Version A", html)
        self.assertIn("Version B", html)
        self.assertIn("→", html)
        self.assertIn("id-a", html)
        self.assertIn("id-b", html)
        self.assertIn("version-chain", html)
        # Version B has the newest timestamp, so it should have a star
        self.assertIn("⭐", html)
        self.assertIn("⭐ Version B", html)
        # Version A should not have a star
        self.assertNotIn("⭐ Version A", html)

    def test_format_version_chains_html_empty(self):
        """Test HTML formatting with no annotations."""
        html = _format_version_chains_html([])
        self.assertEqual(html, "No annotations")


if __name__ == "__main__":
    unittest.main()

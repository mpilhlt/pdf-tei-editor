"""
Unit tests for RNG Converter Plugin.
"""

import unittest
import asyncio
from unittest.mock import Mock
from fastapi_app.plugins.rng_converter.plugin import RngConverterPlugin
from fastapi_app.lib.plugin_base import PluginContext


class TestRngConverterPlugin(unittest.TestCase):
    """Test RNG converter plugin functionality."""

    def setUp(self):
        """Set up test fixtures."""
        self.plugin = RngConverterPlugin()
        self.mock_context = Mock(spec=PluginContext)

    def test_metadata(self):
        """Test plugin metadata."""
        metadata = self.plugin.metadata
        self.assertEqual(metadata["id"], "rng-converter")
        self.assertEqual(metadata["category"], "converter")
        self.assertIn("convert_to_rng", [ep["name"] for ep in metadata["endpoints"]])

    def test_convert_to_rng_no_file(self):
        """Test convert_to_rng with no file ID."""
        result = asyncio.run(self.plugin.convert_to_rng(self.mock_context, {}))
        self.assertIn("error", result)
        self.assertIn("html", result)

    def test_convert_to_rng_with_file(self):
        """Test convert_to_rng with valid file ID."""
        params = {
            "xml": "test-file-id",
            "variant": "test-variant",
            "_session_id": "test-session"
        }
        result = asyncio.run(self.plugin.convert_to_rng(self.mock_context, params))

        self.assertIn("html", result)
        self.assertIn("exportUrl", result)
        self.assertIn("/api/plugins/rng-converter/download", result["exportUrl"])
        self.assertEqual(result["xml"], "test-file-id")
        self.assertEqual(result["variant"], "test-variant")


if __name__ == "__main__":
    unittest.main()

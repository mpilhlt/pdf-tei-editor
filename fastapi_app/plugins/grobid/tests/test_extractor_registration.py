"""
Tests for extractor registration of the GROBID plugin.

Verifies that the plugin registers its extractor with the ExtractorRegistry
during initialization and unregisters it on cleanup.
"""

import unittest
import asyncio
from unittest.mock import patch

from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.plugins.plugin_base import PluginContext

from fastapi_app.plugins.grobid.plugin import GrobidPlugin
from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor


class TestGrobidPluginRegistration(unittest.TestCase):
    """Test Grobid plugin extractor registration."""

    def setUp(self):
        """Reset registry before each test."""
        ExtractorRegistry.reset_instance()

    def tearDown(self):
        """Clean up after each test."""
        ExtractorRegistry.reset_instance()

    def test_grobid_plugin_registers_extractor(self):
        """Test that GrobidPlugin registers GrobidTrainingExtractor."""
        plugin = GrobidPlugin()
        context = PluginContext()

        # Run initialization
        asyncio.run(plugin.initialize(context))

        # Verify extractor is registered
        registry = ExtractorRegistry.get_instance()
        extractors = registry.list_extractors(available_only=False)

        extractor_ids = [e['id'] for e in extractors]
        self.assertIn('grobid', extractor_ids)

    def test_grobid_plugin_unregisters_extractor(self):
        """Test that GrobidPlugin unregisters extractor on cleanup."""
        plugin = GrobidPlugin()
        context = PluginContext()

        # Run initialization and cleanup
        asyncio.run(plugin.initialize(context))
        asyncio.run(plugin.cleanup())

        # Verify extractor is unregistered
        registry = ExtractorRegistry.get_instance()
        extractors = registry.list_extractors(available_only=False)

        extractor_ids = [e['id'] for e in extractors]
        self.assertNotIn('grobid', extractor_ids)


if __name__ == '__main__':
    unittest.main()

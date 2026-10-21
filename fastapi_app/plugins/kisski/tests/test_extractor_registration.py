"""
Tests for extractor registration of the KISSKI plugin.

Verifies that the plugin registers its extractor with the ExtractorRegistry
during initialization and unregisters it on cleanup.
"""

import unittest
import asyncio
from unittest.mock import patch

from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.plugins.plugin_base import PluginContext

from fastapi_app.plugins.kisski.plugin import KisskiPlugin
from fastapi_app.plugins.kisski.extractor import KisskiExtractor


class TestKisskiPluginRegistration(unittest.TestCase):
    """Test KISSKI plugin extractor registration."""

    def setUp(self):
        """Reset registry before each test."""
        ExtractorRegistry.reset_instance()

    def tearDown(self):
        """Clean up after each test."""
        ExtractorRegistry.reset_instance()

    def test_kisski_plugin_registers_extractor(self):
        """Test that KisskiPlugin registers KisskiExtractor."""
        plugin = KisskiPlugin()
        context = PluginContext()

        # Run initialization
        asyncio.run(plugin.initialize(context))

        # Verify extractor is registered
        registry = ExtractorRegistry.get_instance()
        extractors = registry.list_extractors(available_only=False)

        extractor_ids = [e['id'] for e in extractors]
        self.assertIn('kisski-neural-chat', extractor_ids)

    def test_kisski_plugin_unregisters_extractor(self):
        """Test that KisskiPlugin unregisters extractor on cleanup."""
        plugin = KisskiPlugin()
        context = PluginContext()

        # Run initialization and cleanup
        asyncio.run(plugin.initialize(context))
        asyncio.run(plugin.cleanup())

        # Verify extractor is unregistered
        registry = ExtractorRegistry.get_instance()
        extractors = registry.list_extractors(available_only=False)

        extractor_ids = [e['id'] for e in extractors]
        self.assertNotIn('kisski-neural-chat', extractor_ids)


if __name__ == '__main__':
    unittest.main()

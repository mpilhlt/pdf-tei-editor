"""
Tests for extractor registration through a plugin.

Verifies with the test-plugin fixture that a plugin registers its extractor
with the ExtractorRegistry during initialization. Extractor plugins test their
own registration in their tests/ directories.
"""

import unittest
import asyncio
from unittest.mock import patch

from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.plugins.plugin_base import PluginContext

from tests.fixtures.plugins.test_plugin.plugin import TestPlugin
from tests.fixtures.plugins.test_plugin.extractor import MockExtractor


class TestMockExtractorRegistration(unittest.TestCase):
    """Test MockExtractor registration via TestPlugin."""

    def setUp(self):
        """Reset registry before each test."""
        ExtractorRegistry.reset_instance()

    def tearDown(self):
        """Clean up after each test."""
        ExtractorRegistry.reset_instance()

    @patch.dict('os.environ', {'FASTAPI_APPLICATION_MODE': 'testing'})
    def test_mock_extractor_registered_in_testing_mode(self):
        """Test that MockExtractor is registered when in testing mode."""
        plugin = TestPlugin()
        context = PluginContext()

        # Run initialization
        asyncio.run(plugin.initialize(context))

        # Verify extractor is registered
        registry = ExtractorRegistry.get_instance()
        extractors = registry.list_extractors(available_only=False)

        extractor_ids = [e['id'] for e in extractors]
        self.assertIn('mock-extractor', extractor_ids)

    @patch.dict('os.environ', {'FASTAPI_APPLICATION_MODE': 'production'})
    def test_mock_extractor_not_registered_in_production_mode(self):
        """Test that MockExtractor is NOT registered in production mode."""
        plugin = TestPlugin()
        context = PluginContext()

        # Run initialization
        asyncio.run(plugin.initialize(context))

        # Verify extractor is NOT registered
        registry = ExtractorRegistry.get_instance()
        extractors = registry.list_extractors(available_only=False)

        extractor_ids = [e['id'] for e in extractors]
        self.assertNotIn('mock-extractor', extractor_ids)


if __name__ == '__main__':
    unittest.main()

"""
Tests for extractor plugin registration.

Verifies that extractor plugins correctly register their extractors
with the ExtractorRegistry during initialization.
"""

import unittest
import asyncio
from unittest.mock import patch

from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.plugin_base import PluginContext

# Import plugins
from fastapi_app.plugins.grobid.plugin import GrobidPlugin
from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor
from fastapi_app.plugins.llamore.plugin import LLamorePlugin
from fastapi_app.plugins.llamore.extractor import LLamoreExtractor
from fastapi_app.plugins.kisski.plugin import KisskiPlugin
from fastapi_app.plugins.kisski.extractor import KisskiExtractor
from fastapi_app.plugins.sample_analyzer.plugin import SampleAnalyzerPlugin
from fastapi_app.plugins.sample_analyzer.extractor import MockExtractor


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
        self.assertIn('grobid-training', extractor_ids)

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
        self.assertNotIn('grobid-training', extractor_ids)


class TestLLamorePluginRegistration(unittest.TestCase):
    """Test LLamore plugin extractor registration."""

    def setUp(self):
        """Reset registry before each test."""
        ExtractorRegistry.reset_instance()

    def tearDown(self):
        """Clean up after each test."""
        ExtractorRegistry.reset_instance()

    def test_llamore_plugin_registers_extractor(self):
        """Test that LLamorePlugin registers LLamoreExtractor."""
        plugin = LLamorePlugin()
        context = PluginContext()

        # Run initialization
        asyncio.run(plugin.initialize(context))

        # Verify extractor is registered
        registry = ExtractorRegistry.get_instance()
        extractors = registry.list_extractors(available_only=False)

        extractor_ids = [e['id'] for e in extractors]
        self.assertIn('llamore-gemini', extractor_ids)

    def test_llamore_plugin_unregisters_extractor(self):
        """Test that LLamorePlugin unregisters extractor on cleanup."""
        plugin = LLamorePlugin()
        context = PluginContext()

        # Run initialization and cleanup
        asyncio.run(plugin.initialize(context))
        asyncio.run(plugin.cleanup())

        # Verify extractor is unregistered
        registry = ExtractorRegistry.get_instance()
        extractors = registry.list_extractors(available_only=False)

        extractor_ids = [e['id'] for e in extractors]
        self.assertNotIn('llamore-gemini', extractor_ids)


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


class TestMockExtractorRegistration(unittest.TestCase):
    """Test MockExtractor registration via SampleAnalyzerPlugin."""

    def setUp(self):
        """Reset registry before each test."""
        ExtractorRegistry.reset_instance()

    def tearDown(self):
        """Clean up after each test."""
        ExtractorRegistry.reset_instance()

    @patch.dict('os.environ', {'FASTAPI_APPLICATION_MODE': 'testing'})
    def test_mock_extractor_registered_in_testing_mode(self):
        """Test that MockExtractor is registered when in testing mode."""
        plugin = SampleAnalyzerPlugin()
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
        plugin = SampleAnalyzerPlugin()
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

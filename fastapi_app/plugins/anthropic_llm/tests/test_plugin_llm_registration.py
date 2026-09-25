"""
Unit tests for AnthropicLLMPlugin's LLM provider registration.

@testCovers fastapi_app/plugins/anthropic_llm/plugin.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.plugins.anthropic_llm.plugin import AnthropicLLMPlugin


class TestAnthropicLLMPluginRegistration(unittest.IsolatedAsyncioTestCase):
    """Test that AnthropicLLMPlugin registers/unregisters its LLM provider connector."""

    def setUp(self):
        LLMProviderRegistry.reset_instance()

    def tearDown(self):
        LLMProviderRegistry.reset_instance()

    def _mock_config(self, api_key, base_url="https://api.anthropic.com/v1"):
        """Build a get_config() replacement returning controlled values for our two keys.

        Patching fastapi_app.plugins.anthropic_llm.plugin.get_config (rather than
        relying on real env vars + get_plugin_config's global persistence) keeps
        these tests isolated from any other test's config state. AnthropicLLMPlugin
        .__init__'s own get_plugin_config(...) calls still run for real underneath
        this patch (harmless - they just read real env vars, usually unset in CI).
        """
        values = {"plugin.anthropic-llm.api.key": api_key, "plugin.anthropic-llm.api.url": base_url}
        mock_config = MagicMock()
        mock_config.get.side_effect = lambda key, *a, **kw: values.get(key)
        return mock_config

    @patch("fastapi_app.plugins.anthropic_llm.plugin.get_config")
    async def test_initialize_registers_provider_when_api_key_present(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = AnthropicLLMPlugin()

        await plugin.initialize(None)  # initialize() never reads from context

        provider = LLMProviderRegistry.get_instance().get_provider("anthropic")
        self.assertEqual(provider.label, "Anthropic Claude")
        self.assertTrue(provider.is_available())

    @patch("fastapi_app.plugins.anthropic_llm.plugin.get_config")
    async def test_initialize_skips_provider_without_api_key(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key=None)
        plugin = AnthropicLLMPlugin()

        await plugin.initialize(None)

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("anthropic")

    @patch("fastapi_app.plugins.anthropic_llm.plugin.get_config")
    async def test_cleanup_unregisters_provider(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = AnthropicLLMPlugin()
        await plugin.initialize(None)
        self.assertIsNotNone(LLMProviderRegistry.get_instance().get_provider("anthropic"))

        await plugin.cleanup()

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("anthropic")

    @patch("fastapi_app.plugins.anthropic_llm.plugin.get_config")
    async def test_initialize_skips_provider_in_testing_mode(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = AnthropicLLMPlugin()

        with patch.dict("os.environ", {"FASTAPI_APPLICATION_MODE": "testing"}):
            await plugin.initialize(None)

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("anthropic")


if __name__ == "__main__":
    unittest.main()

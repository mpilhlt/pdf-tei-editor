"""
Unit tests for GoogleLLMPlugin's LLM provider registration.

@testCovers fastapi_app/plugins/google_llm/plugin.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.plugins.google_llm.plugin import GoogleLLMPlugin


class TestGoogleLLMPluginRegistration(unittest.IsolatedAsyncioTestCase):
    """Test that GoogleLLMPlugin registers/unregisters its LLM provider connector."""

    def setUp(self):
        LLMProviderRegistry.reset_instance()

    def tearDown(self):
        LLMProviderRegistry.reset_instance()

    def _mock_config(self, api_key):
        """Build a get_config() replacement returning a controlled value for our key.

        Patching fastapi_app.plugins.google_llm.plugin.get_config (rather than
        relying on real env vars + get_plugin_config's global persistence) keeps
        these tests isolated from any other test's config state. GoogleLLMPlugin
        .__init__'s own get_plugin_config(...) call still runs for real underneath
        this patch (harmless - it just reads a real env var, usually unset in CI).
        """
        values = {"plugin.google-llm.api.key": api_key}
        mock_config = MagicMock()
        mock_config.get.side_effect = lambda key, *a, **kw: values.get(key)
        return mock_config

    @patch("fastapi_app.plugins.google_llm.plugin.get_config")
    async def test_initialize_registers_provider_when_api_key_present(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = GoogleLLMPlugin()

        await plugin.initialize(None)  # initialize() never reads from context

        provider = LLMProviderRegistry.get_instance().get_provider("google")
        self.assertEqual(provider.label, "Google Gemini")
        self.assertTrue(provider.is_available())

    @patch("fastapi_app.plugins.google_llm.plugin.get_config")
    async def test_initialize_skips_provider_without_api_key(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key=None)
        plugin = GoogleLLMPlugin()

        await plugin.initialize(None)

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("google")

    @patch("fastapi_app.plugins.google_llm.plugin.get_config")
    async def test_cleanup_unregisters_provider(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = GoogleLLMPlugin()
        await plugin.initialize(None)
        self.assertIsNotNone(LLMProviderRegistry.get_instance().get_provider("google"))

        await plugin.cleanup()

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("google")

    @patch("fastapi_app.plugins.google_llm.plugin.get_config")
    async def test_initialize_skips_provider_in_testing_mode(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = GoogleLLMPlugin()

        with patch.dict("os.environ", {"FASTAPI_APPLICATION_MODE": "testing"}):
            await plugin.initialize(None)

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("google")


if __name__ == "__main__":
    unittest.main()

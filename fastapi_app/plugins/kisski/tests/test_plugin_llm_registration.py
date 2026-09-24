"""
Unit tests for KisskiPlugin's LLM provider registration.

@testCovers fastapi_app/plugins/kisski/plugin.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.plugins.kisski.plugin import KisskiPlugin


class TestKisskiPluginLLMRegistration(unittest.IsolatedAsyncioTestCase):
    """Test that KisskiPlugin registers/unregisters its LLM provider connector."""

    def setUp(self):
        LLMProviderRegistry.reset_instance()
        # initialize()'s unrelated KisskiService/ServiceRegistry branch is
        # isolated by forcing is_available() to False (falls through to its
        # harmless "missing API key" warning, no registry side effects).
        # We deliberately do NOT set FASTAPI_APPLICATION_MODE=testing here:
        # that mode now also gates the LLM-provider registration under test
        # (see plugin.py's app_mode guard), so app_mode stays at its
        # "development" default for these tests.
        self.service_available_patcher = patch(
            "fastapi_app.plugins.kisski.plugin.KisskiService.is_available",
            return_value=False,
        )
        self.service_available_patcher.start()

    def tearDown(self):
        self.service_available_patcher.stop()
        LLMProviderRegistry.reset_instance()

    def _mock_config(self, api_key, base_url="https://example.com/v1"):
        """Build a get_config() replacement returning controlled values for our two keys.

        Patching fastapi_app.plugins.kisski.plugin.get_config (rather than
        relying on real env vars + get_plugin_config's global persistence)
        keeps these tests isolated from any other test's config state.
        KisskiPlugin.__init__'s own get_plugin_config(...) calls still run
        for real underneath this patch (harmless - they just read real env
        vars, usually unset in CI, and no-op if the value is None).
        """
        values = {"plugin.kisski.api.key": api_key, "plugin.kisski.api.url": base_url}
        mock_config = MagicMock()
        mock_config.get.side_effect = lambda key, *a, **kw: values.get(key)
        return mock_config

    @patch("fastapi_app.plugins.kisski.plugin.get_config")
    async def test_initialize_registers_llm_provider_when_api_key_present(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = KisskiPlugin()

        await plugin.initialize(None)  # initialize() never reads from context

        provider = LLMProviderRegistry.get_instance().get_provider("kisski")
        self.assertEqual(provider.label, "KISSKI Academic Cloud")
        self.assertTrue(provider.is_available())

    @patch("fastapi_app.plugins.kisski.plugin.get_config")
    async def test_initialize_skips_llm_provider_without_api_key(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key=None)
        plugin = KisskiPlugin()

        await plugin.initialize(None)

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("kisski")

    @patch("fastapi_app.plugins.kisski.plugin.get_config")
    async def test_cleanup_unregisters_llm_provider(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = KisskiPlugin()
        await plugin.initialize(None)
        self.assertIsNotNone(LLMProviderRegistry.get_instance().get_provider("kisski"))

        await plugin.cleanup()

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("kisski")

    @patch("fastapi_app.plugins.kisski.plugin.get_config")
    async def test_initialize_skips_llm_provider_in_testing_mode(self, mock_get_config):
        mock_get_config.return_value = self._mock_config(api_key="real-key")
        plugin = KisskiPlugin()

        with patch.dict("os.environ", {"FASTAPI_APPLICATION_MODE": "testing"}):
            await plugin.initialize(None)

        with self.assertRaises(KeyError):
            LLMProviderRegistry.get_instance().get_provider("kisski")


if __name__ == "__main__":
    unittest.main()

"""
Unit tests for the configured default LLM model.

@testCovers fastapi_app/lib/llm/default_model.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.llm import default_model


@mock.patch("fastapi_app.lib.llm.default_model.get_plugin_config")
@mock.patch("fastapi_app.lib.llm.default_model.get_config")
class TestDefaultModel(unittest.TestCase):
    def setUp(self):
        default_model.reset_registration()

    def tearDown(self):
        default_model.reset_registration()

    def _config(self, mock_get_config, provider="", model=""):
        values = {"llm.default-model.provider": provider, "llm.default-model.model": model}
        mock_get_config.return_value.get.side_effect = lambda key, default="": values.get(key, default)

    def test_none_when_unset_or_partial(self, mock_get_config, _):
        self._config(mock_get_config)
        self.assertIsNone(default_model.get_default_model())
        self._config(mock_get_config, provider="kisski")
        self.assertIsNone(default_model.get_default_model())

    def test_returns_the_configured_pair(self, mock_get_config, _):
        self._config(mock_get_config, "kisski", "gemma-3")
        self.assertEqual(default_model.get_default_model(), ("kisski", "gemma-3"))
        self.assertTrue(default_model.is_default_model("kisski", "gemma-3"))
        self.assertFalse(default_model.is_default_model("kisski", "other"))

    def test_set_writes_both_keys(self, mock_get_config, _):
        mock_get_config.return_value.set.return_value = (True, "ok")
        default_model.set_default_model("kisski", "gemma-3")
        keys = [(c.args[0], c.args[1]) for c in mock_get_config.return_value.set.call_args_list]
        self.assertEqual(keys, [("llm.default-model.provider", "kisski"), ("llm.default-model.model", "gemma-3")])

    def test_set_raises_when_the_config_write_fails(self, mock_get_config, _):
        mock_get_config.return_value.set.return_value = (False, "read-only")
        with self.assertRaises(RuntimeError):
            default_model.set_default_model("kisski", "gemma-3")

    def test_keys_are_registered_once(self, mock_get_config, mock_get_plugin_config):
        self._config(mock_get_config)
        default_model.get_default_model()
        default_model.get_default_model()
        self.assertEqual(mock_get_plugin_config.call_count, 2)


if __name__ == "__main__":
    unittest.main()

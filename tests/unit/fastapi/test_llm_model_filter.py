"""
Unit tests for the admin-configurable LLM model allow-list filter.

@testCovers fastapi_app/lib/llm/model_filter.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.llm import model_filter


class TestGetModelFilterPatterns(unittest.TestCase):
    """Test parsing of the comma-separated, quoted regex config value."""

    def setUp(self):
        model_filter.reset_registration()

    def tearDown(self):
        model_filter.reset_registration()

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_empty_config_returns_no_patterns(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.side_effect = lambda key, default="": {"llm.model-filter.include": ""}.get(key, default)
        self.assertEqual(model_filter.get_include_patterns(), [])

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_parses_quoted_comma_separated_patterns(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.side_effect = lambda key, default="": {"llm.model-filter.include": '"^KISSKI/.*", "Google Gemini/gemini-2\\.5-flash"'}.get(key, default)
        patterns = model_filter.get_include_patterns()
        self.assertEqual([p.pattern for p in patterns], ["^KISSKI/.*", "Google Gemini/gemini-2\\.5-flash"])

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_registers_config_key_exactly_once_across_calls(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.side_effect = lambda key, default="": {"llm.model-filter.include": ""}.get(key, default)
        model_filter.get_include_patterns()
        model_filter.get_include_patterns()
        model_filter.get_include_patterns()
        self.assertEqual(mock_get_plugin_config.call_count, 2)  # include + exclude keys, once


class TestIsModelAllowed(unittest.TestCase):
    """Test the allow-list matching semantics."""

    def setUp(self):
        model_filter.reset_registration()

    def tearDown(self):
        model_filter.reset_registration()

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_no_patterns_means_everything_allowed(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.side_effect = lambda key, default="": {"llm.model-filter.include": ""}.get(key, default)
        self.assertTrue(model_filter.is_model_allowed("Anthropic/claude-opus-9"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_label_matching_one_of_several_patterns_is_allowed(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.side_effect = lambda key, default="": {"llm.model-filter.include": '"^KISSKI/.*", "flash"'}.get(key, default)
        self.assertTrue(model_filter.is_model_allowed("KISSKI/gemma-3"))
        self.assertTrue(model_filter.is_model_allowed("Google Gemini/gemini-2.5-flash"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_label_matching_no_pattern_is_rejected(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.side_effect = lambda key, default="": {"llm.model-filter.include": '"^KISSKI/.*"'}.get(key, default)
        self.assertFalse(model_filter.is_model_allowed("Anthropic/claude-opus-9"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_pattern_matches_as_substring_search_not_full_match(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.side_effect = lambda key, default="": {"llm.model-filter.include": '"flash"'}.get(key, default)
        self.assertTrue(model_filter.is_model_allowed("Google Gemini/gemini-2.5-flash"))


class TestExcludeFilter(unittest.TestCase):
    def setUp(self):
        model_filter.reset_registration()

    def tearDown(self):
        model_filter.reset_registration()

    def _config(self, mock_get_config, include="", exclude=""):
        values = {"llm.model-filter.include": include, "llm.model-filter.exclude": exclude}
        mock_get_config.return_value.get.side_effect = lambda key, default="": values.get(key, default)

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_exclude_alone_rejects_only_matching_labels(self, mock_get_config, _):
        self._config(mock_get_config, exclude='"opus", "pro"')
        self.assertFalse(model_filter.is_model_allowed("Anthropic/claude-opus-9"))
        self.assertTrue(model_filter.is_model_allowed("Google Gemini/gemini-flash"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_unquoted_value_is_a_single_pattern(self, mock_get_config, _):
        self._config(mock_get_config, include="[Ff]lash")
        self.assertTrue(model_filter.is_model_allowed("Google Gemini/Gemini Flash"))
        self.assertFalse(model_filter.is_model_allowed("Anthropic/Claude Opus"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_exclude_wins_over_include(self, mock_get_config, _):
        self._config(mock_get_config, include='"Google"', exclude='"pro"')
        self.assertTrue(model_filter.is_model_allowed("Google Gemini/gemini-flash"))
        self.assertFalse(model_filter.is_model_allowed("Google Gemini/gemini-pro"))
        self.assertFalse(model_filter.is_model_allowed("Anthropic/claude"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_has_model_filter(self, mock_get_config, _):
        self._config(mock_get_config)
        self.assertFalse(model_filter.has_model_filter())
        self._config(mock_get_config, exclude='"x"')
        self.assertTrue(model_filter.has_model_filter())

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_keys_and_env_vars_are_registered(self, mock_get_config, mock_get_plugin_config):
        self._config(mock_get_config)
        model_filter.has_model_filter()
        registered = {(c.args[0], c.args[1]) for c in mock_get_plugin_config.call_args_list}
        self.assertEqual(registered, {
            ("llm.model-filter.include", "LLM_MODEL_FILTER_INCLUDE"),
            ("llm.model-filter.exclude", "LLM_MODEL_FILTER_EXCLUDE"),
        })


if __name__ == "__main__":
    unittest.main()

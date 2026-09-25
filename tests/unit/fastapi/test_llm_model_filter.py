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
        mock_get_config.return_value.get.return_value = ""
        self.assertEqual(model_filter.get_model_filter_patterns(), [])

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_parses_quoted_comma_separated_patterns(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.return_value = '"^KISSKI/.*", "Google Gemini/gemini-2\\.5-flash"'
        patterns = model_filter.get_model_filter_patterns()
        self.assertEqual([p.pattern for p in patterns], ["^KISSKI/.*", "Google Gemini/gemini-2\\.5-flash"])

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_registers_config_key_exactly_once_across_calls(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.return_value = ""
        model_filter.get_model_filter_patterns()
        model_filter.get_model_filter_patterns()
        model_filter.get_model_filter_patterns()
        mock_get_plugin_config.assert_called_once()


class TestIsModelAllowed(unittest.TestCase):
    """Test the allow-list matching semantics."""

    def setUp(self):
        model_filter.reset_registration()

    def tearDown(self):
        model_filter.reset_registration()

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_no_patterns_means_everything_allowed(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.return_value = ""
        self.assertTrue(model_filter.is_model_allowed("Anthropic/claude-opus-9"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_label_matching_one_of_several_patterns_is_allowed(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.return_value = '"^KISSKI/.*", "flash"'
        self.assertTrue(model_filter.is_model_allowed("KISSKI/gemma-3"))
        self.assertTrue(model_filter.is_model_allowed("Google Gemini/gemini-2.5-flash"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_label_matching_no_pattern_is_rejected(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.return_value = '"^KISSKI/.*"'
        self.assertFalse(model_filter.is_model_allowed("Anthropic/claude-opus-9"))

    @mock.patch("fastapi_app.lib.llm.model_filter.get_plugin_config")
    @mock.patch("fastapi_app.lib.llm.model_filter.get_config")
    def test_pattern_matches_as_substring_search_not_full_match(self, mock_get_config, mock_get_plugin_config):
        mock_get_config.return_value.get.return_value = '"flash"'
        self.assertTrue(model_filter.is_model_allowed("Google Gemini/gemini-2.5-flash"))


if __name__ == "__main__":
    unittest.main()

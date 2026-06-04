"""
Unit tests for LLamoreExtractor dynamic model selection.
"""

import time
import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.plugins.llamore_extractor.extractor import LLamoreExtractor


def _make_mock_model(name: str, actions: list[str]) -> MagicMock:
    m = MagicMock()
    m.name = f"models/{name}"
    m.supported_actions = actions
    return m


GENERATE_CONTENT = "generateContent"
GEMINI_MODELS = [
    _make_mock_model("gemini-2.5-flash", [GENERATE_CONTENT, "countTokens"]),
    _make_mock_model("gemini-2.5-pro", [GENERATE_CONTENT, "countTokens"]),
    _make_mock_model("gemini-2.0-flash", [GENERATE_CONTENT, "countTokens"]),
    _make_mock_model("gemini-2.5-flash-preview-tts", ["countTokens", GENERATE_CONTENT]),
    _make_mock_model("gemma-4-26b-a4b-it", [GENERATE_CONTENT, "countTokens"]),
]


class TestFetchAvailableModels(unittest.TestCase):

    def setUp(self):
        # Clear the class-level cache before each test
        LLamoreExtractor._models_cache = None
        LLamoreExtractor._models_cache_time = 0

    def tearDown(self):
        LLamoreExtractor._models_cache = None
        LLamoreExtractor._models_cache_time = 0

    def _setup_config_mock(self, mock_get_config, api_key="test-api-key", model="gemini-2.0-flash"):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": api_key,
            "plugin.llamore.model": model,
        }.get(key, default)

    def _mock_client(self, models=None):
        """Return a mock genai.Client whose models.list() yields GEMINI_MODELS."""
        mock_client = MagicMock()
        mock_client.models.list.return_value = models if models is not None else GEMINI_MODELS
        return mock_client

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_config")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.genai")
    def test_returns_only_gemini_generate_content_models(self, mock_genai, mock_get_config):
        self._setup_config_mock(mock_get_config)
        mock_genai.Client.return_value = self._mock_client()

        result = LLamoreExtractor._fetch_available_models()

        # Only gemini- models with generateContent should be included
        self.assertIn("gemini-2.5-flash", result)
        self.assertIn("gemini-2.5-pro", result)
        self.assertIn("gemini-2.0-flash", result)
        # Gemma models should be excluded (don't start with gemini-)
        self.assertNotIn("gemma-4-26b-a4b-it", result)

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_config")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.genai")
    def test_configured_model_is_first(self, mock_genai, mock_get_config):
        self._setup_config_mock(mock_get_config, model="gemini-2.5-pro")
        mock_genai.Client.return_value = self._mock_client()

        result = LLamoreExtractor._fetch_available_models()

        self.assertEqual(result[0], "gemini-2.5-pro")

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_config")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.genai")
    def test_cache_is_used_within_ttl(self, mock_genai, mock_get_config):
        self._setup_config_mock(mock_get_config)
        mock_genai.Client.return_value = self._mock_client()

        LLamoreExtractor._fetch_available_models()
        LLamoreExtractor._fetch_available_models()

        # Client should only have been constructed once
        self.assertEqual(mock_genai.Client.call_count, 1)

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_config")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.genai")
    def test_cache_is_refreshed_after_ttl(self, mock_genai, mock_get_config):
        self._setup_config_mock(mock_get_config)
        mock_genai.Client.return_value = self._mock_client()

        LLamoreExtractor._fetch_available_models()
        # Expire the cache
        LLamoreExtractor._models_cache_time = time.time() - LLamoreExtractor._CACHE_TTL - 1
        LLamoreExtractor._fetch_available_models()

        self.assertEqual(mock_genai.Client.call_count, 2)

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_config")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.genai")
    def test_fallback_to_config_model_on_api_error(self, mock_genai, mock_get_config):
        self._setup_config_mock(mock_get_config)
        mock_genai.Client.side_effect = Exception("API error")

        result = LLamoreExtractor._fetch_available_models()

        self.assertEqual(result, ["gemini-2.0-flash"])

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_config")
    def test_fallback_when_no_api_key(self, mock_get_config):
        self._setup_config_mock(mock_get_config, api_key="")

        result = LLamoreExtractor._fetch_available_models()

        self.assertEqual(result, ["gemini-2.0-flash"])


class TestGetInfoIncludesModelOption(unittest.TestCase):

    def setUp(self):
        LLamoreExtractor._models_cache = ["gemini-2.5-flash", "gemini-2.0-flash"]
        LLamoreExtractor._models_cache_time = time.time()

    def tearDown(self):
        LLamoreExtractor._models_cache = None
        LLamoreExtractor._models_cache_time = 0

    def test_get_info_includes_model_option(self):
        info = LLamoreExtractor.get_info()
        self.assertIn("model", info["options"])
        self.assertIn("options", info["options"]["model"])
        self.assertIn("gemini-2.5-flash", info["options"]["model"]["options"])


class TestExtractUsesModelFromOptions(unittest.TestCase):

    def setUp(self):
        LLamoreExtractor._models_cache = ["gemini-2.5-flash", "gemini-2.0-flash"]
        LLamoreExtractor._models_cache_time = time.time()

    def tearDown(self):
        LLamoreExtractor._models_cache = None
        LLamoreExtractor._models_cache_time = 0

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_config")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.LineByLinePrompter")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.GeminiExtractor")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.TeiBiblStruct")
    def test_extract_uses_model_from_options(
        self, mock_parser_cls, mock_extractor_cls, mock_prompter_cls, mock_get_config
    ):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)

        mock_extractor_instance = MagicMock()
        mock_extractor_instance.return_value = []
        mock_extractor_cls.return_value = mock_extractor_instance

        mock_parser = MagicMock()
        mock_parser.to_xml.return_value = b'<listBibl xmlns="http://www.tei-c.org/ns/1.0"/>'
        mock_parser_cls.return_value = mock_parser

        extractor = LLamoreExtractor()
        extractor._extract_refs_from_pdf("/path/to/file.pdf", {"model": "gemini-2.5-flash"})

        # Verify GeminiExtractor was created with the model from options, not config default
        mock_extractor_cls.assert_called_once()
        call_kwargs = mock_extractor_cls.call_args.kwargs
        self.assertEqual(call_kwargs.get("model"), "gemini-2.5-flash")

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_config")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.LineByLinePrompter")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.GeminiExtractor")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.TeiBiblStruct")
    def test_extract_falls_back_to_config_model_when_not_in_options(
        self, mock_parser_cls, mock_extractor_cls, mock_prompter_cls, mock_get_config
    ):
        mock_get_config.return_value.get.side_effect = lambda key, default=None: {
            "plugin.llamore.api.key": "test-api-key",
            "plugin.llamore.model": "gemini-2.0-flash",
        }.get(key, default)

        mock_extractor_instance = MagicMock()
        mock_extractor_instance.return_value = []
        mock_extractor_cls.return_value = mock_extractor_instance

        mock_parser = MagicMock()
        mock_parser.to_xml.return_value = b'<listBibl xmlns="http://www.tei-c.org/ns/1.0"/>'
        mock_parser_cls.return_value = mock_parser

        extractor = LLamoreExtractor()
        extractor._extract_refs_from_pdf("/path/to/file.pdf", {})

        mock_extractor_cls.assert_called_once()
        call_kwargs = mock_extractor_cls.call_args.kwargs
        self.assertEqual(call_kwargs.get("model"), "gemini-2.0-flash")


if __name__ == "__main__":
    unittest.main()

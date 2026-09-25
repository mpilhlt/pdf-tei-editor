"""
Unit tests for the Google Gemini LLM provider connector.

@testCovers fastapi_app/plugins/google_llm/llm_provider.py
"""

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi_app.plugins.google_llm.llm_provider import GoogleLLMProvider


class TestGoogleLLMProviderAvailability(unittest.TestCase):
    """Test is_available() reflects whether an API key was supplied."""

    def test_is_available_true_with_api_key(self):
        provider = GoogleLLMProvider(id="google", label="Google Gemini", api_key="k")
        self.assertTrue(provider.is_available())

    def test_is_available_false_without_api_key(self):
        provider = GoogleLLMProvider(id="google", label="Google Gemini", api_key="")
        self.assertFalse(provider.is_available())


class TestGoogleLLMProviderListModels(unittest.TestCase):
    """Test list_models() filters and shapes the SDK's model list."""

    @patch("fastapi_app.plugins.google_llm.llm_provider.genai.Client")
    def test_list_models_filters_gemini_models_with_generate_content(self, mock_client_cls):
        model_a = MagicMock()
        model_a.name = "models/gemini-2.0-flash"
        model_a.display_name = "Gemini 2.0 Flash"
        model_a.supported_actions = ["generateContent"]

        model_b = MagicMock()
        model_b.name = "models/embedding-001"
        model_b.display_name = "Embedding 001"
        model_b.supported_actions = ["embedContent"]

        model_c = MagicMock()
        model_c.name = "models/gemini-1.5-pro"
        model_c.display_name = None
        model_c.supported_actions = ["generateContent"]

        mock_client = MagicMock()
        mock_client.models.list.return_value = [model_a, model_b, model_c]
        mock_client_cls.return_value = mock_client

        provider = GoogleLLMProvider(id="google", label="Google Gemini", api_key="k")
        models = provider.list_models()

        self.assertEqual(len(models), 2)
        self.assertEqual(models[0]["id"], "gemini-2.0-flash")
        self.assertEqual(models[0]["label"], "Gemini 2.0 Flash")
        self.assertIn("chat", models[0]["capabilities"])
        self.assertIsNone(models[0]["status"])
        self.assertEqual(models[1]["id"], "gemini-1.5-pro")
        self.assertEqual(models[1]["label"], "gemini-1.5-pro")  # falls back to id

    def test_list_models_returns_empty_without_api_key(self):
        provider = GoogleLLMProvider(id="google", label="Google Gemini", api_key="")
        self.assertEqual(provider.list_models(), [])

    @patch("fastapi_app.plugins.google_llm.llm_provider.genai.Client")
    def test_list_models_excludes_image_tts_and_transcribe_models(self, mock_client_cls):
        # These all support generateContent (so pass the existing filter) but
        # are not text chat models - the SDK exposes no modality field to
        # distinguish them, so they're recognized by their name suffix
        # instead (confirmed against the live API's actual model names).
        model_chat = MagicMock()
        model_chat.name = "models/gemini-2.5-flash"
        model_chat.display_name = "Gemini 2.5 Flash"
        model_chat.supported_actions = ["generateContent"]

        model_image = MagicMock()
        model_image.name = "models/gemini-2.5-flash-image"
        model_image.display_name = "Gemini 2.5 Flash Image"
        model_image.supported_actions = ["generateContent"]

        model_tts = MagicMock()
        model_tts.name = "models/gemini-2.5-flash-preview-tts"
        model_tts.display_name = "Gemini 2.5 Flash TTS"
        model_tts.supported_actions = ["generateContent"]

        model_transcribe = MagicMock()
        model_transcribe.name = "models/gemini-3.5-transcribe"
        model_transcribe.display_name = "Gemini Transcribe"
        model_transcribe.supported_actions = ["generateContent"]

        model_computer_use = MagicMock()
        model_computer_use.name = "models/gemini-2.5-computer-use-preview-10-2025"
        model_computer_use.display_name = "Gemini Computer Use"
        model_computer_use.supported_actions = ["generateContent"]

        mock_client = MagicMock()
        mock_client.models.list.return_value = [
            model_chat, model_image, model_tts, model_transcribe, model_computer_use,
        ]
        mock_client_cls.return_value = mock_client

        provider = GoogleLLMProvider(id="google", label="Google Gemini", api_key="k")
        models = provider.list_models()

        self.assertEqual([m["id"] for m in models], ["gemini-2.5-flash"])


class TestGoogleLLMProviderChatCompletion(unittest.IsolatedAsyncioTestCase):
    """Test chat_completion() delegates to the SDK's async generate_content."""

    @patch("fastapi_app.plugins.google_llm.llm_provider.genai.Client")
    async def test_chat_completion_calls_generate_content_and_returns_text(self, mock_client_cls):
        mock_response = MagicMock()
        mock_response.text = "hello from gemini"
        mock_client = MagicMock()
        mock_client.aio.models.generate_content = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value = mock_client

        provider = GoogleLLMProvider(id="google", label="Google Gemini", api_key="k")
        result = await provider.chat_completion(
            model_id="gemini-2.0-flash", system_prompt="sys", user_prompt="usr", temperature=0.4
        )

        self.assertEqual(result, "hello from gemini")
        mock_client.aio.models.generate_content.assert_called_once()
        call_kwargs = mock_client.aio.models.generate_content.call_args.kwargs
        self.assertEqual(call_kwargs["model"], "gemini-2.0-flash")
        self.assertEqual(call_kwargs["contents"], "usr")
        self.assertEqual(call_kwargs["config"].system_instruction, "sys")
        self.assertEqual(call_kwargs["config"].temperature, 0.4)


if __name__ == "__main__":
    unittest.main()

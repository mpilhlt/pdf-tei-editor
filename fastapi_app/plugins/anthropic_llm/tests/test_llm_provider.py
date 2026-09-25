"""
Unit tests for the Anthropic Claude LLM provider connector.

@testCovers fastapi_app/plugins/anthropic_llm/llm_provider.py
"""

import unittest
from unittest.mock import MagicMock, patch

import requests

from fastapi_app.plugins.anthropic_llm.llm_provider import AnthropicLLMProvider


class TestAnthropicLLMProviderAvailability(unittest.TestCase):
    """Test is_available() reflects whether an API key was supplied."""

    def test_is_available_true_with_api_key(self):
        provider = AnthropicLLMProvider(id="anthropic", label="Anthropic Claude", api_key="k")
        self.assertTrue(provider.is_available())

    def test_is_available_false_without_api_key(self):
        provider = AnthropicLLMProvider(id="anthropic", label="Anthropic Claude", api_key="")
        self.assertFalse(provider.is_available())


class TestAnthropicLLMProviderListModels(unittest.TestCase):
    """Test list_models() parses the Models API's data array."""

    @patch("fastapi_app.plugins.anthropic_llm.llm_provider.get_retry_session")
    def test_list_models_parses_data_array(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "data": [
                {"id": "claude-opus-4", "display_name": "Claude Opus 4"},
                {"id": "claude-haiku-4"},
            ]
        }
        mock_session.get.return_value = mock_response
        mock_get_session.return_value = mock_session

        provider = AnthropicLLMProvider(id="anthropic", label="Anthropic Claude", api_key="k")
        models = provider.list_models()

        self.assertEqual(len(models), 2)
        self.assertEqual(models[0]["id"], "claude-opus-4")
        self.assertEqual(models[0]["label"], "Claude Opus 4")
        self.assertIn("chat", models[0]["capabilities"])
        self.assertIsNone(models[0]["status"])
        self.assertEqual(models[1]["label"], "claude-haiku-4")  # falls back to id

        call_args = mock_session.get.call_args
        self.assertEqual(call_args[0][0], "https://api.anthropic.com/v1/models")
        self.assertEqual(call_args[1]["headers"]["x-api-key"], "k")
        self.assertEqual(call_args[1]["headers"]["anthropic-version"], "2023-06-01")


class TestAnthropicLLMProviderChatCompletion(unittest.IsolatedAsyncioTestCase):
    """Test chat_completion() posts the Messages API's expected payload."""

    @patch("fastapi_app.plugins.anthropic_llm.llm_provider.get_retry_session")
    async def test_chat_completion_posts_expected_payload_and_returns_text(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "content": [{"type": "text", "text": "hello from claude"}]
        }
        mock_session.post.return_value = mock_response
        mock_get_session.return_value = mock_session

        provider = AnthropicLLMProvider(id="anthropic", label="Anthropic Claude", api_key="k")
        result = await provider.chat_completion(
            model_id="claude-opus-4", system_prompt="sys", user_prompt="usr", temperature=0.5
        )

        self.assertEqual(result, "hello from claude")
        call_args = mock_session.post.call_args
        self.assertEqual(call_args[0][0], "https://api.anthropic.com/v1/messages")
        self.assertEqual(call_args[1]["headers"]["x-api-key"], "k")
        self.assertEqual(call_args[1]["headers"]["anthropic-version"], "2023-06-01")
        self.assertEqual(call_args[1]["json"]["model"], "claude-opus-4")
        self.assertEqual(call_args[1]["json"]["system"], "sys")
        self.assertEqual(call_args[1]["json"]["messages"], [{"role": "user", "content": "usr"}])
        self.assertEqual(call_args[1]["json"]["temperature"], 0.5)
        self.assertIn("max_tokens", call_args[1]["json"])

    @patch("fastapi_app.plugins.anthropic_llm.llm_provider.get_retry_session")
    async def test_chat_completion_returns_empty_string_when_no_text_block(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {"content": []}
        mock_session.post.return_value = mock_response
        mock_get_session.return_value = mock_session

        provider = AnthropicLLMProvider(id="anthropic", label="Anthropic Claude", api_key="k")
        result = await provider.chat_completion(model_id="m", system_prompt="s", user_prompt="u")

        self.assertEqual(result, "")


class TestAnthropicLLMProviderTemperatureRejected(unittest.IsolatedAsyncioTestCase):
    """Newer Claude models reject `temperature` with a 400; the request is retried without it."""

    @staticmethod
    def _response(status_code: int, body: dict) -> MagicMock:
        response = MagicMock()
        response.status_code = status_code
        response.json.return_value = body
        if status_code >= 400:
            response.raise_for_status.side_effect = requests.HTTPError(f"{status_code} Client Error", response=response)
        return response

    @patch("fastapi_app.plugins.anthropic_llm.llm_provider.get_retry_session")
    async def test_retries_without_temperature_when_model_rejects_it(self, mock_get_session):
        rejected = self._response(400, {"error": {"type": "invalid_request_error", "message": "`temperature` is deprecated for this model."}})
        accepted = self._response(200, {"content": [{"type": "text", "text": "ok"}]})
        mock_session = MagicMock()
        mock_session.post.side_effect = [rejected, accepted]
        mock_get_session.return_value = mock_session

        provider = AnthropicLLMProvider(id="anthropic", label="Anthropic Claude", api_key="k")
        result = await provider.chat_completion(model_id="m", system_prompt="s", user_prompt="u", temperature=0.2)

        self.assertEqual(result, "ok")
        self.assertEqual(mock_session.post.call_count, 2)
        self.assertIn("temperature", mock_session.post.call_args_list[0][1]["json"])
        self.assertNotIn("temperature", mock_session.post.call_args_list[1][1]["json"])

    @patch("fastapi_app.plugins.anthropic_llm.llm_provider.get_retry_session")
    async def test_other_400_errors_are_not_retried(self, mock_get_session):
        rejected = self._response(400, {"error": {"type": "invalid_request_error", "message": "max_tokens: too large"}})
        mock_session = MagicMock()
        mock_session.post.return_value = rejected
        mock_get_session.return_value = mock_session

        provider = AnthropicLLMProvider(id="anthropic", label="Anthropic Claude", api_key="k")
        with self.assertRaises(requests.HTTPError):
            await provider.chat_completion(model_id="m", system_prompt="s", user_prompt="u")
        self.assertEqual(mock_session.post.call_count, 1)


if __name__ == "__main__":
    unittest.main()

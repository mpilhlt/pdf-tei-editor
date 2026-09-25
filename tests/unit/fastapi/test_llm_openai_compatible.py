"""
Unit tests for the OpenAI-compatible LLM provider connector.

@testCovers fastapi_app/lib/llm/openai_compatible.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.llm.openai_compatible import (
    OpenAICompatibleProvider,
    chat_completion_sync,
)


class TestChatCompletionSync(unittest.TestCase):
    """Test the shared sync HTTP call, independent of any provider instance."""

    @patch("fastapi_app.lib.llm.openai_compatible.get_retry_session")
    def test_posts_expected_payload_and_returns_content(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "hello world"}}]
        }
        mock_session.post.return_value = mock_response
        mock_get_session.return_value = mock_session

        result = chat_completion_sync(
            base_url="https://example.com/v1",
            api_key="secret-key",
            model_id="test-model",
            system_prompt="You are helpful",
            user_prompt="Hi",
            temperature=0.5,
        )

        self.assertEqual(result, "hello world")
        mock_session.post.assert_called_once()
        call_args = mock_session.post.call_args
        self.assertEqual(call_args[0][0], "https://example.com/v1/chat/completions")
        self.assertEqual(call_args[1]["headers"]["Authorization"], "Bearer secret-key")
        self.assertEqual(call_args[1]["json"]["model"], "test-model")
        self.assertEqual(call_args[1]["json"]["temperature"], 0.5)
        self.assertEqual(
            call_args[1]["json"]["messages"],
            [
                {"role": "system", "content": "You are helpful"},
                {"role": "user", "content": "Hi"},
            ],
        )

    @patch("fastapi_app.lib.llm.openai_compatible.get_retry_session")
    def test_returns_empty_string_when_no_choices(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {"choices": []}
        mock_session.post.return_value = mock_response
        mock_get_session.return_value = mock_session

        result = chat_completion_sync(
            base_url="https://example.com/v1",
            api_key="k",
            model_id="m",
            system_prompt="s",
            user_prompt="u",
        )
        self.assertEqual(result, "")


class TestOpenAICompatibleProvider(unittest.IsolatedAsyncioTestCase):
    """Test the provider class wrapping the shared function."""

    def test_is_available_true_with_api_key(self):
        provider = OpenAICompatibleProvider(
            id="test", label="Test", base_url="https://example.com/v1", api_key="k"
        )
        self.assertTrue(provider.is_available())

    def test_is_available_false_without_api_key(self):
        provider = OpenAICompatibleProvider(
            id="test", label="Test", base_url="https://example.com/v1", api_key=""
        )
        self.assertFalse(provider.is_available())

    @patch("fastapi_app.lib.llm.openai_compatible.get_retry_session")
    def test_list_models_parses_data_array(self, mock_get_session):
        mock_session = MagicMock()
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "data": [
                {"id": "model-a", "name": "Model A"},
                {"id": "model-b"},
            ]
        }
        mock_session.get.return_value = mock_response
        mock_get_session.return_value = mock_session

        provider = OpenAICompatibleProvider(
            id="test", label="Test", base_url="https://example.com/v1", api_key="k"
        )
        models = provider.list_models()

        self.assertEqual(len(models), 2)
        self.assertEqual(models[0]["id"], "model-a")
        self.assertEqual(models[0]["label"], "Model A")
        self.assertEqual(models[1]["label"], "model-b")  # falls back to id
        self.assertIsNone(models[0]["status"])
        self.assertIn("chat", models[0]["capabilities"])

    async def test_chat_completion_delegates_to_shared_function(self):
        provider = OpenAICompatibleProvider(
            id="test", label="Test", base_url="https://example.com/v1", api_key="k"
        )
        with patch(
            "fastapi_app.lib.llm.openai_compatible.chat_completion_sync",
            return_value="async result",
        ) as mock_fn:
            result = await provider.chat_completion(
                model_id="m", system_prompt="s", user_prompt="u", temperature=0.3
            )
        self.assertEqual(result, "async result")
        mock_fn.assert_called_once_with(
            base_url="https://example.com/v1",
            api_key="k",
            model_id="m",
            system_prompt="s",
            user_prompt="u",
            temperature=0.3,
        )


if __name__ == "__main__":
    unittest.main()

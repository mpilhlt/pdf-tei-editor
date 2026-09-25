"""
Anthropic Claude LLM provider connector.

Implements LLMProvider directly (not OpenAICompatibleProvider) since
Anthropic's Messages API (POST /v1/messages) is not the OpenAI
chat/completions wire format - unlike Google's Gemini API, Anthropic has
no OpenAI-compatible endpoint. Uses raw HTTP via get_retry_session, the
same low-level style as fastapi_app/lib/llm/openai_compatible.py, rather
than adding the anthropic SDK as a new project dependency.
"""

import asyncio
import logging

import requests

from fastapi_app.lib.extraction.http_utils import get_retry_session
from fastapi_app.lib.llm.base import LLMModel, LLMProvider

logger = logging.getLogger(__name__)

ANTHROPIC_API_VERSION = "2023-06-01"
# Anthropic's Messages API requires max_tokens; LLMProvider.chat_completion has no
# such parameter, so this is a fixed, generous ceiling rather than a per-call knob.
DEFAULT_MAX_TOKENS = 16384
REQUEST_TIMEOUT_SECONDS = 300


class AnthropicLLMProvider(LLMProvider):
    """LLM provider connector for Anthropic's Claude API."""

    def __init__(self, id: str, label: str, api_key: str, base_url: str = "https://api.anthropic.com/v1"):
        self.id = id
        self.label = label
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")

    def is_available(self) -> bool:
        return bool(self._api_key)

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": ANTHROPIC_API_VERSION,
            "content-type": "application/json",
        }

    def list_models(self) -> list[LLMModel]:
        session = get_retry_session(retries=3, backoff_factor=1.0)
        url = f"{self._base_url}/models"
        response = session.get(url, headers=self._headers(), timeout=30)
        response.raise_for_status()
        entries = response.json().get("data", [])
        return [
            LLMModel(
                id=entry["id"],
                label=entry.get("display_name", entry["id"]),
                capabilities=frozenset({"chat"}),
                status=None,
                free=False,
            )
            for entry in entries
            if "id" in entry
        ]

    async def chat_completion(
        self,
        model_id: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
    ) -> str:
        return await asyncio.to_thread(
            self._chat_completion_sync,
            model_id=model_id,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
        )

    def _chat_completion_sync(
        self,
        model_id: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
    ) -> str:
        session = get_retry_session(retries=3, backoff_factor=2.0, read_retries=0)
        url = f"{self._base_url}/messages"
        data = {
            "model": model_id,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
            "temperature": temperature,
        }
        response = session.post(url, headers=self._headers(), json=data, timeout=REQUEST_TIMEOUT_SECONDS)
        if response.status_code == 400 and self._error_message(response).startswith("`temperature`"):
            # Newer Claude models reject `temperature` ("is deprecated for this model"), older ones
            # accept it: send it optimistically and retry once without it.
            data_without_temperature = {key: value for key, value in data.items() if key != "temperature"}
            response = session.post(url, headers=self._headers(), json=data_without_temperature, timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        for block in response.json().get("content", []):
            if block.get("type") == "text":
                return block.get("text", "")
        return ""

    @staticmethod
    def _error_message(response: requests.Response) -> str:
        """The `error.message` of an Anthropic error response, or "" if it has none."""
        try:
            return str(response.json().get("error", {}).get("message", ""))
        except ValueError:
            return ""

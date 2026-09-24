"""
Concrete LLMProvider for endpoints speaking the OpenAI chat/completions
wire format: POST {base_url}/chat/completions, GET {base_url}/models.

chat_completion_sync() is a free function (not a method) so it can be
reused directly by fastapi_app/plugins/kisski/extractor.py's existing
_call_llm, eliminating duplicate HTTP-call code between the extraction
feature and this new registry, without either one depending on the
other's class hierarchy.
"""

import asyncio
import logging

from fastapi_app.lib.extraction.http_utils import get_retry_session

from .base import LLMModel, LLMProvider

logger = logging.getLogger(__name__)


def chat_completion_sync(
    base_url: str,
    api_key: str,
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.2,
) -> str:
    """Synchronously call an OpenAI-compatible chat/completions endpoint."""
    session = get_retry_session(retries=3, backoff_factor=2.0)
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    data = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
    }
    response = session.post(url, headers=headers, json=data, timeout=120)
    response.raise_for_status()
    result = response.json()
    choices = result.get("choices", [])
    if choices:
        return choices[0]["message"]["content"]
    return ""


class OpenAICompatibleProvider(LLMProvider):
    """Concrete base for providers speaking the OpenAI chat/completions wire format."""

    def __init__(self, id: str, label: str, base_url: str, api_key: str):
        self.id = id
        self.label = label
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key

    def is_available(self) -> bool:
        return bool(self._api_key)

    def list_models(self) -> list[LLMModel]:
        session = get_retry_session(retries=3, backoff_factor=1.0)
        url = f"{self._base_url}/models"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        response = session.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        entries = response.json().get("data", [])
        return [
            LLMModel(
                id=entry["id"],
                label=entry.get("name", entry["id"]),
                capabilities=frozenset({"chat"}),
                status=None,
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
            chat_completion_sync,
            base_url=self._base_url,
            api_key=self._api_key,
            model_id=model_id,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
        )

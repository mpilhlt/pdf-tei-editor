"""
Google Gemini LLM provider connector.

Implements LLMProvider directly (not OpenAICompatibleProvider) since the
Gemini API is not itself an OpenAI chat/completions endpoint - unlike
Kisski, which hosts Gemma models behind an OpenAI-compatible endpoint.
Uses the google-genai SDK, an existing project dependency (see
fastapi_app/plugins/llamore_extractor/extractor.py for the sibling usage
this mirrors: same model-listing filter, same GEMINI_API_KEY convention).
"""

import logging

from google import genai
from google.genai import types

from fastapi_app.lib.llm.base import LLMModel, LLMProvider

logger = logging.getLogger(__name__)


class GoogleLLMProvider(LLMProvider):
    """LLM provider connector for Google's Gemini API."""

    def __init__(self, id: str, label: str, api_key: str):
        self.id = id
        self.label = label
        self._api_key = api_key
        self._client = genai.Client(api_key=api_key) if api_key else None

    def is_available(self) -> bool:
        return bool(self._api_key)

    def list_models(self) -> list[LLMModel]:
        if self._client is None:
            return []
        models: list[LLMModel] = []
        for model in self._client.models.list():
            if not model.name or not model.name.startswith("models/gemini-"):
                continue
            if "generateContent" not in (model.supported_actions or []):
                continue
            model_id = model.name.replace("models/", "")
            models.append(
                LLMModel(
                    id=model_id,
                    label=model.display_name or model_id,
                    capabilities=frozenset({"chat"}),
                    status=None,
                )
            )
        return models

    async def chat_completion(
        self,
        model_id: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
    ) -> str:
        if self._client is None:
            raise RuntimeError("Google LLM provider not configured (missing API key)")
        response = await self._client.aio.models.generate_content(
            model=model_id,
            contents=user_prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=temperature,
            ),
        )
        return response.text or ""

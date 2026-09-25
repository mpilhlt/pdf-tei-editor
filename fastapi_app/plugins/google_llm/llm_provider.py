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
from google.genai import errors as genai_errors, types

from fastapi_app.lib.llm.base import LLMModel, LLMProvider, LLMProviderError

logger = logging.getLogger(__name__)

# The google-genai SDK's Model type exposes no modality/capability field
# beyond `supported_actions` (which only distinguishes generateContent from
# embedContent/bidiGenerateContent/etc). Image-generation, TTS, transcription
# and computer-use models all support generateContent but don't behave like
# a plain text chat model, so they're recognized by name suffix instead
# (verified against the live API's actual model names).
_NON_CHAT_NAME_MARKERS = ("-image", "-tts", "-transcribe", "-computer-use")


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
            if any(marker in model_id for marker in _NON_CHAT_NAME_MARKERS):
                continue
            models.append(
                LLMModel(
                    id=model_id,
                    label=model.display_name or model_id,
                    capabilities=frozenset({"chat"}),
                    status=None,
                    free=False,
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
        try:
            response = await self._client.aio.models.generate_content(
                model=model_id,
                contents=user_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    temperature=temperature,
                ),
            )
        except genai_errors.APIError as e:
            raise LLMProviderError(f"{e.code} {e.message}") from e
        return response.text or ""

"""LLM provider registry package - see base.py for the design rationale."""

from .base import LLMModel, LLMProvider, ModelStatus
from .openai_compatible import OpenAICompatibleProvider, chat_completion_sync
from .registry import LLMProviderRegistry

__all__ = [
    "LLMModel",
    "LLMProvider",
    "ModelStatus",
    "OpenAICompatibleProvider",
    "chat_completion_sync",
    "LLMProviderRegistry",
]

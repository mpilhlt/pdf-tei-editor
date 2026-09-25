"""LLM provider registry package - see base.py for the design rationale."""

from .base import LLMModel, LLMProvider, LLMProviderError, ModelStatus
from .model_filter import is_model_allowed
from .openai_compatible import OpenAICompatibleProvider, chat_completion_sync
from .registry import LLMProviderRegistry

__all__ = [
    "LLMModel",
    "LLMProvider",
    "LLMProviderError",
    "ModelStatus",
    "OpenAICompatibleProvider",
    "chat_completion_sync",
    "LLMProviderRegistry",
    "is_model_allowed",
]

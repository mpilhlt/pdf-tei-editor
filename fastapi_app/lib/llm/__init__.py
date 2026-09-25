"""LLM provider registry package - see base.py for the design rationale."""

from .base import LLMModel, LLMProvider, LLMProviderError, ModelStatus
from .default_model import get_default_model, is_default_model, set_default_model
from .model_filter import has_model_filter, is_model_allowed
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
    "get_default_model",
    "has_model_filter",
    "is_default_model",
    "is_model_allowed",
    "set_default_model",
]

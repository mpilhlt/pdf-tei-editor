"""LLM provider registry package - see base.py for the design rationale."""

from .base import LLMImage, LLMModel, LLMProvider, LLMProviderError, ModelStatus
from .default_model import get_default_model, is_default_model, set_default_model
from .model_filter import has_model_filter, is_model_allowed
from .openai_compatible import OpenAICompatibleProvider, chat_completion_sync, get_completion_session
from .rate_limit import LLMRateLimitError, RateLimitTracker, get_rate_limit_tracker, post_completion, rate_limit_http_error
from .registry import LLMProviderRegistry

__all__ = [
    "LLMImage",
    "LLMModel",
    "LLMProvider",
    "LLMProviderError",
    "LLMRateLimitError",
    "RateLimitTracker",
    "get_rate_limit_tracker",
    "post_completion",
    "rate_limit_http_error",
    "ModelStatus",
    "OpenAICompatibleProvider",
    "chat_completion_sync",
    "get_completion_session",
    "LLMProviderRegistry",
    "get_default_model",
    "has_model_filter",
    "is_default_model",
    "is_model_allowed",
    "set_default_model",
]

"""
Mapping of the errors of an LLM call to HTTP errors.
"""

import logging

import requests
from fastapi import HTTPException

from .base import LLMProviderError
from .json_response import UnusableResponseError
from .model_access import ModelAccessDenied
from .rate_limit import LLMRateLimitError, rate_limit_http_error

logger = logging.getLogger(__name__)


def _upstream_error_message(error: requests.RequestException) -> str:
    """The provider's own error message if the failed response carries one, else the exception text."""
    if error.response is not None:
        try:
            message = error.response.json().get("error", {}).get("message")
        except (ValueError, AttributeError):
            message = None
        if isinstance(message, str) and message:
            return message
    return str(error)


def llm_http_error(error: Exception, provider_id: str) -> HTTPException | None:
    """
    The HTTPException for an error raised by an LLM call, or None if the error is not one of an
    LLM call (the caller re-raises it). Provider failures are logged.

    Args:
        error: The caught exception.
        provider_id: The id of the provider, for the log.
    """
    if isinstance(error, ModelAccessDenied):
        return HTTPException(status_code=403, detail=str(error))
    if isinstance(error, UnusableResponseError):
        return HTTPException(status_code=502, detail=str(error))
    if isinstance(error, LLMRateLimitError):
        return rate_limit_http_error(error)
    if isinstance(error, LLMProviderError):
        logger.warning(f"LLM provider '{provider_id}' failed: {error}")
        return HTTPException(status_code=502, detail=f"LLM provider request failed: {error}")
    if isinstance(error, requests.RequestException):
        logger.warning(f"LLM provider '{provider_id}' request failed: {error}")
        return HTTPException(status_code=502, detail=f"LLM provider request failed: {_upstream_error_message(error)}")
    return None

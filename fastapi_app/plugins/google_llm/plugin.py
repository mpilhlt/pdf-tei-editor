"""
Google Gemini LLM provider plugin.

Registers a GoogleLLMProvider into the core LLM provider registry
(fastapi_app/lib/llm/) so Gemini models are selectable anywhere the
registry is consumed (e.g. the annotation-review plugin), following the
same registration lifecycle as fastapi_app/plugins/kisski/plugin.py. This
plugin has no menu endpoints of its own - it only contributes a connector
to the registry.
"""

import logging
import os
from typing import Any, Callable

from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config

from .llm_provider import GoogleLLMProvider

logger = logging.getLogger(__name__)


class GoogleLLMPlugin(Plugin):
    """Plugin that registers Google's Gemini API as an LLM provider connector."""

    def __init__(self) -> None:
        get_plugin_config(
            "plugin.google-llm.api.key",
            "GEMINI_API_KEY",
            default=None,
            description="API key for Google's Gemini API (Google AI Studio)",
            masked=True,
        )

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "google-llm",
            "name": "Google Gemini",
            "description": "Registers Google's Gemini API as an LLM inference provider",
            "category": "inference",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {}

    @classmethod
    def is_available(cls) -> bool:
        """Check if the Google LLM provider is available (API key configured)."""
        return bool(get_config().get("plugin.google-llm.api.key"))

    async def initialize(self, context: PluginContext) -> None:
        """Register the Gemini LLM provider connector."""
        # Skip in test mode, mirroring KisskiPlugin's guard, so a live-network-
        # capable provider never silently registers during test runs.
        app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
        api_key = get_config().get("plugin.google-llm.api.key")
        if app_mode == "testing":
            logger.info("Google LLM provider not registered in testing mode")
        elif api_key:
            LLMProviderRegistry.get_instance().register(
                GoogleLLMProvider(id="google", label="Google Gemini", api_key=api_key)
            )
            logger.info("Google LLM provider registered")
        else:
            logger.warning("Google LLM provider not registered - missing API key")

    async def cleanup(self) -> None:
        """Unregister the Gemini LLM provider connector."""
        LLMProviderRegistry.get_instance().unregister("google")

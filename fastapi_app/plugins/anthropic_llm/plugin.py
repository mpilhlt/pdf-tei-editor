"""
Anthropic Claude LLM provider plugin.

Registers an AnthropicLLMProvider into the core LLM provider registry
(fastapi_app/lib/llm/) so Claude models are selectable anywhere the
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

from .llm_provider import AnthropicLLMProvider

logger = logging.getLogger(__name__)


class AnthropicLLMPlugin(Plugin):
    """Plugin that registers Anthropic's Claude API as an LLM provider connector."""

    def __init__(self) -> None:
        get_plugin_config(
            "plugin.anthropic-llm.api.key",
            "ANTHROPIC_API_KEY",
            default=None,
            description="API key for Anthropic's Claude API",
            masked=True,
        )
        get_plugin_config(
            "plugin.anthropic-llm.api.url",
            "ANTHROPIC_API_URL",
            default="https://api.anthropic.com/v1",
            description="Base URL for the Anthropic API",
        )

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "anthropic-llm",
            "name": "Anthropic Claude",
            "description": "Registers Anthropic's Claude API as an LLM inference provider",
            "category": "inference",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {}

    @classmethod
    def unavailable_reason(cls) -> str | None:
        return "API key not configured (plugin.anthropic-llm.api.key)"

    @classmethod
    def is_available(cls) -> bool:
        """Check if the Anthropic LLM provider is available (API key configured)."""
        return bool(get_config().get("plugin.anthropic-llm.api.key"))

    async def initialize(self, context: PluginContext) -> None:
        """Register the Claude LLM provider connector."""
        # Skip in test mode, mirroring KisskiPlugin's guard, so a live-network-
        # capable provider never silently registers during test runs.
        app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
        api_key = get_config().get("plugin.anthropic-llm.api.key")
        base_url = get_config().get("plugin.anthropic-llm.api.url")
        if app_mode == "testing":
            logger.info("Anthropic LLM provider not registered in testing mode")
        elif api_key:
            LLMProviderRegistry.get_instance().register(
                AnthropicLLMProvider(
                    id="anthropic", label="Anthropic Claude", api_key=api_key, base_url=base_url
                )
            )
            logger.info("Anthropic LLM provider registered")
        else:
            logger.warning("Anthropic LLM provider not registered - missing API key")

    async def cleanup(self) -> None:
        """Unregister the Claude LLM provider connector."""
        LLMProviderRegistry.get_instance().unregister("anthropic")

"""
TEI Annotator plugin.

Provides LLM-based annotation of <bibl> elements via the TEI Annotator webservice.
Exposes a "TEI Annotator" submenu in the frontend Tools menu through a frontend extension.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)


class TeiAnnotatorPlugin(Plugin):
    """Plugin that provides LLM-based annotation of <bibl> elements."""

    def __init__(self) -> None:
        # Config keys must be initialised in __init__ per project convention.
        get_plugin_config("tei-annotator.server.url",     "TEI_ANNOTATOR_SERVER_URL", default=None)
        get_plugin_config("tei-annotator.server.api-key", "TEI_ANNOTATOR_API_KEY",    default=None)
        get_plugin_config("tei-annotator.provider",       "TEI_ANNOTATOR_PROVIDER",   default=None)
        get_plugin_config("tei-annotator.model",          "TEI_ANNOTATOR_MODEL",      default=None)

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "tei-annotator",
            "name": "TEI Annotator",
            "description": "Annotates <bibl> elements using LLM inference via the TEI Annotator webservice",
            "category": "annotation",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    @classmethod
    def is_available(cls) -> bool:
        """Available when TEI_ANNOTATOR_SERVER_URL (or the config key) is set."""
        url = get_plugin_config(
            "tei-annotator.server.url",
            "TEI_ANNOTATOR_SERVER_URL",
            default=None,
        )
        return bool(url)

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension."""
        registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "tei-annotator.js"
        if extension_file.exists():
            registry.register_extension(extension_file, self.metadata["id"])
            logger.info("TEI Annotator frontend extension registered")
        else:
            logger.warning("TEI Annotator frontend extension not found at %s", extension_file)

    async def cleanup(self) -> None:
        pass

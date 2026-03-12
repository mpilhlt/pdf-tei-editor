"""
TEI Annotator plugin.

Registers TeiAnnotatorExtractor with the extraction registry and fetches
the available provider/model list from the annotator service at startup.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.plugins.tei_annotator.extractor import TeiAnnotatorExtractor

logger = logging.getLogger(__name__)


class TeiAnnotatorPlugin(Plugin):
    """Plugin that provides LLM-based re-annotation of GROBID training documents."""

    def __init__(self) -> None:
        # Config keys must be initialised in __init__ (not __init__.py) per project convention.
        get_plugin_config("tei-annotator.server.url",     "TEI_ANNOTATOR_SERVER_URL", default=None)
        get_plugin_config("tei-annotator.server.api-key", "TEI_ANNOTATOR_API_KEY",    default=None)

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "tei-annotator",
            "name": "TEI Annotator",
            "description": "Re-annotates GROBID training documents with LLM inference",
            "category": "extractor",
            "version": "1.0.0",
            "required_roles": ["user"],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        # This is an extractor-only plugin; no custom plugin endpoints are exposed.
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
        """Register the extractor and pre-fetch the provider/model list."""
        # Populate dynamic provider list from the annotator service.
        # Falls back to hardcoded gemini default if the service is unreachable.
        TeiAnnotatorExtractor._load_providers()

        registry = ExtractorRegistry.get_instance()
        registry.register(TeiAnnotatorExtractor)
        logger.info("TEI Annotator extractor registered")

    async def cleanup(self) -> None:
        """Unregister the extractor."""
        ExtractorRegistry.get_instance().unregister("tei-annotator")
        logger.info("TEI Annotator extractor unregistered")

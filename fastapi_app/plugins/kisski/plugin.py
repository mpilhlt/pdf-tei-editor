"""
KISSKI extractor plugin.

Registers the KisskiExtractor with the extraction registry.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.lib.extraction import ExtractorRegistry
from .extractor import KisskiExtractor

logger = logging.getLogger(__name__)


class KisskiPlugin(Plugin):
    """Plugin that provides KISSKI API-based text processing."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "kisski",
            "name": "KISSKI Extractor",
            "description": "Text processing using KISSKI Academic Cloud API",
            "category": "extractor",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": []  # No menu items - accessed via extraction API
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {}  # Extractor accessed via /api/v1/extract endpoint

    @classmethod
    def is_available(cls) -> bool:
        """Check if KISSKI extractor is available."""
        return KisskiExtractor.is_available()

    async def initialize(self, context: PluginContext) -> None:
        """Register the KISSKI extractor."""
        registry = ExtractorRegistry.get_instance()
        registry.register(KisskiExtractor)
        logger.info("KISSKI extractor plugin initialized")

    async def cleanup(self) -> None:
        """Unregister the KISSKI extractor."""
        registry = ExtractorRegistry.get_instance()
        registry.unregister("kisski-neural-chat")
        logger.info("KISSKI extractor plugin cleaned up")

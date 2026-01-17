"""
LLamore extractor plugin.

Registers the LLamoreExtractor with the extraction registry.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.lib.extraction import ExtractorRegistry
from .extractor import LLamoreExtractor

logger = logging.getLogger(__name__)


class LLamorePlugin(Plugin):
    """Plugin that provides LLamore-based extraction."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "llamore",
            "name": "LLamore Extractor",
            "description": "Extract references using LLamore with Gemini AI",
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
        """Check if LLamore extractor is available."""
        return LLamoreExtractor.is_available()

    async def initialize(self, context: PluginContext) -> None:
        """Register the LLamore extractor."""
        registry = ExtractorRegistry.get_instance()
        registry.register(LLamoreExtractor)
        logger.info("LLamore extractor plugin initialized")

    async def cleanup(self) -> None:
        """Unregister the LLamore extractor."""
        registry = ExtractorRegistry.get_instance()
        registry.unregister("llamore-gemini")
        logger.info("LLamore extractor plugin cleaned up")

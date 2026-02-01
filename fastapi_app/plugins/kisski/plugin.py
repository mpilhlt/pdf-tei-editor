"""
KISSKI extractor plugin.

Registers the KisskiExtractor with the extraction registry.
Provides PDF and text extraction endpoints using KISSKI Academic Cloud API.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.plugin_base import Plugin, PluginContext

from .extractor import KisskiExtractor

logger = logging.getLogger(__name__)


class KisskiPlugin(Plugin):
    """Plugin that provides KISSKI API-based text and PDF processing."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        pdf_support = KisskiExtractor.check_pdf_support()
        description = "Text and PDF processing using KISSKI Academic Cloud API"
        if not pdf_support:
            description += " (PDF support unavailable - install pdf2image and poppler)"

        return {
            "id": "kisski",
            "name": "KISSKI Extractor",
            "description": description,
            "category": "extractor",
            "version": "2.0.0",
            "required_roles": ["user"],
            "endpoints": [],
            "pdf_support": pdf_support,
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {}

    @classmethod
    def is_available(cls) -> bool:
        """Check if KISSKI extractor is available (API key configured)."""
        return KisskiExtractor.is_available()

    async def initialize(self, context: PluginContext) -> None:
        """Register the KISSKI extractor."""
        # Check and log PDF support status
        pdf_support = KisskiExtractor.check_pdf_support()
        if not pdf_support:
            logger.warning(
                "KISSKI plugin: PDF support not available. "
                "Install pdf2image and poppler for PDF extraction."
            )

        # Register extractor
        registry = ExtractorRegistry.get_instance()
        registry.register(KisskiExtractor)

        logger.info(
            f"KISSKI extractor plugin initialized (PDF support: {pdf_support})"
        )

    async def cleanup(self) -> None:
        """Unregister the KISSKI extractor."""
        registry = ExtractorRegistry.get_instance()
        registry.unregister("kisski-neural-chat")

        logger.info("KISSKI extractor plugin cleaned up")

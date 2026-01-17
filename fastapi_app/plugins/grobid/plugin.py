"""
GROBID extractor plugin.

Registers the GrobidTrainingExtractor with the extraction registry.
Provides a download endpoint for reviewers to download complete training packages.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.lib.extraction import ExtractorRegistry
from .extractor import GrobidTrainingExtractor

logger = logging.getLogger(__name__)


class GrobidPlugin(Plugin):
    """Plugin that provides GROBID-based extraction."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "grobid",
            "name": "GROBID Extractor",
            "description": "Extract training data using GROBID server",
            "category": "extractor",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "download_training",
                    "label": "Download GROBID Training Data",
                    "description": "Download complete GROBID training package with gold annotations",
                    "state_params": ["pdf"],
                    "required_roles": ["reviewer"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "download_training": self.download_training,
        }

    @classmethod
    def is_available(cls) -> bool:
        """Check if GROBID extractor is available."""
        return GrobidTrainingExtractor.is_available()

    async def initialize(self, context: PluginContext) -> None:
        """Register the GROBID extractor."""
        registry = ExtractorRegistry.get_instance()
        registry.register(GrobidTrainingExtractor)
        logger.info("GROBID extractor plugin initialized")

    async def cleanup(self) -> None:
        """Unregister the GROBID extractor."""
        registry = ExtractorRegistry.get_instance()
        registry.unregister("grobid-training")
        logger.info("GROBID extractor plugin cleaned up")

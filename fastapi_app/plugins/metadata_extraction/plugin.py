"""
Metadata Extraction Plugin.

Provides a route for extracting bibliographic metadata from PDFs and
a TEI wizard enhancement that enriches teiHeader elements with the result.
"""

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.plugins.tei_wizard.plugin import TeiWizardPlugin

logger = logging.getLogger(__name__)


class MetadataExtractionPlugin(Plugin):
    """Extracts bibliographic metadata and enriches TEI headers."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "metadata-extraction",
            "name": "Metadata Extraction",
            "description": "Extract bibliographic metadata from PDFs and enrich TEI headers",
            "category": "enhancement",
            "version": "1.0.0",
            "required_roles": ["*"],
            "endpoints": [],
            "dependencies": ["tei-wizard"],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    async def initialize(self, context: PluginContext) -> None:
        """Register the TEI header enrichment enhancement with tei-wizard."""
        tei_wizard = context.get_dependency("tei-wizard")
        if isinstance(tei_wizard, TeiWizardPlugin):
            enhancement_file = Path(__file__).parent / "enhancements" / "enrich-tei-header.js"
            if enhancement_file.exists():
                tei_wizard.register_enhancement(enhancement_file, self.metadata["id"])
            else:
                logger.warning(f"Enhancement file not found: {enhancement_file}")
        else:
            logger.warning("tei-wizard dependency not available")

"""
Metadata Extraction Plugin.

Provides a route for extracting bibliographic metadata from PDFs, an admin route
for backfilling missing metadata in all documents of a collection, and
a TEI wizard enhancement that enriches teiHeader elements with the result.
"""

import logging
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.plugins.tei_wizard.plugin import TeiWizardPlugin

logger = logging.getLogger(__name__)


class MetadataExtractionPlugin(Plugin):
    """Extracts bibliographic metadata and enriches TEI headers."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "metadata-extraction",
            "name": "Metadata Extraction",
            "description": "Extract bibliographic metadata from PDFs, enrich TEI headers and backfill missing metadata in collections",
            "category": "enhancement",
            "version": "1.1.0",
            # Restricts the menu entry to admins; the TEI wizard enhancement and the /extract
            # route are not affected by plugin roles and stay available to all users
            "required_roles": ["admin"],
            "endpoints": [
                {
                    "name": "backfill",
                    "label": "Backfill Missing Metadata",
                    "description": "Add missing bibliographic metadata and document language to all documents of the current collection",
                    "icon": "journal-plus",
                    "category": "collection",
                    "state_params": ["collection"],
                }
            ],
            "dependencies": ["tei-wizard"],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {"backfill": self.backfill}

    async def backfill(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        Open the backfill options dialog for the current collection.

        Args:
            context: Plugin context
            params: Parameters including 'collection'

        Returns:
            outputUrl pointing to the options page, or an error if no collection is selected
        """
        collection_id = params.get("collection")
        if not collection_id:
            return {"error": "Please select a collection first.", "notify": True}
        return {
            "outputUrl": f"/api/plugins/metadata-extraction/backfill/options?{urlencode({'collection': collection_id})}",
        }

    async def initialize(self, context: PluginContext) -> None:
        """Register the TEI header enrichment enhancement with tei-wizard."""
        tei_wizard = context.get_dependency("tei-wizard")
        if isinstance(tei_wizard, TeiWizardPlugin):
            self._wizard = tei_wizard
            enhancement_file = Path(__file__).parent / "enhancements" / "enrich-tei-header.js"
            if enhancement_file.exists():
                tei_wizard.register_enhancement(enhancement_file, self.metadata["id"])
            else:
                logger.warning(f"Enhancement file not found: {enhancement_file}")
        else:
            logger.debug("tei-wizard dependency not available")

    async def cleanup(self) -> None:
        """Remove the enhancement registered with tei-wizard."""
        wizard = getattr(self, "_wizard", None)
        if wizard is not None:
            wizard.unregister_enhancements(self.metadata["id"])
            self._wizard = None

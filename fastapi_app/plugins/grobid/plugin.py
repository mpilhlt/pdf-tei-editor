"""
GROBID extractor plugin.

Registers the GrobidTrainingExtractor with the extraction registry.
Provides a download endpoint for reviewers to download complete training packages.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.event_bus import get_event_bus
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
                    "description": "Download complete GROBID training package for a collection",
                    "state_params": ["collection"],
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
        """Check if GROBID server URL is configured."""
        from fastapi_app.lib.plugin_tools import get_plugin_config

        # Initialize config from env var if not set
        url = get_plugin_config(
            "grobid.server.url",
            "GROBID_SERVER_URL",
            default=""
        )
        return bool(url)

    async def initialize(self, context: PluginContext) -> None:
        """Register the GROBID extractor, event handlers, and frontend extensions."""
        from pathlib import Path

        registry = ExtractorRegistry.get_instance()
        registry.register(GrobidTrainingExtractor)

        # Register event handler for file deletion cache cleanup
        event_bus = get_event_bus()
        event_bus.on("file.deleted", self._on_file_deleted)

        # Register frontend extension
        from fastapi_app.lib.frontend_extension_registry import FrontendExtensionRegistry

        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "tei-xslt.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])
            logger.info("Registered TEI XSLT frontend extension")

        logger.info("GROBID extractor plugin initialized")

    async def cleanup(self) -> None:
        """Unregister the GROBID extractor and event handlers."""
        registry = ExtractorRegistry.get_instance()
        registry.unregister("grobid")

        # Unregister event handler
        event_bus = get_event_bus()
        event_bus.off("file.deleted", self._on_file_deleted)

        logger.info("GROBID extractor plugin cleaned up")

    async def _on_file_deleted(self, stable_id: str, **kwargs) -> None:
        """
        Clean up cached GROBID training data when a file is deleted.

        This handler is called when any file is deleted. It checks if the file
        was a PDF and removes any cached training data for that document.

        Args:
            stable_id: The stable_id of the deleted file
        """
        from fastapi_app.lib.dependencies import get_db
        from fastapi_app.lib.file_repository import FileRepository

        try:
            # Get file info to check if it was a PDF
            db = get_db()
            file_repo = FileRepository(db)
            file_info = file_repo.get_file_by_stable_id(stable_id)

            if not file_info or file_info.file_type != "pdf":
                return

            doc_id = file_info.doc_id
            if not doc_id:
                return

            # Check if any other TEI files still exist for this doc_id
            doc_files = file_repo.get_files_by_doc_id(doc_id)
            other_teis = [f for f in doc_files if f.file_type == "tei" and f.stable_id != stable_id and not f.deleted]

            if other_teis:
                # Other PDFs exist, don't delete cache
                return

            # Delete cached training data for this document
            from fastapi_app.plugins.grobid.cache import delete_cache_for_doc

            if delete_cache_for_doc(doc_id):
                logger.info(f"Deleted cached GROBID training data for {doc_id}")

        except Exception as e:
            logger.warning(f"Failed to clean up GROBID cache for {stable_id}: {e}")

    async def download_training(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Generate download URL for GROBID training package.

        Args:
            context: Plugin context
            params: Parameters including 'collection' (collection ID)

        Returns:
            downloadUrl pointing to the download route
        """
        collection = params.get("collection")
        if not collection:
            return {
                "error": "No collection selected",
                "message": "Please select a collection first.",
            }

        # Build download URL with optional parameters
        # no_progress=false enables SSE progress events for UI usage
        download_url = f"/api/plugins/grobid/download?collection={collection}&no_progress=false"

        # Add optional parameters if provided
        if params.get("gold_only"):
            download_url += "&gold_only=true"
        if params.get("force_refresh"):
            download_url += "&force_refresh=true"
        if params.get("flavor"):
            download_url += f"&flavor={params['flavor']}"

        return {
            "downloadUrl": download_url,
            "collection": collection,
        }

"""
Document Search plugin.

Provides full-text search across all documents accessible to the current user.
"""

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class DocumentSearchPlugin(Plugin):
    """Plugin that provides full-text search across accessible documents."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "document-search",
            "name": "Document Search",
            "description": "Search across all accessible documents",
            "category": "collection",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "search",
                    "label": "Search Documents",
                    "description": "Search documents by title, ID, or author",
                    "state_params": [],
                }
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {"search": self.search}

    async def initialize(self, context: PluginContext) -> None:
        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "document-search.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])
            logger.info("Registered document-search frontend extension")

    async def search(self, context: PluginContext, params: dict) -> dict:
        return {"outputUrl": "/api/plugins/document-search/view"}

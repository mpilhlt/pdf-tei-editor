"""
Annotation Progress Plugin.

This plugin provides an overview of annotation progress for documents in a collection
by analyzing revision information from TEI artifacts.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class AnnotationProgressPlugin(Plugin):
    """
    Plugin that generates annotation progress reports for collections.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "annotation-progress",
            "name": "Annotation Progress",
            "description": "View annotation progress in the current collection",
            "version": "1.0.0",
            "category": "collection",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "show_progress",
                    "label": "Show Annotation Progress",
                    "description": "Display annotation overview for current collection",
                    "state_params": ["collection", "variant"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "show_progress": self.show_progress,
        }

    async def show_progress(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Generate annotation progress report for current collection.

        Args:
            context: Plugin context
            params: Parameters including 'collection' and 'variant'

        Returns:
            outputUrl pointing to the view route
        """
        collection_id = params.get("collection")
        if not collection_id:
            return {
                "error": "No collection selected",
                "html": "<p>Please select a collection first.</p>",
            }

        variant_filter = params.get("variant")

        # Build URLs
        variant_param = f"&variant={variant_filter}" if variant_filter else ""
        view_url = f"/api/plugins/annotation-progress/view?collection={collection_id}{variant_param}"
        export_url = f"/api/plugins/annotation-progress/export?collection={collection_id}{variant_param}"

        return {
            "outputUrl": view_url,
            "exportUrl": export_url,
            "collection": collection_id,
            "variant": variant_filter or "all",
        }

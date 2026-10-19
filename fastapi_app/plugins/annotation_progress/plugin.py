"""
Annotation Progress Plugin.

This plugin provides an overview of annotation progress for documents in a collection
by analyzing revision information from TEI artifacts.
"""

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)


class AnnotationProgressPlugin(Plugin):
    """
    Plugin that generates annotation progress reports for collections.

    Also contributes a per-project progress box to the dashboard (if the dashboard
    plugin is active) through the frontend extension `annotation-progress-dashboard.js`.
    """

    def __init__(self):
        get_plugin_config(
            "plugin.annotation-progress.dashboard-threshold",
            "PLUGIN_ANNOTATION_PROGRESS_DASHBOARD_THRESHOLD",
            default="approved",
            description="Lifecycle status (from annotation.lifecycle.order) from which a document counts as done in the dashboard's progress box",
        )

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
                    "icon": "graph-up-arrow",
                    "state_params": ["collection", "variant"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "show_progress": self.show_progress,
        }

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension that contributes the dashboard progress box."""
        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "annotation-progress-dashboard.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])

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
                "error": "Please select a collection first.",
                "notify": True,
            }

        variant_filter = params.get("variant")

        if not variant_filter or variant_filter in ("all", "none"):
            return {
                "error": "Please select a specific variant before generating the annotation progress report.",
                "notify": True,
            }

        # Build URLs
        view_url = f"/api/plugins/annotation-progress/view?collection={collection_id}&variant={variant_filter}"
        export_url = f"/api/plugins/annotation-progress/export?collection={collection_id}&variant={variant_filter}"

        return {
            "outputUrl": view_url,
            "exportUrl": export_url,
            "collection": collection_id,
            "variant": variant_filter,
        }

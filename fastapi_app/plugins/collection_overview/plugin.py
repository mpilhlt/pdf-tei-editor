"""
Collection Coverage Overview Plugin.

Provides a cross-collection overview of gold-standard coverage and annotation
lifecycle progress for every collection/variant combination the current user
can access, with a one-click link into annotation-progress for each one.
"""

from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext


class CollectionOverviewPlugin(Plugin):
    """Plugin that generates a cross-collection annotation coverage overview."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "collection-overview",
            "name": "Collection Coverage Overview",
            "description": "Overview of gold-standard coverage and annotation progress across all accessible collections",
            "version": "1.0.0",
            "category": "collection",
            "required_roles": ["user"],
            "dependencies": ["annotation-progress"],
            "endpoints": [
                {
                    "name": "show_overview",
                    "label": "Show Collection Coverage",
                    "description": "Overview of gold-standard coverage and annotation progress across all accessible collections",
                    "icon": "pie-chart",
                    "state_params": [],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "show_overview": self.show_overview,
        }

    async def show_overview(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Return URLs for the coverage overview view and CSV export.

        This view is not scoped to the currently-open collection/document -
        it spans every collection the user can access - so no state params
        are read from `params`.
        """
        return {
            "outputUrl": "/api/plugins/collection-overview/view",
            "exportUrl": "/api/plugins/collection-overview/export",
        }

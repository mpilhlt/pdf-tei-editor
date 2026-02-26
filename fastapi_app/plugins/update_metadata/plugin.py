"""
Update Metadata Plugin

Provides functionality to update all TEI documents with complete bibliographic metadata
from DOI lookup using CrossRef/DataCite APIs.
"""

from typing import Any, Callable
from fastapi_app.lib.plugins.plugin_base import Plugin


class UpdateMetadataPlugin(Plugin):
    """Plugin for batch updating TEI metadata from DOI lookup."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "update-metadata",
            "name": "Update Metadata",
            "description": "Update TEI documents with complete bibliographic metadata from DOI lookup",
            "category": "admin",
            "version": "1.0.0",
            "required_roles": ["admin"],  # Admin-only access
            "endpoints": [
                {
                    "name": "update",
                    "label": "Update All Metadata",
                    "description": "Update all TEI files with metadata from CrossRef/DataCite",
                    "state_params": []  # No state parameters needed
                }
            ]
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return plugin endpoints."""
        return {
            "update": self.update
        }

    async def update(self, context, params: dict) -> dict:
        """
        Show metadata update options form.

        Args:
            context: Plugin context (user, app, etc.)
            params: Parameters from frontend

        Returns:
            Dict with outputUrl pointing to the options form route
        """
        return {
            "outputUrl": "/api/plugins/update-metadata/options",
            "message": "Configure metadata update options"
        }

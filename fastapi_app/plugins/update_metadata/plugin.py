"""
Update Metadata Plugin

Provides functionality to update all TEI documents with complete bibliographic metadata
from DOI lookup using CrossRef/DataCite APIs.
"""

from typing import Any
from fastapi_app.lib.plugin_base import Plugin


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

    def get_endpoints(self) -> dict[str, callable]:
        """Return plugin endpoints."""
        return {
            "update": self.update
        }

    async def update(self, context, params: dict) -> dict:
        """
        Execute metadata update and return URL to progress page.

        Args:
            context: Plugin context (user, app, etc.)
            params: Parameters from frontend

        Returns:
            Dict with outputUrl pointing to the update execution route
        """
        # Build URL to custom route
        force = params.get("force", False)
        limit = params.get("limit", None)

        # Build query parameters
        query_params = []
        if force:
            query_params.append("force=true")
        if limit:
            query_params.append(f"limit={limit}")

        query_string = "&".join(query_params) if query_params else ""
        update_url = f"/api/plugins/update-metadata/execute"
        if query_string:
            update_url += f"?{query_string}"

        return {
            "outputUrl": update_url,
            "message": "Metadata update started - this may take several minutes"
        }

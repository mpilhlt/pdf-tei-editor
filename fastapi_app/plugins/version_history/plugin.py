"""
Version History backend plugin.

Provides a version history view for the currently open TEI document
and allows reverting to any previous version.
"""

import logging
from typing import Any

from fastapi_app.lib.plugins.plugin_base import Plugin
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)


class VersionHistoryPlugin(Plugin):
    """
    Backend plugin that lists all previous versions of the current document
    and allows reverting to any of them.

    Reverts are non-destructive: a new version record is created with the
    content hash of the selected version, leaving all existing versions intact.
    """

    def __init__(self) -> None:
        get_plugin_config(
            "plugin.version-history.edit-log.max-entries",
            "VERSION_HISTORY_EDIT_LOG_MAX_ENTRIES",
            default=20,
            value_type="number",
        )

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "version-history",
            "name": "Version History",
            "description": "View and revert to previous versions of the current document",
            "version": "1.0.0",
            "category": "document",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "show",
                    "label": "Version History",
                    "description": "Show all versions of the current document",
                    "state_params": ["xml"],
                }
            ],
        }

    def get_endpoints(self) -> dict[str, Any]:
        return {"show": self.show}

    async def show(self, context: Any, params: dict[str, Any]) -> dict[str, Any]:
        """
        Return an outputUrl for the version history table.

        Args:
            context: Plugin execution context
            params: State parameters; expects ``xml`` (stable_id of current file)

        Returns:
            dict with ``outputUrl`` pointing to the version history view,
            or ``html`` with an error message if no document is open.
        """
        stable_id = params.get("xml")
        if not stable_id:
            return {"html": "<p>No document is currently open.</p>"}
        return {"outputUrl": f"/api/plugins/version-history/view?stable_id={stable_id}"}

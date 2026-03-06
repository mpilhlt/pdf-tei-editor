"""
Log Viewer Plugin.

Real-time log viewer that streams application logs to the browser via SSE.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class LogViewerPlugin(Plugin):
    """Plugin that provides a real-time log viewer for administrators."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "log-viewer",
            "name": "Log Viewer",
            "description": "View application logs in real-time",
            "version": "1.0.0",
            "category": "admin",
            "required_roles": ["admin"],
            "endpoints": [
                {
                    "name": "show_logs",
                    "label": "Show Logs",
                    "description": "Open real-time log viewer",
                    "state_params": [],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "show_logs": self.show_logs,
        }

    async def show_logs(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Open the log viewer page.

        Returns:
            outputUrl pointing to the view route
        """
        return {
            "outputUrl": "/api/plugins/log-viewer/static/view.html",
        }

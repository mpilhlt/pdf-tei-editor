"""
Dashboard Plugin.

Hosts the dashboard shown after login. The dashboard itself is implemented
in the frontend extension `extensions/dashboard.js`; other plugins contribute
boxes to it through the `dashboard.contributions` frontend extension point.
"""

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)


class DashboardPlugin(Plugin):
    """Plugin hosting the login dashboard that other plugins contribute to."""

    def __init__(self):
        get_plugin_config(
            "plugin.dashboard.show-on-login",
            "PLUGIN_DASHBOARD_SHOW_ON_LOGIN",
            default=True,
            value_type="boolean",
            description="Show the dashboard automatically after login (users can still open it from the user menu)",
        )

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "dashboard",
            "name": "Dashboard",
            "description": "Dashboard shown after login, with boxes contributed by other plugins",
            "category": "other",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension that renders the dashboard."""
        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "dashboard.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])
        logger.info("Dashboard plugin initialized")

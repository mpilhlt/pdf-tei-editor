"""
Active Sessions admin plugin.

Provides an admin view of all active user sessions with the ability
to remove individual sessions or end all sessions except the current one.
"""

from typing import Any

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext


class ActiveSessionsPlugin(Plugin):
    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "active-sessions",
            "name": "Active Sessions",
            "description": "View and manage active user sessions",
            "category": "admin",
            "version": "1.0.0",
            "required_roles": ["admin"],
            "endpoints": [
                {
                    "name": "execute",
                    "label": "Active Sessions",
                    "description": "View and manage active user sessions",
                    "state_params": [],
                }
            ],
        }

    def get_endpoints(self) -> dict[str, Any]:
        return {"execute": self.execute}

    async def execute(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        return {"outputUrl": "/api/plugins/active-sessions/view"}

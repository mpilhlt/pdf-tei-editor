"""
Fixture plugin for tests of the plugin manager (enable/disable with dependencies).

It has no side effects; test-dependent-plugin depends on test-base-plugin.
Available only in testing mode.
"""

import os
from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext


class TestDependentPlugin(Plugin):
    """Test Dependent Plugin (test fixture)."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "test-dependent-plugin",
            "name": "Test Dependent Plugin",
            "description": "Test fixture for plugin dependencies",
            "category": "test",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [
                {"name": "ping", "label": "Ping", "description": "Returns pong", "state_params": []}
            ],
            "dependencies": ["test-base-plugin"],
        }

    @classmethod
    def is_available(cls) -> bool:
        return os.environ.get("FASTAPI_APPLICATION_MODE", "development") == "testing"

    def get_endpoints(self) -> dict[str, Callable]:
        return {"ping": self.ping}

    async def ping(self, context: PluginContext, params: dict[str, Any]) -> dict[str, str]:
        return {"result": "pong"}

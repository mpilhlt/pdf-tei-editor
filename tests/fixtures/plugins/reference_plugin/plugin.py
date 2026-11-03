"""
Reference plugin for frontend extensions with HTML templates and a stylesheet.

Test fixture and reference implementation: it registers one frontend extension
(extensions/reference-dialog.js) whose UI is built from the HTML templates and the
stylesheet in templates/. It is available only in testing mode and hidden from the
plugin manager.
"""

import os
from pathlib import Path
from typing import Any, Callable

from fastapi_app.plugin_api import FrontendExtensionRegistry, Plugin, PluginContext


class ReferencePlugin(Plugin):
    """Reference plugin (test fixture) for extension templates."""

    __test__ = False  # Prevent pytest from collecting this class as a test suite

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "reference-plugin",
            "name": "Reference Plugin",
            "description": "Reference implementation of a frontend extension with HTML templates",
            "category": "test",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [],
            "hidden": True,
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    @classmethod
    def is_available(cls) -> bool:
        return os.environ.get("FASTAPI_APPLICATION_MODE", "development") == "testing"

    @classmethod
    def unavailable_reason(cls) -> str | None:
        return "Only available when FASTAPI_APPLICATION_MODE=testing"

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension. Its templates/ directory is found from the extension path."""
        extension_file = Path(__file__).parent / "extensions" / "reference-dialog.js"
        FrontendExtensionRegistry.get_instance().register_extension(extension_file, self.metadata["id"])

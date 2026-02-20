"""
TEI Wizard Enhancement Registry Plugin.

Serves as the central registry for TEI enhancement scripts. Other plugins
can declare this plugin as a dependency and register their enhancements
during initialization.
"""

import logging
from pathlib import Path
from typing import Any

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class TeiWizardPlugin(Plugin):
    """Central registry for TEI enhancement scripts."""

    def __init__(self):
        # Store registered enhancement files: list of (path, plugin_id) tuples
        self._enhancement_files: list[tuple[Path, str]] = []

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "tei-wizard",
            "name": "TEI Wizard Enhancements",
            "description": "TEI document enhancement registry",
            "category": "enhancement",
            "version": "1.0.0",
            "required_roles": ["*"],
            "endpoints": [],  # No menu entries, only API routes
        }

    def get_endpoints(self) -> dict[str, callable]:
        return {"list": self.list_enhancements}

    async def initialize(self, context: PluginContext) -> None:
        """Register default enhancements from this plugin's directory."""
        plugin_dir = Path(__file__).parent
        enhancements_dir = plugin_dir / "enhancements"

        # Auto-discover all .js enhancement files
        if enhancements_dir.is_dir():
            for file_path in sorted(enhancements_dir.glob("*.js")):
                self.register_enhancement(file_path, "tei-wizard")

    def register_enhancement(self, file_path: Path, plugin_id: str) -> None:
        """
        Register an enhancement file from a dependent plugin.

        Args:
            file_path: Path to the JavaScript enhancement file
            plugin_id: ID of the plugin registering the enhancement
        """
        if not file_path.exists():
            logger.warning(f"Enhancement file not found: {file_path}")
            return

        # Check for duplicates by filename
        existing = [f.name for f, _ in self._enhancement_files]
        if file_path.name in existing:
            logger.warning(
                f"Enhancement {file_path.name} already registered, "
                f"replacing with version from {plugin_id}"
            )
            self._enhancement_files = [
                (f, pid)
                for f, pid in self._enhancement_files
                if f.name != file_path.name
            ]

        self._enhancement_files.append((file_path, plugin_id))
        logger.info(f"Registered enhancement: {file_path.name} from {plugin_id}")

    def get_enhancement_files(self) -> list[tuple[Path, str]]:
        """Return all registered enhancement files."""
        return self._enhancement_files.copy()

    async def list_enhancements(self, context, params: dict) -> dict:
        """Return metadata for all registered enhancements."""
        return {
            "enhancements": [
                {"file": f.name, "plugin_id": pid}
                for f, pid in self._enhancement_files
            ]
        }

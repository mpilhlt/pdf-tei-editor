"""
Backup & Restore Plugin

Provides admin functionality to backup the complete application data directory
as a ZIP file and restore from a previously downloaded backup.
"""

from typing import Any, Callable
from fastapi_app.lib.plugin_base import Plugin


class BackupRestorePlugin(Plugin):
    """Plugin for backing up and restoring application data."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "backup-restore",
            "name": "Backup & Restore",
            "description": "Download or restore the complete application data directory",
            "category": "admin",
            "version": "1.0.0",
            "required_roles": ["admin"],
            "endpoints": [
                {
                    "name": "manage",
                    "label": "Backup & Restore",
                    "description": "Download a backup or restore from a ZIP file",
                    "state_params": [],
                }
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {
            "manage": self.manage,
        }

    async def manage(self, context, params: dict) -> dict:
        """Show the backup & restore UI."""
        return {
            "outputUrl": "/api/plugins/backup-restore/view",
        }

"""
Backup & Restore Plugin

Download or restore the complete application data directory as a ZIP file.
"""

from .plugin import BackupRestorePlugin
from .routes import router

plugin = BackupRestorePlugin()

__all__ = ["BackupRestorePlugin", "plugin", "router"]

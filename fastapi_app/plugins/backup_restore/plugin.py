"""
Backup & Restore Plugin

Provides functionality to backup the complete application data directory
as a ZIP file and restore from a previously downloaded backup. Access is
controlled by the independent `backup` and `restore` roles (`admin` and `*`
imply both).
"""

import asyncio
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from fastapi_jobqueue import JobContext

from fastapi_app.lib.jobs import job_file_url, job_output_dir, job_type, thread_callbacks
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.utils.data_utils import get_data_file_path, load_json_file, save_json_file

logger = logging.getLogger(__name__)

PLUGIN_ROLES = [
    {
        "id": "backup",
        "roleName": "Backup",
        "description": "Download backups of the application data (read access to all data)",
    },
    {
        "id": "restore",
        "roleName": "Restore",
        "description": "Restore the application data from a backup (replaces all data, equivalent to admin)",
    },
]


def ensure_roles(db_dir: Path) -> list[str]:
    """Append the plugin's roles to ``roles.json`` if missing (idempotent).

    Args:
        db_dir: Path to the db directory

    Returns:
        IDs of the roles that were added
    """
    roles_file = get_data_file_path(db_dir, "roles")
    if not roles_file.exists():
        return []
    roles = load_json_file(roles_file, create_if_missing=False)
    if not isinstance(roles, list):
        logger.warning(f"Unexpected format in {roles_file}, not adding backup/restore roles")
        return []
    existing = {r.get("id") for r in roles if isinstance(r, dict)}
    missing = [r for r in PLUGIN_ROLES if r["id"] not in existing]
    if missing:
        save_json_file(roles_file, roles + missing)
        logger.info(f"Added roles to {roles_file}: {[r['id'] for r in missing]}")
    return [r["id"] for r in missing]


BACKUP_JOB_TYPE = "backup-restore.backup"


async def run_backup(ctx: JobContext, params: Any) -> dict[str, Any]:
    """Create the backup ZIP in the job's output directory.

    Returns:
        `{"download": URL of the ZIP, "filename": str, "size": int, "sha256": str}`
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.plugins.plugin_manifest import get_pte_version
    from fastapi_app.plugins.backup_restore.archive import create_backup_zip

    data_root = get_settings().data_root
    pte_version = get_pte_version()
    if pte_version is None:
        logger.warning("Cannot determine the application version; the backup cannot be restored without editing its manifest")
    out_dir = job_output_dir(ctx.job_id)
    progress, _ = thread_callbacks(ctx.report_threadsafe, ctx.check_cancelled)
    try:
        zip_path, sha256 = await asyncio.to_thread(
            create_backup_zip, data_root, out_dir, pte_version, progress, ctx.check_cancelled
        )
    except BaseException:
        # Cancelled or failed: the partial ZIP is already deleted; do not leave an empty directory
        try:
            out_dir.rmdir()
        except OSError:
            pass
        raise
    filename = f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    final_path = zip_path.rename(out_dir / filename)
    return {
        "download": job_file_url(ctx.job_id, filename),
        "filename": filename,
        "size": final_path.stat().st_size,
        "sha256": sha256,
    }


def register_job_types() -> None:
    """Register the `backup-restore.backup` job type (idempotent: registering again replaces it)."""
    job_type(BACKUP_JOB_TYPE, title="Backup", roles=["admin", "backup"], max_concurrent=1)(run_backup)


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
            "required_roles": ["admin", "backup", "restore"],
            "protected": True,
            "endpoints": [
                {
                    "name": "manage",
                    "label": "Backup & Restore",
                    "description": "Download a backup or restore from a ZIP file",
                    "icon": "archive",
                    "url_openable": True,
                    "state_params": [],
                }
            ],
        }

    async def initialize(self, context: PluginContext) -> None:
        from fastapi_app.config import get_settings

        ensure_roles(get_settings().db_dir)
        register_job_types()

    def get_endpoints(self) -> dict[str, Callable]:
        return {
            "manage": self.manage,
        }

    async def manage(self, context, params: dict) -> dict:
        """Show the backup & restore UI."""
        return {
            "outputUrl": "/api/plugins/backup-restore/view",
        }

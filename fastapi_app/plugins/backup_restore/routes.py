"""
Custom routes for Backup & Restore plugin.

Provides endpoints for downloading a ZIP backup of the data directory
and restoring from an uploaded ZIP file.
"""

import asyncio
import logging
import os
import shutil
import signal
import tempfile
import time
import zipfile
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi_jobqueue import Job, JobManager, Principal
from fastapi_jobqueue.errors import JobNotFound
from starlette.background import BackgroundTask

from fastapi_app.lib.core.dependencies import (
    get_session_manager,
    get_sse_service,
    require_authenticated_user,
    require_session_id,
)
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.permissions.acl_utils import user_is_admin
from fastapi_app.lib.jobs import get_job_manager
from fastapi_app.lib.jobs.files import job_output_path
from fastapi_app.lib.core.data_restore import STAGING_DIR, RestoreError, stage_restore
from fastapi_app.lib.core.worker_recycle import can_recycle_workers, recycle_workers
from fastapi_app.lib.plugins.plugin_manifest import get_pte_version
from fastapi_app.lib.sse.sse_utils import broadcast_to_all_sessions, send_notification
from fastapi_app.plugins.backup_restore.archive import create_backup_zip
from fastapi_app.plugins.backup_restore.plugin import BACKUP_JOB_TYPE
from fastapi_app.plugins.backup_restore.manifest import (
    IncompatibleBackupError,
    check_compatible,
    read_backup_version,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/backup-restore", tags=["backup-restore"])

# Essential files that must be present in a restore ZIP
REQUIRED_FILES = {"db/users.json", "db/config.json"}
RECOMMENDED_FILES = {"db/metadata.db"}

# Seconds between staging a restore and restarting, so clients can show the maintenance notice
RESTART_DELAY_SECONDS = 10


BACKUP_ROLE = "backup"
RESTORE_ROLE = "restore"

# Roles granting access to each operation; `admin` and `*` imply both plugin roles
_ROLE_ALLOWED = {
    "view": {BACKUP_ROLE, RESTORE_ROLE},
    BACKUP_ROLE: {BACKUP_ROLE},
    RESTORE_ROLE: {RESTORE_ROLE},
}

# Serializes backup creation so overlapping requests do not double the I/O load
_backup_lock = asyncio.Lock()


def _schedule(delay: float, callback: Callable[[], object]) -> None:
    """Run a callback after a delay on the running event loop."""
    asyncio.get_running_loop().call_later(delay, callback)


def _user_has_role(user: dict, role: str) -> bool:
    """Whether the user may exercise the given plugin role (`backup` or `restore`)."""
    user_roles = user.get("roles", [])
    return "*" in user_roles or "admin" in user_roles or role in user_roles


def _authorize(operation: str, user: dict[str, Any]) -> None:
    """Verify that the user has a role that allows the operation.

    Args:
        operation: One of "view", "backup", "restore"
        user: Authenticated user

    Raises:
        HTTPException: 403 if no role of the user allows the operation
    """
    if not any(_user_has_role(user, role) for role in _ROLE_ALLOWED[operation]):
        raise HTTPException(status_code=403, detail=f"The '{operation}' role is required")


def _is_supervised() -> bool:
    """Detect whether the process is running under a supervisor that will restart it.

    Checks for:
    - Docker container (/.dockerenv)
    - Podman container (/run/.containerenv)
    - systemd (INVOCATION_ID env var)
    - Known supervisor parent processes on Linux (/proc/{ppid}/comm)
    - macOS launchd (ppid == 1)
    """
    # Container detection
    if Path("/.dockerenv").exists() or Path("/run/.containerenv").exists():
        return True

    # systemd detection
    if os.environ.get("INVOCATION_ID"):
        return True

    ppid = os.getppid()

    # Linux: check parent process name
    proc_comm = Path(f"/proc/{ppid}/comm")
    if proc_comm.exists():
        try:
            parent_name = proc_comm.read_text().strip()
            known_supervisors = {
                "systemd", "supervisord", "s6-svscan", "runsv",
                "init", "containerd-shim", "tini",
            }
            if parent_name in known_supervisors:
                return True
        except OSError:
            pass

    # macOS: launchd is always PID 1
    if hasattr(os, "uname") and os.uname().sysname == "Darwin" and ppid == 1:
        return True

    return False


@router.get("/view", response_class=HTMLResponse)
async def backup_restore_view(
    user: dict[str, Any] = Depends(require_authenticated_user),
):
    """Display the backup & restore UI, showing only the sections the user may use."""
    _authorize("view", user)

    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    html = load_plugin_html(__file__, "view.html")
    can_backup = "true" if _user_has_role(user, BACKUP_ROLE) else "false"
    can_restore = "true" if _user_has_role(user, RESTORE_ROLE) else "false"
    html = html.replace("__CAN_BACKUP__", can_backup).replace("__CAN_RESTORE__", can_restore)
    return HTMLResponse(content=html)


@router.post("/backup", status_code=202)
async def start_backup(
    user: dict[str, Any] = Depends(require_authenticated_user),
) -> Job:
    """Create a backup as a job (type `backup-restore.backup`) whose result carries the download URL.

    Backups queue one at a time. Poll `GET /api/v1/jobs/{id}`; the result is
    `{"download", "filename", "size", "sha256"}`.
    """
    _authorize(BACKUP_ROLE, user)
    return await get_job_manager().submit(BACKUP_JOB_TYPE, None, owner=user["username"])


async def _own_backup_job(job_id: str, user: dict[str, Any], manager: JobManager) -> Job:
    """Resolve a backup job of the user (admins may see all).

    Raises:
        HTTPException: 404 if the job does not exist or is not a backup job, 403 if the user may not see it
    """
    try:
        job = await manager.get(job_id)
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Backup not found")
    if job.type != BACKUP_JOB_TYPE:
        raise HTTPException(status_code=404, detail="Backup not found")
    principal = Principal(id=user["username"], is_admin=user_is_admin(user))
    if not manager.can_view(principal, job):
        raise HTTPException(status_code=403, detail="Not your backup")
    return job


# The status, cancel and file routes below are under /api/plugins/, which the plugin session cookie
# covers, so the page works even if the session header of its fetch() is missing, and the file
# streams to disk through a navigation instead of being held in the page's memory.


@router.get("/backup/{job_id}")
async def get_backup_status(
    job_id: str,
    user: dict[str, Any] = Depends(require_authenticated_user),
    manager: JobManager = Depends(get_job_manager),
) -> Job:
    """The state of a backup job (for the page's polling)."""
    _authorize(BACKUP_ROLE, user)
    return await _own_backup_job(job_id, user, manager)


@router.post("/backup/{job_id}/cancel")
async def cancel_backup(
    job_id: str,
    user: dict[str, Any] = Depends(require_authenticated_user),
    manager: JobManager = Depends(get_job_manager),
) -> Job:
    """Cancel a backup job."""
    _authorize(BACKUP_ROLE, user)
    job = await _own_backup_job(job_id, user, manager)
    return await manager.cancel(job.id)


@router.get("/backup/{job_id}/file")
async def get_backup_file(
    job_id: str,
    user: dict[str, Any] = Depends(require_authenticated_user),
    manager: JobManager = Depends(get_job_manager),
) -> FileResponse:
    """Stream the ZIP of a finished backup job (404 while it is not done)."""
    _authorize(BACKUP_ROLE, user)
    job = await _own_backup_job(job_id, user, manager)
    result = job.result
    filename = result.get("filename") if isinstance(result, dict) else None
    if job.status != "done" or not isinstance(filename, str):
        raise HTTPException(status_code=404, detail="The backup is not finished")
    path = job_output_path(job.id) / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="The backup file no longer exists")
    return FileResponse(path, media_type="application/zip", filename=filename)


@router.get("/download")
async def download_backup(
    user: dict[str, Any] = Depends(require_authenticated_user),
):
    """Download the `db/` and `files/` directories as a ZIP file.

    The ZIP is built on disk, SQLite databases are snapshotted consistently, and
    the response carries `X-Content-SHA256` for client-side verification. The ZIP
    records the application version in `backup-manifest.json`. Only
    one backup is created at a time; a concurrent request gets 409.
    """
    _authorize(BACKUP_ROLE, user)

    from fastapi_app.config import get_settings

    settings = get_settings()
    data_root = settings.data_root

    if not data_root.exists():
        raise HTTPException(status_code=404, detail="Data directory not found")

    if _backup_lock.locked():
        raise HTTPException(status_code=409, detail="Another backup is already in progress")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{timestamp}.zip"
    username = user.get("username", "unknown")

    async with _backup_lock:
        logger.info(f"Creating backup ZIP of {data_root} for user '{username}'")
        started = time.monotonic()
        pte_version = get_pte_version()
        if pte_version is None:
            logger.warning("Cannot determine the application version; the backup cannot be restored without editing its manifest")
        zip_path, sha256 = await asyncio.to_thread(create_backup_zip, data_root, settings.tmp_dir, pte_version)

    size = zip_path.stat().st_size
    logger.info(
        f"Backup ZIP created: {filename} ({size} bytes, {time.monotonic() - started:.1f}s) "
        f"for user '{username}'"
    )

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=filename,
        headers={"X-Content-SHA256": sha256},
        background=BackgroundTask(lambda: zip_path.unlink(missing_ok=True)),
    )


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(require_authenticated_user),
    session_id: str = Depends(require_session_id),
    session_manager: SessionManager = Depends(get_session_manager),
    sse_service=Depends(get_sse_service),
):
    """Upload a ZIP file to restore application data.

    Validates the ZIP contents, refuses backups of an incompatible application version (see
    fastapi_app.plugins.backup_restore.manifest) and stages them in ``<data>/.restore/`` (see
    fastapi_app.lib.core.data_restore). The restore is applied when the worker processes
    restart: on a server started by bin/start-prod the workers are replaced after a short
    delay, under another supervisor the process exits, otherwise the admin restarts manually.
    """
    _authorize(RESTORE_ROLE, user)
    logger.info(f"Restore requested by user '{user.get('username', 'unknown')}'")

    from fastapi_app.config import get_settings

    settings = get_settings()
    data_root = settings.data_root
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(dir=settings.tmp_dir, prefix="restore_", suffix=".zip", delete=False) as tmp:
        zip_path = Path(tmp.name)
        await asyncio.to_thread(shutil.copyfileobj, file.file, tmp, 1024 * 1024)
    try:
        if zip_path.stat().st_size == 0:
            raise HTTPException(status_code=400, detail="Empty file uploaded")

        # Validate ZIP
        try:
            with zipfile.ZipFile(zip_path) as zf:
                names = set(zf.namelist())
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="Invalid ZIP file")

        # Check for required files (handle both with and without leading data/ prefix)
        missing_required = []
        for req in REQUIRED_FILES:
            # Accept either "db/users.json" or "data/db/users.json" patterns
            if req not in names and f"data/{req}" not in names:
                missing_required.append(req)

        if missing_required:
            detail = f"ZIP is missing required files: {', '.join(missing_required)}"
            send_notification(sse_service, session_id, detail, "danger", "exclamation-octagon")
            raise HTTPException(status_code=400, detail=detail)

        # Warn about recommended files
        missing_recommended = []
        for rec in RECOMMENDED_FILES:
            if rec not in names and f"data/{rec}" not in names:
                missing_recommended.append(rec)

        if missing_recommended:
            warn_msg = f"ZIP is missing recommended files: {', '.join(missing_recommended)}"
            send_notification(sse_service, session_id, warn_msg, "warning", "exclamation-triangle")
            logger.warning(warn_msg)

        # Determine if ZIP contents are nested under a top-level directory
        # (e.g., "data/db/..." vs "db/..." directly)
        has_data_prefix = all(
            n.startswith("data/") or n == "data" for n in names if n.strip("/")
        )

        # Refuse backups of an incompatible application version
        try:
            with zipfile.ZipFile(zip_path) as zf:
                backup_version = read_backup_version(zf, "data" if has_data_prefix else None)
            check_compatible(backup_version, get_pte_version())
        except IncompatibleBackupError as e:
            logger.warning(f"Restore refused: {e}")
            send_notification(sse_service, session_id, str(e), "danger", "exclamation-octagon")
            raise HTTPException(status_code=400, detail=str(e))

        logger.info(f"Staging restore ZIP ({zip_path.stat().st_size} bytes) in {data_root / STAGING_DIR}")
        try:
            count = await asyncio.to_thread(stage_restore, zip_path, data_root, "data" if has_data_prefix else None)
        except RestoreError as e:
            send_notification(sse_service, session_id, str(e), "danger", "exclamation-octagon")
            raise HTTPException(status_code=400, detail=str(e))
        logger.info(f"Staged {count} files for restore")
    finally:
        zip_path.unlink(missing_ok=True)

    send_notification(
        sse_service, session_id,
        "Restore data extracted. Preparing server restart...",
        "success", "check-circle",
    )

    if can_recycle_workers():
        logger.info(f"Restarting the workers in {RESTART_DELAY_SECONDS} seconds to apply the restore")
        broadcast_to_all_sessions(
            sse_service=sse_service,
            session_manager=session_manager,
            event_type="maintenanceOn",
            data={"message": "Application restarting for data restore, please wait..."},
            logger=logger,
        )
        _schedule(RESTART_DELAY_SECONDS, recycle_workers)
        return JSONResponse({
            "status": "ok",
            "message": f"Restore data uploaded. Server will restart in {RESTART_DELAY_SECONDS} seconds.",
            "supervised": True,
        })

    supervised = _is_supervised()

    if supervised:
        logger.info("Supervised environment detected — scheduling server restart")

        # Broadcast maintenance mode to all clients
        broadcast_to_all_sessions(
            sse_service=sse_service,
            session_manager=session_manager,
            event_type="maintenanceOn",
            data={"message": "Application restarting for data restore, please wait..."},
            logger=logger,
        )

        # Schedule restart in background
        async def _delayed_restart():
            await asyncio.sleep(RESTART_DELAY_SECONDS)
            logger.info("Sending SIGTERM for data restore restart")
            os.kill(os.getpid(), signal.SIGTERM)

        asyncio.create_task(_delayed_restart())

        return JSONResponse({
            "status": "ok",
            "message": f"Restore data uploaded. Server will restart in {RESTART_DELAY_SECONDS} seconds.",
            "supervised": True,
        })
    else:
        logger.info("No supervisor detected — admin must restart manually")

        send_notification(
            sse_service, session_id,
            "Restore data saved. Please restart the server manually to apply.",
            "warning", "exclamation-triangle",
        )

        return JSONResponse({
            "status": "ok",
            "message": "Restore data saved. Please restart the server manually to apply the restore.",
            "supervised": False,
        })

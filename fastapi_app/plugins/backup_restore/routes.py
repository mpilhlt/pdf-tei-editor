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

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.background import BackgroundTask

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.core.data_restore import STAGING_DIR, RestoreError, stage_restore
from fastapi_app.lib.core.worker_recycle import can_recycle_workers, recycle_workers
from fastapi_app.lib.plugins.plugin_manifest import get_pte_version
from fastapi_app.lib.sse.sse_utils import broadcast_to_all_sessions, send_notification
from fastapi_app.plugins.backup_restore.archive import create_backup_zip
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


def _authenticate(operation, session_id, x_session_id, session_manager, auth_manager):
    """Authenticate the request and verify the role required for the operation.

    Args:
        operation: One of "view", "backup", "restore"
        session_id: Session ID from the query string
        x_session_id: Session ID from the X-Session-ID header
        session_manager: Session manager
        auth_manager: Auth manager

    Returns:
        Tuple of (session_id_value, user)
    """
    from fastapi_app.config import get_settings

    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    if not any(_user_has_role(user, role) for role in _ROLE_ALLOWED[operation]):
        raise HTTPException(status_code=403, detail=f"The '{operation}' role is required")

    return session_id_value, user


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
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Display the backup & restore UI, showing only the sections the user may use."""
    _, user = _authenticate("view", session_id, x_session_id, session_manager, auth_manager)

    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    html = load_plugin_html(__file__, "view.html")
    can_backup = "true" if _user_has_role(user, BACKUP_ROLE) else "false"
    can_restore = "true" if _user_has_role(user, RESTORE_ROLE) else "false"
    html = html.replace("__CAN_BACKUP__", can_backup).replace("__CAN_RESTORE__", can_restore)
    return HTMLResponse(content=html)


@router.get("/download")
async def download_backup(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Download the `db/` and `files/` directories as a ZIP file.

    The ZIP is built on disk, SQLite databases are snapshotted consistently, and
    the response carries `X-Content-SHA256` for client-side verification. The ZIP
    records the application version in `backup-manifest.json`. Only
    one backup is created at a time; a concurrent request gets 409.
    """
    _, user = _authenticate(BACKUP_ROLE, session_id, x_session_id, session_manager, auth_manager)

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
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    sse_service=Depends(get_sse_service),
):
    """Upload a ZIP file to restore application data.

    Validates the ZIP contents, refuses backups of an incompatible application version (see
    fastapi_app.plugins.backup_restore.manifest) and stages them in ``<data>/.restore/`` (see
    fastapi_app.lib.core.data_restore). The restore is applied when the worker processes
    restart: on a server started by bin/start-prod the workers are replaced after a short
    delay, under another supervisor the process exits, otherwise the admin restarts manually.
    """
    session_id_value, user = _authenticate(
        RESTORE_ROLE, session_id, x_session_id, session_manager, auth_manager
    )
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
            send_notification(sse_service, session_id_value, detail, "danger", "exclamation-octagon")
            raise HTTPException(status_code=400, detail=detail)

        # Warn about recommended files
        missing_recommended = []
        for rec in RECOMMENDED_FILES:
            if rec not in names and f"data/{rec}" not in names:
                missing_recommended.append(rec)

        if missing_recommended:
            warn_msg = f"ZIP is missing recommended files: {', '.join(missing_recommended)}"
            send_notification(sse_service, session_id_value, warn_msg, "warning", "exclamation-triangle")
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
            send_notification(sse_service, session_id_value, str(e), "danger", "exclamation-octagon")
            raise HTTPException(status_code=400, detail=str(e))

        logger.info(f"Staging restore ZIP ({zip_path.stat().st_size} bytes) in {data_root / STAGING_DIR}")
        try:
            count = await asyncio.to_thread(stage_restore, zip_path, data_root, "data" if has_data_prefix else None)
        except RestoreError as e:
            send_notification(sse_service, session_id_value, str(e), "danger", "exclamation-octagon")
            raise HTTPException(status_code=400, detail=str(e))
        logger.info(f"Staged {count} files for restore")
    finally:
        zip_path.unlink(missing_ok=True)

    send_notification(
        sse_service, session_id_value,
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
            sse_service, session_id_value,
            "Restore data saved. Please restart the server manually to apply.",
            "warning", "exclamation-triangle",
        )

        return JSONResponse({
            "status": "ok",
            "message": "Restore data saved. Please restart the server manually to apply the restore.",
            "supervised": False,
        })

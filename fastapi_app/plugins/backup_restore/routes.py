"""
Custom routes for Backup & Restore plugin.

Provides endpoints for downloading a ZIP backup of the data directory
and restoring from an uploaded ZIP file.
"""

import asyncio
import io
import logging
import os
import shutil
import signal
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.sse_utils import broadcast_to_all_sessions, send_notification

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/backup-restore", tags=["backup-restore"])

# Essential files that must be present in a restore ZIP
REQUIRED_FILES = {"db/users.json", "db/config.json"}
RECOMMENDED_FILES = {"db/metadata.db"}


def _get_project_root() -> Path:
    """Return the project root directory."""
    return Path(__file__).resolve().parent.parent.parent.parent


def _authenticate_admin(session_id, x_session_id, session_manager, auth_manager):
    """Authenticate request and verify admin role.

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

    user_roles = user.get("roles", [])
    if "admin" not in user_roles and "*" not in user_roles:
        raise HTTPException(status_code=403, detail="Admin access required")

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
    if os.uname().sysname == "Darwin" and ppid == 1:
        return True

    return False


@router.get("/view", response_class=HTMLResponse)
async def backup_restore_view(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Display the backup & restore UI."""
    _authenticate_admin(session_id, x_session_id, session_manager, auth_manager)

    from fastapi_app.lib.plugin_tools import load_plugin_html

    html = load_plugin_html(__file__, "view.html")
    return HTMLResponse(content=html)


@router.get("/download")
async def download_backup(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Download the data directory as a ZIP file."""
    session_id_value, _ = _authenticate_admin(
        session_id, x_session_id, session_manager, auth_manager
    )

    from fastapi_app.config import get_settings

    settings = get_settings()
    data_root = settings.data_root

    if not data_root.exists():
        raise HTTPException(status_code=404, detail="Data directory not found")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{timestamp}.zip"

    logger.info(f"Creating backup ZIP of {data_root} for admin user")

    # Only include db/ and files/ subdirectories
    backup_dirs = [data_root / "db", data_root / "files"]

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for backup_dir in backup_dirs:
            if not backup_dir.exists():
                continue
            for file_path in sorted(backup_dir.rglob("*")):
                if file_path.is_file():
                    rel_path = file_path.relative_to(data_root)
                    zf.write(file_path, str(rel_path))

    buffer.seek(0)
    size = buffer.getbuffer().nbytes
    logger.info(f"Backup ZIP created: {filename} ({size} bytes)")

    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(size),
        },
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

    Validates the ZIP contents, extracts to data_restore/, and optionally
    triggers a server restart if running under a supervisor.
    """
    session_id_value, _ = _authenticate_admin(
        session_id, x_session_id, session_manager, auth_manager
    )

    # Read uploaded file
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file uploaded")

    # Validate ZIP
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Invalid ZIP file")

    names = set(zf.namelist())

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

    # Extract to data_restore/
    project_root = _get_project_root()
    restore_dir = project_root / "data_restore"

    # Clean up any previous restore attempt
    if restore_dir.exists():
        shutil.rmtree(restore_dir)

    restore_dir.mkdir(parents=True)

    logger.info(f"Extracting restore ZIP ({len(content)} bytes) to {restore_dir}")

    if has_data_prefix:
        # ZIP contains "data/..." structure — extract and strip the prefix
        for member in zf.namelist():
            if not member.startswith("data/"):
                continue
            rel = member[len("data/"):]
            if not rel:
                continue
            target = restore_dir / rel
            if member.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as dst:
                    dst.write(src.read())
    else:
        # ZIP contains direct structure (db/, files/, etc.)
        zf.extractall(restore_dir)

    zf.close()

    send_notification(
        sse_service, session_id_value,
        "Restore data extracted. Preparing server restart...",
        "success", "check-circle",
    )

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
            await asyncio.sleep(10)
            logger.info("Sending SIGTERM for data restore restart")
            os.kill(os.getpid(), signal.SIGTERM)

        asyncio.create_task(_delayed_restart())

        return JSONResponse({
            "status": "ok",
            "message": "Restore data uploaded. Server will restart in 10 seconds.",
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

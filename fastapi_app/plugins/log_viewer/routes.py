"""
Custom routes for Log Viewer plugin.
"""

import logging
from collections import deque
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_session_manager,
)
from fastapi_app.lib.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)

# Default number of log lines to return
DEFAULT_INITIAL_LINES = 1000

router = APIRouter(prefix="/api/plugins/log-viewer", tags=["log-viewer"])


def _require_admin(session_id, x_session_id, session_manager, auth_manager):
    """Authenticate and require admin role. Returns (user, session_id)."""
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

    return user, session_id_value


@router.post("/subscribe")
async def subscribe_to_logs(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Subscribe session to receive log events via SSE."""
    from fastapi_app.lib.logging_utils import get_sse_log_handler

    _user, session_id_value = _require_admin(
        session_id, x_session_id, session_manager, auth_manager
    )

    handler = get_sse_log_handler()
    if not handler:
        raise HTTPException(status_code=503, detail="SSE log handler not initialized")

    handler.subscribe_session(session_id_value)
    return {"status": "subscribed"}


@router.post("/unsubscribe")
async def unsubscribe_from_logs(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Unsubscribe session from log events."""
    from fastapi_app.lib.logging_utils import get_sse_log_handler

    _user, session_id_value = _require_admin(
        session_id, x_session_id, session_manager, auth_manager
    )

    handler = get_sse_log_handler()
    if handler:
        handler.unsubscribe_session(session_id_value)

    return {"status": "unsubscribed"}


def _read_last_n_lines(file_path: Path, n: int) -> list[str]:
    """Read the last n lines from a file efficiently using a deque."""
    if not file_path.exists():
        return []
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            return list(deque(f, maxlen=n))
    except OSError:
        return []


@router.get("/recent")
async def get_recent_logs(
    lines: int | None = Query(None, description="Number of lines to return"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Get the most recent log lines from the application log file."""
    from fastapi_app.config import get_settings

    _require_admin(session_id, x_session_id, session_manager, auth_manager)

    # Get configured line count or use provided/default
    if lines is None:
        lines = get_plugin_config(
            "plugin.log-viewer.initial-lines",
            "PLUGIN_LOG_VIEWER_INITIAL_LINES",
            default=DEFAULT_INITIAL_LINES,
            value_type="number",
        )

    settings = get_settings()
    raw_lines = _read_last_n_lines(settings.app_log_file, lines)

    # Parse log lines into structured format matching SSE format
    # Format: "2026-02-06 21:06:30.036 [INFO    ] logger.name - message"
    import re
    log_pattern = re.compile(
        r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+'  # timestamp
        r'\[(\w+)\s*\]\s+'  # level in brackets
        r'(\S+)\s+-\s+'  # logger name
        r'(.*)$'  # message
    )

    entries = []
    for line in raw_lines:
        line = line.rstrip("\n")
        if not line:
            continue
        match = log_pattern.match(line)
        if match:
            entries.append({
                "timestamp": match.group(1),
                "level": match.group(2).strip(),
                "logger": match.group(3),
                "message": match.group(4),
            })
        else:
            # Fallback for non-standard log lines
            entries.append({
                "timestamp": "",
                "logger": "",
                "level": "INFO",
                "message": line,
            })

    return {"entries": entries, "count": len(entries)}


VALID_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}


@router.post("/level")
async def set_log_level(
    level: str = Query(..., description="Log level to set (DEBUG, INFO, WARNING, ERROR, CRITICAL)"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Set the application log level."""
    _require_admin(session_id, x_session_id, session_manager, auth_manager)

    level = level.upper()
    if level not in VALID_LOG_LEVELS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid log level. Must be one of: {', '.join(VALID_LOG_LEVELS)}"
        )

    # Set the root logger level
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, level))

    # Also update handlers
    for handler in root_logger.handlers:
        handler.setLevel(getattr(logging, level))

    logger.info(f"Log level changed to {level}")
    return {"status": "ok", "level": level}

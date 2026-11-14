"""
Custom routes for Log Viewer plugin.
"""

import logging
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from fastapi_app.lib.core.dependencies import require_admin_user, require_session_id
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)

# Default number of log lines to return
DEFAULT_INITIAL_LINES = 1000

router = APIRouter(prefix="/api/plugins/log-viewer", tags=["log-viewer"])


@router.post("/subscribe")
async def subscribe_to_logs(
    user: dict[str, Any] = Depends(require_admin_user),
    session_id: str = Depends(require_session_id),
):
    """Subscribe session to receive log events via SSE."""
    from fastapi_app.lib.utils.logging_utils import get_sse_log_handler

    handler = get_sse_log_handler()
    if not handler:
        raise HTTPException(status_code=503, detail="SSE log handler not initialized")

    handler.subscribe_session(session_id)
    return {"status": "subscribed"}


@router.post("/unsubscribe")
async def unsubscribe_from_logs(
    user: dict[str, Any] = Depends(require_admin_user),
    session_id: str = Depends(require_session_id),
):
    """Unsubscribe session from log events."""
    from fastapi_app.lib.utils.logging_utils import get_sse_log_handler

    handler = get_sse_log_handler()
    if handler:
        handler.unsubscribe_session(session_id)

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
    user: dict[str, Any] = Depends(require_admin_user),
):
    """Get the most recent log lines from the application log file."""
    from fastapi_app.config import get_settings

    # Get configured line count or use provided/default
    if lines is None:
        lines = get_plugin_config(
            "plugin.log-viewer.initial-lines",
            "PLUGIN_LOG_VIEWER_INITIAL_LINES",
            default=DEFAULT_INITIAL_LINES,
            value_type="number",
            description="Number of log lines returned by the log viewer on initial load",
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
    user: dict[str, Any] = Depends(require_admin_user),
):
    """Set the application log level."""
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

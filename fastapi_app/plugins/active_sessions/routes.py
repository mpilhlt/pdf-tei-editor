"""
Custom routes for Active Sessions admin plugin.
"""

import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_session_manager,
    get_sse_service,
    require_admin_user,
    require_session_id,
)
from fastapi_app.lib.utils.auth import AuthManager
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.sse.sse_service import SSEService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/active-sessions", tags=["active-sessions"])

FORCE_LOGOUT_MESSAGE = "Your session was ended by an administrator."


class RemoveSessionRequest(BaseModel):
    target_session_id: str
    message: str = FORCE_LOGOUT_MESSAGE


class RemoveAllSessionsRequest(BaseModel):
    message: str = FORCE_LOGOUT_MESSAGE


def _format_age(created_at: float) -> str:
    """Format session age as a human-readable string."""
    delta = datetime.now() - datetime.fromtimestamp(created_at)
    total_seconds = int(delta.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}h {minutes}m"
    if minutes > 0:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def _format_last_access(last_access: float) -> str:
    """Format last access time as a human-readable string."""
    delta = datetime.now() - datetime.fromtimestamp(last_access)
    total_seconds = int(delta.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}h {minutes}m"
    if minutes > 0:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"



@router.get("/view", response_class=HTMLResponse)
async def view_sessions(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> HTMLResponse:
    """
    Serve the active sessions HTML page (sandbox client injected automatically).
    """
    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    sid_value = x_session_id or session_id
    if not sid_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(sid_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(sid_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    user_roles = user.get("roles", [])
    if "admin" not in user_roles and "*" not in user_roles:
        raise HTTPException(status_code=403, detail="Admin access required")

    html = load_plugin_html(__file__, "view.html")
    return HTMLResponse(content=html)


@router.get("/data")
async def get_sessions_data(
    session_id: str = Depends(require_session_id),
    _user: dict = Depends(require_admin_user),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> dict[str, list[list[str]]]:
    """
    Return sessions as a DataTables-compatible JSON object.
    """
    sessions = session_manager.get_all_sessions()
    rows = []

    for s in sessions:
        sid = s["session_id"]
        abbrev = sid[:8] + "..."
        age = _format_age(s["created_at"])
        last_access = _format_last_access(s["last_access"])

        user_data = auth_manager.get_user_by_username(s["username"]) or {}
        fullname = user_data.get("fullname") or s["username"]
        owner = f"{fullname} ({s['username']})"

        is_current = sid == session_id
        if is_current:
            action = '<button disabled style="opacity:0.5;cursor:not-allowed;padding:4px 10px;">Remove</button>'
        else:
            safe_sid = sid.replace("'", "\\'")
            action = (
                f'<button onclick="removeSession(\'{safe_sid}\')" '
                f'style="padding:4px 10px;background:#d9534f;color:white;border:none;'
                f'border-radius:3px;cursor:pointer;">Remove</button>'
            )

        rows.append([abbrev, age, last_access, owner, action])

    return {"data": rows}


@router.post("/remove")
async def remove_session(
    body: RemoveSessionRequest,
    session_id: str = Depends(require_session_id),
    _user: dict = Depends(require_admin_user),
    session_manager: SessionManager = Depends(get_session_manager),
    sse_service: SSEService = Depends(get_sse_service),
) -> dict[str, str]:
    """
    Remove a single session. Sends a forceLogout SSE event before deleting.
    """
    target = body.target_session_id

    if target == session_id:
        raise HTTPException(status_code=400, detail="Cannot remove your own session")

    sse_service.send_message(target, "forceLogout", json.dumps({"message": body.message or FORCE_LOGOUT_MESSAGE}))
    session_manager.delete_session(target)

    logger.info(f"Admin removed session {target[:8]}...")
    return {"status": "removed"}


@router.post("/remove-all")
async def remove_all_sessions(
    body: RemoveAllSessionsRequest | None = None,
    session_id: str = Depends(require_session_id),
    _user: dict = Depends(require_admin_user),
    session_manager: SessionManager = Depends(get_session_manager),
    sse_service: SSEService = Depends(get_sse_service),
) -> dict[str, str | int]:
    """
    Remove all sessions except the current one. Sends forceLogout SSE to each before deleting.
    """
    sessions = session_manager.get_all_sessions()
    count = 0
    message = (body.message if body else None) or FORCE_LOGOUT_MESSAGE

    for s in sessions:
        if s["session_id"] == session_id:
            continue
        sse_service.send_message(s["session_id"], "forceLogout", json.dumps({"message": message}))
        session_manager.delete_session(s["session_id"])
        count += 1

    logger.info(f"Admin ended {count} session(s) via remove-all")
    return {"status": "removed", "count": count}

"""
Custom routes for Log Viewer plugin.
"""

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_session_manager,
)

logger = logging.getLogger(__name__)

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

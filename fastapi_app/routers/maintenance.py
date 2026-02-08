"""
Maintenance endpoints for remote UI control via SSE.

Provides admin-only endpoints to broadcast maintenance events to all connected
clients (show blocking spinner, remove it, force page reload).
"""

from typing import Dict

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..lib.dependencies import (
    get_session_manager,
    get_sse_service,
    require_admin_user,
)
from ..lib.logging_utils import get_logger
from ..lib.sessions import SessionManager
from ..lib.sse_service import SSEService
from ..lib.sse_utils import broadcast_to_all_sessions

logger = get_logger(__name__)

router = APIRouter(prefix="/maintenance", tags=["maintenance"])


class MaintenanceOnRequest(BaseModel):
    message: str = "System maintenance in progress, please wait..."


@router.post("/on")
async def maintenance_on(
    body: MaintenanceOnRequest,
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
    user: Dict = Depends(require_admin_user),
):
    """Enable maintenance mode: show a blocking spinner on all clients."""
    count = broadcast_to_all_sessions(
        sse_service=sse_service,
        session_manager=session_manager,
        event_type="maintenanceOn",
        data={"message": body.message},
        logger=logger,
    )
    return {"status": "ok", "clients_notified": count}


class MaintenanceOffRequest(BaseModel):
    message: str | None = None


@router.post("/off")
async def maintenance_off(
    body: MaintenanceOffRequest = MaintenanceOffRequest(),
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
    user: Dict = Depends(require_admin_user),
):
    """Disable maintenance mode: remove the blocking spinner on all clients."""
    data = {}
    if body.message:
        data["message"] = body.message
    count = broadcast_to_all_sessions(
        sse_service=sse_service,
        session_manager=session_manager,
        event_type="maintenanceOff",
        data=data,
        logger=logger,
    )
    return {"status": "ok", "clients_notified": count}


@router.post("/reload")
async def maintenance_reload(
    sse_service: SSEService = Depends(get_sse_service),
    session_manager: SessionManager = Depends(get_session_manager),
    user: Dict = Depends(require_admin_user),
):
    """Force all clients to reload the page."""
    count = broadcast_to_all_sessions(
        sse_service=sse_service,
        session_manager=session_manager,
        event_type="maintenanceReload",
        data={},
        logger=logger,
    )
    return {"status": "ok", "clients_notified": count}

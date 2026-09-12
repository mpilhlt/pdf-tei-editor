"""
Custom routes for the Collection Coverage Overview plugin.
"""

import csv
import io
import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_session_manager,
)
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.utils.auth import AuthManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/collection-overview", tags=["collection-overview"])


def _authenticate(
    session_id: str | None,
    x_session_id: str | None,
    session_manager: SessionManager,
    auth_manager: AuthManager,
) -> dict:
    """Shared auth check for this plugin's routes. Raises HTTPException on failure."""
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

    return user


def _resolve_accessible_collections(user: dict[str, Any]) -> list[dict[str, str]]:
    """Collections (id + name) the given user can access, per project membership."""
    from fastapi_app.config import get_settings
    from fastapi_app.lib.permissions.user_utils import get_user_collections
    from fastapi_app.lib.utils.collection_utils import list_collections

    settings = get_settings()
    all_collections = list_collections(settings.db_dir)
    accessible_ids = get_user_collections(user, settings.db_dir)

    if accessible_ids is None:
        return [{"id": c["id"], "name": c.get("name") or c["id"]} for c in all_collections]

    accessible_set = set(accessible_ids)
    return [
        {"id": c["id"], "name": c.get("name") or c["id"]}
        for c in all_collections
        if c["id"] in accessible_set
    ]


def _build_rows(db: DatabaseManager, user: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """Resolve accessible collections and build overview rows for them."""
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.services.statistics import build_overview_rows
    from fastapi_app.lib.utils.config_utils import get_config

    file_repo = FileRepository(db)
    lifecycle_order = get_config().get("annotation.lifecycle.order", default=[])
    collections = _resolve_accessible_collections(user)
    rows = build_overview_rows(file_repo, collections, lifecycle_order)
    return rows, lifecycle_order


@router.get("/view", response_class=HTMLResponse)
async def view_overview(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
):
    """Serve the coverage overview page shell (data is fetched client-side from /data)."""
    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    _authenticate(session_id, x_session_id, session_manager, auth_manager)

    html = load_plugin_html(__file__, "view.html")
    return HTMLResponse(content=html)


@router.get("/data")
async def get_overview_data(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
    db: DatabaseManager = Depends(get_db),
):
    """Return the collection x variant overview rows as JSON for the view page."""
    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)

    try:
        rows, lifecycle_order = _build_rows(db, user)
    except Exception as e:
        logger.error(f"Failed to build collection overview data: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "lifecycle_order": lifecycle_order,
        "rows": [
            {
                "collection_id": r["collection_id"],
                "collection_name": r["collection_name"],
                "variant": r["variant"],
                "total_docs": r["total_docs"],
                "gold_count": r["gold_count"],
                "avg_progress": r["avg_progress"],
                "stage_counts": r["stage_counts"],
            }
            for r in rows
        ],
    }


@router.get("/export")
async def export_csv(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
    db: DatabaseManager = Depends(get_db),
):
    """Export the full (unfiltered) overview as CSV."""
    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)

    try:
        rows, lifecycle_order = _build_rows(db, user)
    except Exception as e:
        logger.error(f"Failed to build collection overview export: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Collection ID", "Collection Name", "Variant", "Documents",
        "Gold Standard Count", "Gold Standard %", "Avg Progress %", "Dominant Stage",
    ])
    for r in rows:
        gold_pct = round((r["gold_count"] / r["total_docs"]) * 100) if r["total_docs"] else 0
        dominant = ""
        best_count = 0
        for stage in lifecycle_order:
            count = r["stage_counts"].get(stage, 0)
            if count > best_count:
                best_count = count
                dominant = stage
        writer.writerow([
            r["collection_id"],
            r["collection_name"],
            r["variant"] or "",
            r["total_docs"],
            r["gold_count"],
            gold_pct,
            round(r["avg_progress"], 1),
            dominant,
        ])

    output.seek(0)
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="collection-coverage-overview.csv"'},
    )

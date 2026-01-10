"""
Custom routes for Local Sync plugin.
"""

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_session_manager,
    get_sse_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/local-sync", tags=["local-sync"])


@router.get("/preview", response_class=HTMLResponse)
async def preview_sync(
    collection: str = Query(..., description="Collection ID"),
    variant: str = Query("all", description="Variant filter"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    Preview sync changes without applying them.

    Args:
        collection: Collection ID to sync
        variant: Variant filter
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        HTML page with preview of changes
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.user_utils import user_has_collection_access
    from fastapi_app.lib.config_utils import get_config

    # Extract session ID (header takes precedence)
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Validate session
    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # Get user
    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Check collection access
    if not user_has_collection_access(user, collection, settings.db_dir):
        raise HTTPException(status_code=403, detail="Access denied to collection")

    try:
        # Get configuration
        config = get_config()
        repo_path = config.get("plugin.local-sync.repo.path")
        backup_enabled = config.get("plugin.local-sync.backup", default=True)

        if not repo_path:
            return HTMLResponse(content="<p>Error: Repository path not configured</p>")

        repo_path_obj = Path(repo_path)
        if not repo_path_obj.exists():
            return HTMLResponse(content=f"<p>Error: Repository path does not exist: {repo_path}</p>")

        # Run sync in dry-run mode
        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        # Create a simple context object for the plugin
        class SimpleContext:
            pass

        context = SimpleContext()
        context.user = user

        results = await plugin._sync_collection(
            collection, variant, repo_path_obj, backup_enabled, dry_run=True, context=context
        )

        # Generate HTML report with details
        html = plugin._generate_detailed_report_html(results, collection, variant, is_preview=True)

        return HTMLResponse(content=html)

    except Exception as e:
        logger.error(f"Failed to preview sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/execute", response_class=HTMLResponse)
async def execute_sync(
    collection: str = Query(..., description="Collection ID"),
    variant: str = Query("all", description="Variant filter"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    sse_service=Depends(get_sse_service),
):
    """
    Execute sync changes.

    Args:
        collection: Collection ID to sync
        variant: Variant filter
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        HTML page with sync results (statistics only)
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.user_utils import user_has_collection_access
    from fastapi_app.lib.config_utils import get_config

    # Extract session ID (header takes precedence)
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Validate session
    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # Get user
    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Check collection access
    if not user_has_collection_access(user, collection, settings.db_dir):
        raise HTTPException(status_code=403, detail="Access denied to collection")

    try:
        # Get configuration
        config = get_config()
        repo_path = config.get("plugin.local-sync.repo.path")
        backup_enabled = config.get("plugin.local-sync.backup", default=True)

        if not repo_path:
            return HTMLResponse(content="<p>Error: Repository path not configured</p>")

        repo_path_obj = Path(repo_path)
        if not repo_path_obj.exists():
            return HTMLResponse(content=f"<p>Error: Repository path does not exist: {repo_path}</p>")

        # Run sync in execute mode
        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        # Create a simple context object for the plugin
        class SimpleContext:
            pass

        context = SimpleContext()
        context.user = user

        results = await plugin._sync_collection(
            collection, variant, repo_path_obj, backup_enabled, dry_run=False, context=context
        )

        # Notify all sessions about collection updates if any occurred
        updated_count = len(results.get("updated_collection", []))
        logger.debug(f"Sync complete: {updated_count} files updated in collection")

        if updated_count > 0:
            from fastapi_app.lib.sse_utils import broadcast_to_all_sessions
            logger.debug(f"Broadcasting fileDataChanged event to all sessions")
            notified = broadcast_to_all_sessions(
                sse_service=sse_service,
                session_manager=session_manager,
                event_type="fileDataChanged",
                data={
                    "reason": "local_sync",
                    "collection": collection,
                    "count": updated_count
                },
                logger=logger
            )
            logger.debug(f"Broadcast sent to {notified} sessions")
        else:
            logger.debug("No collection updates, skipping broadcast")

        # Generate HTML report with statistics only
        html = plugin._generate_summary_report_html(results, is_preview=False)

        return HTMLResponse(content=html)

    except Exception as e:
        logger.error(f"Failed to execute sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))

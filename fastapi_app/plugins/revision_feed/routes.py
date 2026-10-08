"""Custom routes for the Revision Feed plugin."""

import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
)
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.auth import AuthManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/revision-feed", tags=["revision-feed"])


def _authenticate(
    session_id: str | None,
    x_session_id: str | None,
    session_manager: SessionManager,
    auth_manager: AuthManager,
) -> dict[str, Any]:
    """Shared session-based auth check for the management endpoints."""
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


def _feed_urls_for_user(user: dict[str, Any], token: str, request: Request) -> list[dict[str, str]]:
    from fastapi_app.config import get_settings
    from fastapi_app.lib.utils.project_utils import get_projects_with_details, get_user_projects

    settings = get_settings()
    if "*" in user.get("roles", []):
        projects = get_projects_with_details(settings.db_dir)
    else:
        projects = get_user_projects(user, settings.db_dir)
    base = str(request.base_url).rstrip("/")

    return [
        {
            "project_id": project["id"],
            "project_name": project.get("name") or project["id"],
            "url": f"{base}/api/plugins/revision-feed/feed/{project['id']}.atom?token={token}",
        }
        for project in projects
    ]


@router.get("/my-feeds")
async def my_feeds(
    request: Request,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> dict[str, Any]:
    """Return the user's feed token and feed URLs for every project they belong to."""
    from fastapi_app.config import get_settings
    from fastapi_app.plugins.revision_feed.token_store import get_or_create_token

    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)
    settings = get_settings()
    token = get_or_create_token(user["username"], settings.plugins_data_dir)

    return {"token": token, "feeds": _feed_urls_for_user(user, token, request)}


@router.post("/token/regenerate")
async def regenerate_token_endpoint(
    request: Request,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> dict[str, Any]:
    """Issue a new feed token for the user, invalidating the previous one."""
    from fastapi_app.config import get_settings
    from fastapi_app.plugins.revision_feed.token_store import regenerate_token

    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)
    settings = get_settings()
    token = regenerate_token(user["username"], settings.plugins_data_dir)

    return {"token": token, "feeds": _feed_urls_for_user(user, token, request)}


@router.get("/feed/{project_id}.atom")
async def project_feed(
    project_id: str,
    request: Request,
    token: str = Query(...),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> Response:
    """Public Atom feed of qualifying revisionDesc changes for one project."""
    from fastapi_app.config import get_settings
    from fastapi_app.lib.permissions.user_utils import user_has_collection_access
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.utils.config_utils import get_config
    from fastapi_app.lib.utils.project_utils import find_project, get_projects_with_details
    from fastapi_app.plugins.revision_feed.revisions import (
        RevisionEntry,
        build_atom_feed,
        extract_revision_entries,
    )
    from fastapi_app.plugins.revision_feed.token_store import resolve_token

    settings = get_settings()

    username = resolve_token(token, settings.plugins_data_dir)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid feed token")

    user = auth_manager.get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid feed token")

    projects = get_projects_with_details(settings.db_dir)
    project = find_project(project_id, projects)
    if not project:
        raise HTTPException(status_code=403, detail="Project not found or access denied")

    collections = project.get("collections", [])
    has_access = any(
        user_has_collection_access(user, collection_id, settings.db_dir)
        for collection_id in collections
    )
    if not has_access:
        raise HTTPException(status_code=403, detail="Project not found or access denied")

    included_statuses = get_config().get("plugin.revision-feed.included-statuses", default=[])

    file_repo = FileRepository(db)
    all_entries: list[RevisionEntry] = []
    for collection_id in collections:
        for file_metadata in file_repo.get_files_by_collection(collection_id):
            if file_metadata.file_type != "tei":
                continue
            content_bytes = file_storage.read_file(file_metadata.id, "tei")
            if not content_bytes:
                continue
            try:
                xml_content = content_bytes.decode("utf-8")
                doc_label = file_metadata.label or file_metadata.doc_id
                all_entries.extend(
                    extract_revision_entries(
                        xml_content,
                        stable_id=file_metadata.stable_id,
                        doc_label=doc_label,
                        collection_id=collection_id,
                        included_statuses=included_statuses,
                    )
                )
            except Exception:
                logger.exception(f"Failed to parse revisions for file {file_metadata.stable_id}")
                continue

    atom_xml = build_atom_feed(
        project_id=project_id,
        project_name=project.get("name") or project_id,
        feed_url=str(request.url),
        entries=all_entries,
        app_base_url=str(request.base_url),
    )

    return Response(content=atom_xml, media_type="application/atom+xml")

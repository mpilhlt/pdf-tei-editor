"""Custom routes for the Recent Documents plugin."""

import logging
from typing import Any

from fastapi import APIRouter, Depends

from fastapi_app.lib.core.dependencies import get_file_repository, require_authenticated_user
from fastapi_app.lib.repository.file_repository import FileRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/recent-documents", tags=["recent-documents"])

# Maximum number of documents listed per project
DOCUMENTS_PER_PROJECT = 5


@router.get("/recent")
async def recent_documents(
    user: dict[str, Any] = Depends(require_authenticated_user),
    file_repo: FileRepository = Depends(get_file_repository),
) -> dict[str, list[dict[str, Any]]]:
    """Return, per project, the documents the user edited last.

    Each project lists up to five documents (one entry per document, the most recently
    edited TEI file), newest first. A document is listed only once, under the most specific
    project containing it (fewest collections, wildcard projects last). Projects are sorted
    by their most recent edit; projects without edits are omitted.
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.utils.project_utils import get_archived_collection_ids, get_visible_projects
    from fastapi_app.plugins.dashboard.documents import (
        DocumentInfoResolver,
        project_includes,
        project_specificity,
    )
    from fastapi_app.plugins.recent_documents.edit_store import get_user_edits

    settings = get_settings()
    projects = sorted(get_visible_projects(user, settings.db_dir), key=project_specificity)
    resolver = DocumentInfoResolver(file_repo, get_archived_collection_ids(settings.db_dir))
    lists: dict[str, list[dict[str, Any]]] = {project["id"]: [] for project in projects}
    seen_docs: set[str] = set()

    for stable_id, edited_at in get_user_edits(user["username"], settings.plugins_data_dir):
        tei_file = file_repo.get_file_by_stable_id(stable_id)
        if tei_file is None or tei_file.file_type != "tei" or tei_file.doc_id in seen_docs:
            continue
        if resolver.is_archived(tei_file):
            continue
        seen_docs.add(tei_file.doc_id)
        entry = {**resolver.entry(tei_file), "edited_at": edited_at}
        project = next((p for p in projects if project_includes(p, entry["collections"])), None)
        if project is not None and len(lists[project["id"]]) < DOCUMENTS_PER_PROJECT:
            lists[project["id"]].append(entry)

    result = [
        {"id": project["id"], "name": project.get("name") or project["id"], "documents": lists[project["id"]]}
        for project in projects
        if lists[project["id"]]
    ]
    result.sort(key=lambda project: project["documents"][0]["edited_at"], reverse=True)
    return {"projects": result}

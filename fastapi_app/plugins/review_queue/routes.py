"""Custom routes for the Review Queue plugin."""

import logging
from typing import Any

from fastapi import APIRouter, Depends

from fastapi_app.lib.core.dependencies import get_file_repository, require_authenticated_user
from fastapi_app.lib.repository.file_repository import FileRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/review-queue", tags=["review-queue"])


@router.get("/documents")
async def review_queue_documents(
    user: dict[str, Any] = Depends(require_authenticated_user),
    file_repo: FileRepository = Depends(get_file_repository),
) -> dict[str, Any]:
    """Return the accessible documents whose status is one of `plugin.review-queue.statuses`.

    A document (per variant) is listed if its most recently updated TEI file has one of the
    statuses, so documents that moved on in a newer version are not listed. Newest first,
    each with the name of the most specific project that contains it. Documents of archived
    projects are not listed. Users without the reviewer or admin role get an empty list.
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.permissions.acl_utils import user_has_reviewer_role, user_is_admin
    from fastapi_app.lib.utils.config_utils import get_config
    from fastapi_app.lib.utils.project_utils import get_archived_collection_ids, get_visible_projects
    from fastapi_app.plugins.dashboard.documents import (
        DocumentInfoResolver,
        project_includes,
        project_specificity,
    )

    settings = get_settings()
    statuses = get_config().get("plugin.review-queue.statuses", default=["in-review"]) or []
    if not (user_has_reviewer_role(user) or user_is_admin(user)):
        return {"statuses": statuses, "documents": []}
    projects = sorted(get_visible_projects(user, settings.db_dir), key=project_specificity)
    resolver = DocumentInfoResolver(file_repo, get_archived_collection_ids(settings.db_dir))

    documents: list[dict[str, Any]] = []
    seen: set[tuple[str, str | None]] = set()
    for tei_file in file_repo.get_tei_files_by_status(statuses):
        key = (tei_file.doc_id, tei_file.variant)
        if key in seen or resolver.is_archived(tei_file):
            continue
        seen.add(key)
        latest = max(
            (f for f in file_repo.get_files_by_doc_id(tei_file.doc_id) if f.file_type == "tei" and f.variant == tei_file.variant),
            key=lambda f: f.updated_at,
            default=tei_file,
        )
        if latest.stable_id != tei_file.stable_id:
            continue
        entry = resolver.entry(tei_file)
        project = next((p for p in projects if project_includes(p, entry["collections"])), None)
        if project is None:
            continue
        documents.append({
            **entry,
            "project": project.get("name") or project["id"],
            "updated_at": tei_file.updated_at.isoformat(),
        })

    return {"statuses": statuses, "documents": documents}

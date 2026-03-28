"""
Custom routes for the Version History plugin.
"""

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_session_manager,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/version-history", tags=["version-history"])


def _authenticate(session_id_value: str | None, session_manager, auth_manager):
    """
    Validate session and return the authenticated user.

    Args:
        session_id_value: Session ID string, or None
        session_manager: Session manager instance
        auth_manager: Auth manager instance

    Returns:
        Authenticated user object

    Raises:
        HTTPException: 401 if session is missing, invalid, or user not found
    """
    from fastapi_app.config import get_settings

    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


def _fmt_dt(value) -> str:
    """Format a datetime or string value as a human-readable string."""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value) if value else ""


@router.get("/view", response_class=HTMLResponse)
async def view_versions(
    stable_id: str = Query(..., description="Stable ID of the currently open file"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    db=Depends(get_db),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> HTMLResponse:
    """
    Render the version history page for a TEI file.

    Renders two tables:
    - **Numbered versions**: all version records sharing the same doc_id and variant,
      ordered by updated_at descending. Each row (except the current version) has a
      "Revert to this state" button that creates a new numbered version.
    - **Edit history**: edit log entries for the current stable_id, ordered by saved_at
      descending. Each row has a "Restore this edit" button that creates a new numbered
      version from the stored content.

    Args:
        stable_id: Stable ID of the currently open TEI file
        session_id: Session ID from query parameter
        x_session_id: Session ID from header (takes precedence)
        db: Database manager dependency
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        HTML page with two DataTables-powered tables
    """
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.plugins.plugin_tools import generate_datatable_page, escape_html

    session_id_value = x_session_id or session_id
    _authenticate(session_id_value, session_manager, auth_manager)

    try:
        file_repo = FileRepository(db)

        current_file = file_repo.get_file_by_stable_id(stable_id)
        if not current_file:
            raise HTTPException(status_code=404, detail=f"File not found: {stable_id}")

        doc_title = escape_html(current_file.label or current_file.doc_id)

        # ── Numbered versions table ────────────────────────────────────────────
        versions = file_repo.get_all_versions(current_file.doc_id, variant=current_file.variant)

        version_rows = []
        for v in sorted(versions, key=lambda x: x.updated_at, reverse=True):
            is_current = v.stable_id == stable_id
            if is_current:
                action_cell = '<em style="color:#888;">current</em>'
            else:
                action_cell = (
                    f'<button onclick="revertVersion(this,{escape_html(repr(v.stable_id))},{escape_html(repr(stable_id))})" '
                    f'style="cursor:pointer;padding:2px 8px;">Revert to this state</button>'
                )
            version_rows.append([
                str(v.version or ""),
                escape_html(v.label or ""),
                escape_html(v.status or ""),
                escape_html(_fmt_dt(v.updated_at)),
                escape_html(v.last_revision or ""),
                action_cell,
            ])

        # ── Edit history table ─────────────────────────────────────────────────
        edit_log = file_repo.get_edit_log(stable_id)

        edit_rows = []
        for entry in edit_log:
            short_hash = escape_html(entry["content_hash"][:12] + "…")
            entry_hash = entry["content_hash"]
            action_cell = (
                f'<button onclick="restoreEdit(this,{escape_html(repr(stable_id))},{escape_html(repr(entry_hash))})" '
                f'style="cursor:pointer;padding:2px 8px;">Restore this edit</button>'
            )
            edit_rows.append([
                escape_html(_fmt_dt(entry["saved_at"])),
                escape_html(entry["saved_by"] or ""),
                f'<code title="{escape_html(entry["content_hash"])}">{short_hash}</code>',
                action_cell,
            ])

        # ── JavaScript ────────────────────────────────────────────────────────
        custom_js = """
window.revertVersion = function(btn, targetStableId, currentStableId) {
    btn.disabled = true;
    btn.textContent = 'Reverting\u2026';
    sandbox.callPluginApi('/api/plugins/version-history/revert', 'POST', {
        stable_id: currentStableId,
        target_stable_id: targetStableId
    }).then(function(result) {
        sandbox.openDocument(result.new_stable_id);
    }).catch(function(e) {
        alert('Revert failed: ' + (e.message || e));
        btn.disabled = false;
        btn.textContent = 'Revert to this state';
    });
};

window.restoreEdit = function(btn, stableId, contentHash) {
    btn.disabled = true;
    btn.textContent = 'Restoring\u2026';
    sandbox.callPluginApi('/api/plugins/version-history/revert-edit', 'POST', {
        stable_id: stableId,
        content_hash: contentHash
    }).then(function(result) {
        sandbox.openDocument(result.new_stable_id);
    }).catch(function(e) {
        alert('Restore failed: ' + (e.message || e));
        btn.disabled = false;
        btn.textContent = 'Restore this edit';
    });
};
"""

        custom_css = """
#versionHistoryTable td:last-child,
#editHistoryTable td:last-child { white-space: nowrap; }
h2 { margin: 1.5em 0 0.5em; font-size: 1.1em; color: #333; }
"""

        # Build edit history section as extra_content for a single page
        # We generate the full page with the versions table, then insert the
        # edit history table via extra_content_before_table on a second call
        # and stitch the <body> contents together.

        edit_section_html = ""
        if edit_rows:
            import re
            edit_page = generate_datatable_page(
                title="",
                headers=["Saved at", "Saved by", "Content hash", "Action"],
                rows=edit_rows,
                table_id="editHistoryTable",
                page_length=25,
                default_sort_col=0,
                default_sort_dir="desc",
                enable_sandbox_client=False,
                extra_content_before_table='<h2>Edit History (in-place saves for this version)</h2>',
            )
            # Extract just the body content (table + surrounding divs)
            body_match = re.search(r'<body>(.*?)</body>', edit_page, re.DOTALL)
            if body_match:
                edit_section_html = body_match.group(1)

        html = generate_datatable_page(
            title=f"Version History \u2014 {doc_title}",
            headers=["Version", "Label", "Status", "Last edit", "Last revision", "Action"],
            rows=version_rows,
            table_id="versionHistoryTable",
            page_length=25,
            default_sort_col=3,
            default_sort_dir="desc",
            enable_sandbox_client=True,
            custom_js=custom_js,
            custom_css=custom_css,
            extra_content_before_table='<h2>Numbered Versions</h2>',
        )

        # Inject the edit history section before </body>
        if edit_section_html:
            html = html.replace("</body>", edit_section_html + "</body>")

        return HTMLResponse(content=html)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate version history view: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class RevertRequest(BaseModel):
    """Request body for the revert-version endpoint."""

    stable_id: str
    target_stable_id: str


class RevertEditRequest(BaseModel):
    """Request body for the revert-edit endpoint."""

    stable_id: str
    content_hash: str


def _create_new_version_from_hash(
    file_repo,
    current_stable_id: str,
    content_hash: str,
    username: str | None,
) -> str:
    """
    Create a new numbered version record reusing content_hash.

    Args:
        file_repo: FileRepository instance
        current_stable_id: Stable ID of the current file (provides doc_id, variant, collections)
        content_hash: Content hash to use for the new version
        username: Username of the requesting user

    Returns:
        stable_id of the newly created version

    Raises:
        HTTPException: 404 if file not found, 500 if creation fails
    """
    from fastapi_app.lib.models.models import FileCreate

    current_file = file_repo.get_file_by_stable_id(current_stable_id)
    if not current_file:
        raise HTTPException(status_code=404, detail=f"File not found: {current_stable_id}")

    versions = file_repo.get_all_versions(current_file.doc_id, variant=current_file.variant)
    max_version = max((v.version for v in versions if v.version is not None), default=0)
    new_version = max_version + 1

    file_create = FileCreate(
        id=content_hash,
        filename=current_file.filename,
        doc_id=current_file.doc_id,
        doc_id_type="custom",
        file_type="tei",
        file_size=current_file.file_size,
        label=current_file.label,
        variant=current_file.variant,
        status=current_file.status,
        last_revision=current_file.last_revision,
        version=new_version,
        is_gold_standard=False,
        doc_collections=current_file.doc_collections,
        doc_metadata=current_file.doc_metadata,
        file_metadata=current_file.file_metadata,
        created_by=username,
    )

    file_repo.insert_file(file_create)

    versions_after = file_repo.get_all_versions(current_file.doc_id, variant=current_file.variant)
    new_file = next((v for v in versions_after if v.version == new_version), None)
    if not new_file:
        raise HTTPException(status_code=500, detail="Failed to retrieve the newly created version")

    return new_file.stable_id


@router.post("/revert")
async def revert_to_version(
    request: RevertRequest,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    db=Depends(get_db),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict[str, str]:
    """
    Create a new version whose content matches a previous numbered version.

    The new record gets ``version = max_version + 1`` and reuses the content
    hash of the target version. All existing versions remain intact, so the
    operation is reversible by running the plugin again.

    Args:
        request: ``stable_id`` (current file) and ``target_stable_id`` (version to restore)
        session_id: Session ID from query parameter
        x_session_id: Session ID from header (takes precedence)
        db: Database manager dependency
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        ``{"new_stable_id": "<stable_id>"}`` of the newly created version

    Raises:
        HTTPException: 400 if files belong to different documents or variants,
                       404 if a file is not found, 500 on unexpected errors
    """
    from fastapi_app.lib.repository.file_repository import FileRepository

    session_id_value = x_session_id or session_id
    user = _authenticate(session_id_value, session_manager, auth_manager)

    try:
        file_repo = FileRepository(db)

        target_file = file_repo.get_file_by_stable_id(request.target_stable_id)
        if not target_file:
            raise HTTPException(
                status_code=404, detail=f"Target file not found: {request.target_stable_id}"
            )

        current_file = file_repo.get_file_by_stable_id(request.stable_id)
        if not current_file:
            raise HTTPException(
                status_code=404, detail=f"Current file not found: {request.stable_id}"
            )

        if current_file.doc_id != target_file.doc_id:
            raise HTTPException(status_code=400, detail="Files belong to different documents")
        if current_file.variant != target_file.variant:
            raise HTTPException(status_code=400, detail="Files have different variants")

        new_stable_id = _create_new_version_from_hash(
            file_repo,
            current_stable_id=request.stable_id,
            content_hash=target_file.id,
            username=getattr(user, "username", None),
        )
        return {"new_stable_id": new_stable_id}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to revert to version: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/revert-edit")
async def revert_to_edit(
    request: RevertEditRequest,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    db=Depends(get_db),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict[str, str]:
    """
    Create a new numbered version from a content hash stored in the edit log.

    Verifies that the content_hash appears in the edit log for stable_id and that
    the physical file still exists in storage before creating the new version.

    Args:
        request: ``stable_id`` and ``content_hash`` of the edit log entry to restore
        session_id: Session ID from query parameter
        x_session_id: Session ID from header (takes precedence)
        db: Database manager dependency
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        ``{"new_stable_id": "<stable_id>"}`` of the newly created version

    Raises:
        HTTPException: 400 if content_hash is not in the edit log for this stable_id,
                       404 if file not found or physical file missing, 500 on errors
    """
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.storage.file_storage import FileStorage
    from fastapi_app.config import get_settings

    session_id_value = x_session_id or session_id
    user = _authenticate(session_id_value, session_manager, auth_manager)

    try:
        file_repo = FileRepository(db)

        # Verify the hash belongs to the edit log for this stable_id
        edit_log = file_repo.get_edit_log(request.stable_id)
        known_hashes = {entry["content_hash"] for entry in edit_log}
        if request.content_hash not in known_hashes:
            raise HTTPException(
                status_code=400,
                detail="content_hash not found in edit log for this file",
            )

        # Verify physical file still exists
        current_file = file_repo.get_file_by_stable_id(request.stable_id)
        if not current_file:
            raise HTTPException(status_code=404, detail=f"File not found: {request.stable_id}")

        settings = get_settings()
        storage = FileStorage(settings.data_root / "files", db, logger)
        if not storage.file_exists(request.content_hash, current_file.file_type):
            raise HTTPException(
                status_code=404,
                detail="Physical file for this edit no longer exists in storage",
            )

        new_stable_id = _create_new_version_from_hash(
            file_repo,
            current_stable_id=request.stable_id,
            content_hash=request.content_hash,
            username=getattr(user, "username", None),
        )
        return {"new_stable_id": new_stable_id}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to restore edit: {e}")
        raise HTTPException(status_code=500, detail=str(e))

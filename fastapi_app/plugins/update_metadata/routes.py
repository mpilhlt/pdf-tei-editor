"""
Custom routes for Update Metadata plugin.

Provides options form, metadata update endpoint with SSE progress tracking,
and cancellation support.
"""

import asyncio
import logging
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.sse.sse_utils import ProgressBar, send_notification
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.services.metadata_update_utils import update_tei_metadata

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/update-metadata", tags=["update-metadata"])

# Cancellation token storage
_cancellation_tokens: dict[str, bool] = {}


class CancellationToken:
    """Cooperative cancellation token for long-running operations."""

    def __init__(self, progress_id: str):
        self.progress_id = progress_id
        _cancellation_tokens[progress_id] = False

    @property
    def is_cancelled(self) -> bool:
        """Check if cancellation was requested."""
        return _cancellation_tokens.get(self.progress_id, False)

    def cleanup(self):
        """Remove token from registry."""
        _cancellation_tokens.pop(self.progress_id, None)


@router.post("/cancel/{progress_id}")
async def cancel_update(progress_id: str):
    """
    Cancel an in-progress metadata update operation.

    Args:
        progress_id: The progress ID to cancel

    Returns:
        Status of the cancellation request
    """
    if progress_id in _cancellation_tokens:
        _cancellation_tokens[progress_id] = True
        return {"status": "cancelled"}
    return {"status": "not_found"}


def _authenticate_admin(session_id, x_session_id, session_manager, auth_manager):
    """Authenticate request and verify admin role.

    Returns:
        Tuple of (session_id_value, user)

    Raises:
        HTTPException: If authentication fails or user is not admin
    """
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
    if "admin" not in user_roles:
        raise HTTPException(status_code=403, detail="Admin role required")

    return session_id_value, user


@router.get("/options", response_class=HTMLResponse)
async def options_form(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    Display options form for metadata update configuration.

    Returns HTML form with radio buttons for extraction mode and checkbox
    for force overwrite.
    """
    _authenticate_admin(session_id, x_session_id, session_manager, auth_manager)

    from fastapi_app.lib.plugins.plugin_tools import generate_sandbox_client_script

    sandbox_script = generate_sandbox_client_script()

    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Update Metadata Options</title>
    <script>{sandbox_script}</script>
    <style>
        body {{
            font-family: Arial, sans-serif;
            padding: 20px;
            max-width: 600px;
            margin: 0 auto;
        }}
        h2 {{
            color: #333;
            border-bottom: 2px solid #2196F3;
            padding-bottom: 10px;
        }}
        .option-group {{
            margin: 20px 0;
            padding: 15px;
            background: #f5f5f5;
            border-radius: 5px;
        }}
        .option-group label {{
            display: block;
            margin: 8px 0;
            cursor: pointer;
        }}
        .option-group label input {{
            margin-right: 8px;
        }}
        .description {{
            font-size: 0.9em;
            color: #666;
            margin-left: 26px;
            margin-top: 2px;
        }}
        .buttons {{
            margin-top: 25px;
            display: flex;
            gap: 10px;
        }}
        button {{
            padding: 10px 24px;
            border: none;
            border-radius: 4px;
            font-size: 1em;
            cursor: pointer;
        }}
        button.primary {{
            background: #2196F3;
            color: white;
        }}
        button.primary:hover {{
            background: #1976D2;
        }}
        button.secondary {{
            background: #e0e0e0;
            color: #333;
        }}
        button.secondary:hover {{
            background: #bdbdbd;
        }}
    </style>
</head>
<body>
    <h2>Update Metadata Options</h2>

    <div class="option-group">
        <strong>Metadata source:</strong>
        <label>
            <input type="radio" name="mode" value="retrieval_and_extraction" checked>
            Metadata retrieval and extraction
        </label>
        <div class="description">
            Look up metadata via DOI (CrossRef/DataCite). If no DOI is available,
            extract metadata from PDF using LLM.
        </div>
        <label>
            <input type="radio" name="mode" value="retrieval_only">
            Metadata retrieval only
        </label>
        <div class="description">
            Only look up metadata via DOI. Skip documents without a DOI.
        </div>
    </div>

    <div class="option-group">
        <label>
            <input type="checkbox" id="force" checked>
            Overwrite existing metadata
        </label>
        <div class="description">
            If checked, existing biblStruct elements will be replaced with fresh metadata.
        </div>
    </div>

    <div class="buttons">
        <button class="primary" onclick="startUpdate()">Start</button>
        <button class="secondary" onclick="sandbox.closeDialog()">Cancel</button>
    </div>

    <script>
        function startUpdate() {{
            const mode = document.querySelector('input[name="mode"]:checked').value;
            const force = document.getElementById('force').checked;
            const extractionFallback = (mode === 'retrieval_and_extraction');

            const params = new URLSearchParams();
            if (force) params.set('force', 'true');
            params.set('extraction_fallback', extractionFallback.toString());

            const url = '/api/plugins/update-metadata/execute?' + params.toString();
            sandbox.navigateIframe(url);
        }}
    </script>
</body>
</html>"""

    return HTMLResponse(content=html)


@router.get("/execute", response_class=HTMLResponse)
async def execute_update(
    force: bool = Query(False, description="Overwrite existing biblStruct elements"),
    extraction_fallback: bool = Query(True, description="Use LLM extraction when DOI lookup fails"),
    limit: int | None = Query(None, description="Limit number of PDFs to process"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    sse_service=Depends(get_sse_service),
    db=Depends(get_db),
    file_storage=Depends(get_file_storage),
):
    """
    Execute metadata update with SSE progress tracking.

    Updates all TEI files with complete metadata from DOI lookup using CrossRef/DataCite,
    optionally falling back to LLM extraction.

    Args:
        force: If True, overwrite existing biblStruct elements
        extraction_fallback: If True, use LLM extraction when DOI lookup fails
        limit: Maximum number of PDFs to process (for testing)
        session_id: Session ID from query parameter
        x_session_id: Session ID from header

    Returns:
        HTML page with update results and statistics
    """
    session_id_value, _ = _authenticate_admin(
        session_id, x_session_id, session_manager, auth_manager
    )

    # Set up progress tracking
    progress = ProgressBar(sse_service, session_id_value)
    cancellation_token = CancellationToken(progress.progress_id)

    mode_label = "retrieval + extraction" if extraction_fallback else "retrieval only"
    progress.show(
        label=f"Starting metadata update ({mode_label})...",
        cancellable=True,
        cancel_url=f"/api/plugins/update-metadata/cancel/{progress.progress_id}"
    )
    await asyncio.sleep(0)  # Yield to allow SSE event delivery

    try:
        file_repo = FileRepository(db)

        # Progress callback
        def on_progress(current: int, total: int, label: str):
            """Update progress bar with current status."""
            progress.set_label(label)
            if total > 0:
                progress.set_value(int((current / total) * 100))

        # Cancellation check
        def is_cancelled() -> bool:
            """Check if user requested cancellation."""
            return cancellation_token.is_cancelled

        # Run update
        logger.info(
            f"Starting metadata update (force={force}, "
            f"extraction_fallback={extraction_fallback}, limit={limit})"
        )
        stats = await update_tei_metadata(
            file_repo=file_repo,
            file_storage=file_storage,
            limit=limit,
            force=force,
            extraction_fallback=extraction_fallback,
            progress_callback=on_progress,
            cancellation_check=is_cancelled
        )
        logger.info(f"Metadata update complete: {stats}")

        # Hide progress
        progress.hide()
        cancellation_token.cleanup()

        # Mode description for results
        mode_info = (
            "DOI lookup (CrossRef/DataCite) with LLM extraction fallback"
            if extraction_fallback
            else "DOI lookup (CrossRef/DataCite) only"
        )

        # Generate summary HTML
        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Metadata Update Results</title>
            <style>
                body {{
                    font-family: Arial, sans-serif;
                    padding: 20px;
                    max-width: 800px;
                    margin: 0 auto;
                }}
                h2 {{
                    color: #333;
                    border-bottom: 2px solid #28a745;
                    padding-bottom: 10px;
                }}
                .summary {{
                    background: #f5f5f5;
                    padding: 20px;
                    border-radius: 5px;
                    margin: 20px 0;
                }}
                .stat {{
                    margin: 15px 0;
                    padding: 10px;
                    background: white;
                    border-left: 4px solid #ddd;
                    border-radius: 3px;
                }}
                .stat.success {{
                    border-left-color: #28a745;
                }}
                .stat.warning {{
                    border-left-color: #ffc107;
                }}
                .stat.error {{
                    border-left-color: #dc3545;
                }}
                .stat strong {{
                    font-size: 1.2em;
                }}
                .info {{
                    margin-top: 20px;
                    padding: 15px;
                    background: #e7f3ff;
                    border-left: 4px solid #2196F3;
                    border-radius: 3px;
                }}
            </style>
        </head>
        <body>
            <h2>Metadata Update Complete</h2>
            <div class="summary">
                <div class="stat">
                    <strong>Mode:</strong> {mode_info}
                </div>
                <div class="stat">
                    <strong>PDFs processed:</strong> {stats['processed']}
                </div>
                <div class="stat success">
                    <strong>TEI files updated:</strong> {stats['updated']}
                </div>
                <div class="stat warning">
                    <strong>PDFs skipped:</strong> {stats['skipped']}
                    <div style="font-size: 0.9em; color: #666; margin-top: 5px;">
                        (no DOI, already have biblStruct, or no useful metadata)
                    </div>
                </div>
                <div class="stat error">
                    <strong>Errors:</strong> {stats['errors']}
                </div>
            </div>
            <div class="info">
                <strong>What was updated:</strong>
                <ul>
                    <li>TEI documents now contain complete biblStruct elements with metadata</li>
                    <li>PDF doc_metadata fields updated in database</li>
                    <li>Includes: title, authors, journal, volume, issue, pages, publisher, DOI, URL</li>
                </ul>
            </div>
        </body>
        </html>
        """

        # Send success notification
        send_notification(
            sse_service, session_id_value,
            f"Updated {stats['updated']} TEI files from {stats['processed']} PDFs",
            "success"
        )

        return HTMLResponse(content=html)

    except Exception as e:
        # Check if it was a cancellation
        if cancellation_token.is_cancelled or "cancelled" in str(e).lower():
            progress.hide()
            cancellation_token.cleanup()

            html = """
            <!DOCTYPE html>
            <html>
            <head>
                <title>Update Cancelled</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        padding: 20px;
                        max-width: 800px;
                        margin: 0 auto;
                    }
                    .cancelled {
                        background: #fff3cd;
                        padding: 20px;
                        border-left: 4px solid #ffc107;
                        border-radius: 3px;
                    }
                </style>
            </head>
            <body>
                <div class="cancelled">
                    <h2>Update Cancelled</h2>
                    <p>The metadata update was cancelled by the user.</p>
                </div>
            </body>
            </html>
            """

            send_notification(
                sse_service, session_id_value,
                "Metadata update cancelled",
                "warning"
            )

            return HTMLResponse(content=html)

        # Other errors
        progress.hide()
        cancellation_token.cleanup()

        logger.error(f"Metadata update failed: {e}", exc_info=True)

        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Update Failed</title>
            <style>
                body {{
                    font-family: Arial, sans-serif;
                    padding: 20px;
                    max-width: 800px;
                    margin: 0 auto;
                }}
                .error {{
                    background: #f8d7da;
                    padding: 20px;
                    border-left: 4px solid #dc3545;
                    border-radius: 3px;
                }}
                .error-details {{
                    margin-top: 15px;
                    padding: 10px;
                    background: white;
                    border-radius: 3px;
                    font-family: monospace;
                    font-size: 0.9em;
                }}
            </style>
        </head>
        <body>
            <div class="error">
                <h2>Update Failed</h2>
                <p>An error occurred during the metadata update.</p>
                <div class="error-details">{str(e)}</div>
            </div>
        </body>
        </html>
        """

        send_notification(
            sse_service, session_id_value,
            f"Metadata update failed: {str(e)}",
            "danger"
        )

        return HTMLResponse(content=html)

"""
Custom routes for Update Metadata plugin.

Provides metadata update endpoint with SSE progress tracking and cancellation support.
"""

import asyncio
import logging
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.sse_utils import ProgressBar, send_notification
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.metadata_update_utils import update_tei_metadata

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


@router.get("/execute", response_class=HTMLResponse)
async def execute_update(
    force: bool = Query(False, description="Overwrite existing biblStruct elements"),
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

    Updates all TEI files with complete metadata from DOI lookup using CrossRef/DataCite.
    Provides real-time progress updates via SSE and supports cancellation.

    Args:
        force: If True, overwrite existing biblStruct elements
        limit: Maximum number of PDFs to process (for testing)
        session_id: Session ID from query parameter
        x_session_id: Session ID from header

    Returns:
        HTML page with update results and statistics
    """
    from fastapi_app.config import get_settings

    # Authenticate (admin only)
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Check admin role
    user_roles = user.get("roles", [])
    if "admin" not in user_roles:
        raise HTTPException(status_code=403, detail="Admin role required")

    # Set up progress tracking
    progress = ProgressBar(sse_service, session_id_value)
    cancellation_token = CancellationToken(progress.progress_id)

    progress.show(
        label="Starting metadata update...",
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
        logger.info(f"Starting metadata update (force={force}, limit={limit})")
        stats = await update_tei_metadata(
            file_repo=file_repo,
            file_storage=file_storage,
            limit=limit,
            force=force,
            progress_callback=on_progress,
            cancellation_check=is_cancelled
        )
        logger.info(f"Metadata update complete: {stats}")

        # Hide progress
        progress.hide()
        cancellation_token.cleanup()

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
            <h2>✓ Metadata Update Complete</h2>
            <div class="summary">
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
                <strong>ℹ️ What was updated:</strong>
                <ul>
                    <li>TEI documents now contain complete biblStruct elements with metadata from CrossRef/DataCite</li>
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

            # Generate cancellation HTML
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
                    <h2>⚠️ Update Cancelled</h2>
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

        # Generate error HTML
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
                <h2>✗ Update Failed</h2>
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

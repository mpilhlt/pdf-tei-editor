"""
Custom routes for Annotation Progress plugin.
"""

import csv
import io
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_db,
    get_session_manager,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/annotation-progress", tags=["annotation-progress"])


@router.get("/view", response_class=HTMLResponse)
async def view_progress(
    collection: str = Query(..., description="Collection ID"),
    variant: str | None = Query(None, description="Variant filter"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    View annotation progress as an HTML page with sortable table.

    Args:
        collection: Collection ID to view
        variant: Optional variant filter
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        HTML page with DataTables-powered table
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.file_repository import FileRepository
    from fastapi_app.lib.plugin_tools import generate_datatable_page, escape_html
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
    from fastapi_app.lib.user_utils import user_has_collection_access
    if not user_has_collection_access(user, collection, settings.db_dir):
        raise HTTPException(status_code=403, detail="Access denied to collection")

    try:
        from fastapi_app.lib.statistics import calculate_collection_statistics
        from fastapi_app.lib.config_utils import get_config

        db = get_db()
        file_repo = FileRepository(db)

        # Get lifecycle order from config
        config = get_config()
        lifecycle_order = config.get("annotation.lifecycle.order", [])

        # Calculate collection statistics
        stats = calculate_collection_statistics(
            file_repo=file_repo,
            collection=collection,
            variant=variant,
            lifecycle_order=lifecycle_order
        )

        total_docs = stats["total_docs"]
        total_annotations = stats["total_annotations"]
        avg_progress = stats["avg_progress"]
        stage_counts = stats["stage_counts"]
        doc_annotations = stats["doc_annotations"]

        # Prepare table data
        headers = ["Document ID", "Annotations", "Status", "Date"]
        rows = []

        # Get all doc_ids from the statistics
        all_doc_ids = set()
        file_repo_files = file_repo.get_files_by_collection(collection)
        for f in file_repo_files:
            if f.doc_id:
                all_doc_ids.add(f.doc_id)

        # Sort by doc_id and include all documents even if they have no annotations
        for doc_id in sorted(all_doc_ids):
            annotations = doc_annotations[doc_id]

            # Create annotation links
            annotation_links = []
            newest_status = ""
            newest_timestamp = None

            for ann in annotations:
                label = ann["annotation_label"]
                stable_id = ann["stable_id"]

                link = f'<a href="#" onclick="sandbox.openDocument(\'{stable_id}\'); return false;" style="color: #0066cc; text-decoration: underline;">{escape_html(label)}</a>'
                annotation_links.append(link)

                # Track the newest status across all annotations for this document
                ann_timestamp = ann.get("updated_at")
                if ann_timestamp and (newest_timestamp is None or ann_timestamp > newest_timestamp):
                    newest_timestamp = ann_timestamp
                    newest_status = ann.get("status", "")

            annotations_cell = ", ".join(annotation_links) if annotation_links else "No annotations"

            # Create visual status indicator
            status_cell = _create_status_indicator(newest_status, lifecycle_order)

            # Format timestamp for display (human-readable)
            date_cell = ""
            if newest_timestamp:
                date_cell = newest_timestamp.strftime("%Y-%m-%d %H:%M")

            rows.append([
                escape_html(doc_id),
                annotations_cell,
                status_cell,
                date_cell
            ])

        # Generate summary card HTML
        summary_html = _create_summary_card(
            total_docs,
            avg_progress,
            total_annotations,
            stage_counts,
            lifecycle_order
        )

        # Generate HTML page
        title = f"Annotation Progress - {collection}"
        if variant and variant != "all":
            title += f" ({variant})"

        html = generate_datatable_page(
            title=title,
            headers=headers,
            rows=rows,
            table_id="annotationProgressTable",
            page_length=25,
            default_sort_col=0,
            default_sort_dir="asc",
            enable_sandbox_client=True,
            custom_css="""
                table { font-size: 0.9em; }
                .summary-card {
                    background: #f8f9fa;
                    border: 1px solid #dee2e6;
                    border-radius: 8px;
                    padding: 20px;
                    margin-bottom: 20px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                .summary-stats {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 15px;
                    margin-bottom: 15px;
                }
                .stat-item {
                    background: white;
                    padding: 12px;
                    border-radius: 6px;
                    border: 1px solid #e9ecef;
                }
                .stat-label {
                    font-size: 0.85em;
                    color: #6c757d;
                    margin-bottom: 4px;
                }
                .stat-value {
                    font-size: 1.5em;
                    font-weight: 600;
                    color: #212529;
                }
                .stage-distribution {
                    margin-top: 15px;
                }
                .stage-list {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                    margin-top: 8px;
                }
                .stage-badge {
                    background: white;
                    border: 1px solid #e9ecef;
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 0.9em;
                }
                .stage-badge strong {
                    color: #495057;
                }
                .status-indicator {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                }
                .status-circle {
                    width: 3px;
                    height: 3px;
                    border: 0.5px solid #495057;
                    border-radius: 50%;
                    display: inline-block;
                }
                .status-circle.filled {
                    background-color: #495057;
                }
                .status-label {
                    font-size: 0.75em;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: #495057;
                    background: #e9ecef;
                    padding: 2px 8px;
                    border-radius: 3px;
                }
            """,
            extra_content_before_table=summary_html
        )

        return HTMLResponse(content=html)

    except Exception as e:
        logger.error(f"Failed to generate annotation progress view: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export")
async def export_csv(
    collection: str = Query(..., description="Collection ID"),
    variant: str | None = Query(None, description="Variant filter"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    Export annotation progress as CSV.

    Args:
        collection: Collection ID to export
        variant: Optional variant filter
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        CSV file as streaming response
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.file_repository import FileRepository
    from fastapi_app.lib.user_utils import user_has_collection_access

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
        from fastapi_app.lib.statistics import calculate_collection_statistics
        from fastapi_app.lib.config_utils import get_config

        db = get_db()
        file_repo = FileRepository(db)

        # Get lifecycle order from config
        config = get_config()
        lifecycle_order = config.get("annotation.lifecycle.order", [])

        # Calculate collection statistics
        stats = calculate_collection_statistics(
            file_repo=file_repo,
            collection=collection,
            variant=variant,
            lifecycle_order=lifecycle_order
        )

        doc_annotations = stats["doc_annotations"]

        # Get all doc_ids from the collection
        all_doc_ids = set()
        file_repo_files = file_repo.get_files_by_collection(collection)
        for f in file_repo_files:
            if f.doc_id:
                all_doc_ids.add(f.doc_id)

        # Generate CSV
        output = io.StringIO()
        writer = csv.writer(output)

        # Write header
        writer.writerow(
            ["Document ID", "Annotation Label", "Status", "Date"]
        )

        # Write data - sort by doc_id and include all documents even if they have no annotations
        for doc_id in sorted(all_doc_ids):
            annotations = doc_annotations[doc_id]

            if not annotations:
                # Document with no annotations
                writer.writerow([doc_id, "", "", ""])
            else:
                # Sort annotations by label for consistent output
                annotations.sort(key=lambda x: x["annotation_label"])

                for ann in annotations:
                    # Format timestamp as timezone-aware ISO format with Z suffix
                    date_str = ""
                    timestamp = ann.get("updated_at")
                    if timestamp:
                        # Assume UTC if no timezone info (since we stripped it during parsing)
                        from datetime import timezone
                        if timestamp.tzinfo is None:
                            timestamp = timestamp.replace(tzinfo=timezone.utc)
                        date_str = timestamp.isoformat().replace("+00:00", "Z")

                    writer.writerow([
                        doc_id,
                        ann["annotation_label"],
                        ann.get("status", ""),
                        date_str,
                    ])

        # Create streaming response
        output.seek(0)
        return StreamingResponse(
            io.BytesIO(output.getvalue().encode("utf-8")),
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="annotation-progress-{collection}.csv"'
            },
        )

    except Exception as e:
        logger.error(f"Failed to export annotation progress: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _get_stage_color(stage_index: int, total_stages: int) -> tuple[str, str]:
    """
    Get background and text color for a lifecycle stage using cool-to-warm gradient.

    Args:
        stage_index: Zero-based index of the stage
        total_stages: Total number of stages

    Returns:
        Tuple of (background_color, text_color)
    """
    # Cool-to-warm gradient: blue → purple → orange
    # Colors chosen for good contrast and accessibility
    colors = [
        ("#E3F2FD", "#1565C0"),  # Light blue bg, dark blue text
        ("#BBDEFB", "#0D47A1"),  # Medium light blue
        ("#D1C4E9", "#4527A0"),  # Light purple bg, dark purple text
        ("#B39DDB", "#311B92"),  # Medium purple
        ("#CE93D8", "#6A1B9A"),  # Light violet bg, dark violet text
        ("#FFE0B2", "#E65100"),  # Light orange bg, dark orange text
        ("#FFCC80", "#E65100"),  # Medium orange
        ("#FFB74D", "#E65100"),  # Darker orange
    ]

    # If we have more stages than colors, interpolate
    if total_stages <= len(colors):
        # Use subset of colors
        step = len(colors) / total_stages
        color_index = int(stage_index * step)
        return colors[color_index]
    else:
        # Use all colors and repeat last one
        if stage_index < len(colors):
            return colors[stage_index]
        return colors[-1]


def _create_status_indicator(status: str, lifecycle_order: list[str]) -> str:
    """
    Create a visual status indicator with filled circles based on lifecycle position.

    Args:
        status: Current status value
        lifecycle_order: Ordered list of lifecycle stages

    Returns:
        HTML string with status indicator
    """
    from fastapi_app.lib.plugin_tools import escape_html

    if not status or not lifecycle_order:
        return '<span class="status-text">—</span>'

    # Find position in lifecycle
    try:
        current_index = lifecycle_order.index(status)
        total_stages = len(lifecycle_order)
        filled_count = current_index + 1
    except ValueError:
        # Status not in lifecycle order
        return f'<span class="status-label">{escape_html(status.upper())}</span>'

    # Get color for this stage
    bg_color, text_color = _get_stage_color(current_index, total_stages)

    # Create circles (filled for completed stages, empty for remaining)
    circles = []
    for i in range(total_stages):
        filled_class = "filled" if i < filled_count else ""
        circles.append(f'<span class="status-circle {filled_class}"></span>')

    circles_html = "".join(circles)
    status_text = escape_html(status)
    status_display = escape_html(status.upper())

    return f'<span class="status-indicator" title="{status_text} ({filled_count}/{total_stages})">{circles_html} <span class="status-label" style="background: {bg_color}; color: {text_color};">{status_display}</span></span>'


def _create_summary_card(
    total_docs: int,
    avg_progress: float,
    total_annotations: int,
    stage_counts: dict[str, int],
    lifecycle_order: list[str]
) -> str:
    """
    Create HTML summary card showing collection-level statistics.

    Args:
        total_docs: Total number of documents
        avg_progress: Average lifecycle progress percentage across all documents
        total_annotations: Total number of annotations
        stage_counts: Dictionary mapping lifecycle stages to document counts
        lifecycle_order: Ordered list of lifecycle stages

    Returns:
        HTML string for summary card
    """
    # Build stage distribution HTML
    stage_badges = []
    for stage in lifecycle_order:
        count = stage_counts.get(stage, 0)
        if count > 0:
            stage_badges.append(f'<span class="stage-badge"><strong>{count}</strong> {stage}</span>')

    # Add no-status count if any
    no_status_count = stage_counts.get("no-status", 0)
    if no_status_count > 0:
        stage_badges.append(f'<span class="stage-badge"><strong>{no_status_count}</strong> no status</span>')

    stage_badges_html = "\n".join(stage_badges) if stage_badges else '<span class="stage-badge">No data</span>'

    return f"""
    <div class="summary-card">
        <div class="summary-stats">
            <div class="stat-item">
                <div class="stat-label">Total Documents</div>
                <div class="stat-value">{total_docs}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Total Progress</div>
                <div class="stat-value">{avg_progress:.1f}%</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Total Annotations</div>
                <div class="stat-value">{total_annotations}</div>
            </div>
        </div>
        <div class="stage-distribution">
            <div class="stat-label">Distribution by Lifecycle Stage</div>
            <div class="stage-list">
                {stage_badges_html}
            </div>
        </div>
    </div>
    """

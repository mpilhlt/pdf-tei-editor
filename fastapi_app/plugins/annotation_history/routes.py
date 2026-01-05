"""
Custom routes for Annotation History plugin.
"""

from fastapi import APIRouter, Query, HTTPException, Depends, Header
from fastapi.responses import StreamingResponse, HTMLResponse
from io import StringIO
import logging

from fastapi_app.lib.dependencies import (
    get_db,
    get_file_storage,
    get_auth_manager,
    get_session_manager,
)
from fastapi_app.lib.file_repository import FileRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/annotation-history", tags=["plugins"])


@router.get("/view", response_class=HTMLResponse)
async def view_history(
    pdf: str = Query(..., description="PDF stable_id or file hash"),
    variant: str = Query("all", description="Model variant filter"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    View annotation history as HTML page with nested tables.

    Args:
        pdf: PDF stable_id or file hash
        variant: Model variant filter (or 'all')
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        HTML page with annotation history
    """
    from fastapi_app.config import get_settings
    from fastapi_app.plugins.annotation_history.plugin import AnnotationHistoryPlugin

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

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get doc_id from the PDF's stable_id or file hash
        doc_id = file_repo.get_doc_id_by_file_id(pdf)
        if not doc_id:
            raise HTTPException(status_code=404, detail="PDF file not found")

        # Get PDF file to extract label
        pdf_file = file_repo.get_file_by_stable_id(pdf) or file_repo.get_file_by_hash(pdf)
        pdf_label = pdf_file.label if pdf_file and pdf_file.label else pdf

        # Get all files for this document
        all_files = file_repo.get_files_by_doc_id(doc_id)

        # Filter for TEI files only
        tei_files = [f for f in all_files if f.file_type == "tei"]

        if not tei_files:
            return HTMLResponse(content="<p>No annotation versions found for this PDF document.</p>")

        # Parse each TEI file and extract complete document info
        plugin = AnnotationHistoryPlugin()
        documents = []
        for file_metadata in tei_files:
            # Filter by variant if specified (and not "all" or empty)
            if variant and variant not in ("all", ""):
                file_variant = getattr(file_metadata, "variant", None)
                if file_variant != variant:
                    continue

            try:
                content_bytes = file_storage.read_file(file_metadata.id, "tei")
                if not content_bytes:
                    logger.warning(f"Empty content for file {file_metadata.id}")
                    continue

                xml_content = content_bytes.decode("utf-8")
                doc_info = plugin._parse_tei_document_info(xml_content, file_metadata)
                if doc_info:
                    documents.append(doc_info)
            except Exception as e:
                logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                continue

        if not documents:
            return HTMLResponse(
                content="<p>No annotation versions found matching the filter.</p>"
            )

        # Determine if we should show variant column
        show_variant_column = not variant or variant in ("all", "")

        # Sort documents: gold first, then by last change date (newest first)
        plugin._sort_documents(documents)

        # Generate nested table HTML content
        nested_table_html = plugin._generate_nested_table(documents, show_variant_column)

        # Wrap in proper HTML page using generate_datatable_page
        from fastapi_app.lib.plugin_tools import generate_datatable_page

        # Build title: PDF label - doc_id (variant)
        title = f"{pdf_label} - {doc_id}"
        if variant and variant != "all":
            title += f" ({variant})"

        # Since we have custom nested table HTML, we'll use generate_datatable_page with empty rows
        # and inject our custom HTML as a custom footer
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        body {{
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
        }}
        h1 {{
            color: #333;
            font-size: 1.2em;
            margin-bottom: 20px;
        }}
        {plugin._get_table_css()}
    </style>
</head>
<body>
    <h1>{title}</h1>
    {nested_table_html}
    <script>
        // Initialize sandbox client for document opening
        const sandbox = {{
            openDocument: function(stableId) {{
                window.parent.postMessage({{
                    type: 'openDocument',
                    stableId: stableId
                }}, '*');
            }}
        }};
    </script>
</body>
</html>"""

        return HTMLResponse(content=html)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate annotation history view for PDF {pdf}: {e}")
        raise HTTPException(status_code=500, detail=f"View failed: {str(e)}")


@router.get("/export")
async def export_csv(
    pdf: str = Query(..., description="PDF stable_id or file hash"),
    variant: str = Query("all", description="Model variant filter")
):
    """
    Export annotation history as CSV file.

    Args:
        pdf: PDF stable_id or file hash
        variant: Model variant filter (or 'all')

    Returns:
        CSV file download with complete revision history
    """
    from fastapi_app.plugins.annotation_history.plugin import AnnotationHistoryPlugin

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get doc_id from the PDF's stable_id or file hash
        doc_id = file_repo.get_doc_id_by_file_id(pdf)
        if not doc_id:
            raise HTTPException(status_code=404, detail="PDF file not found")

        # Get all files for this document
        all_files = file_repo.get_files_by_doc_id(doc_id)

        # Filter for TEI files only
        tei_files = [f for f in all_files if f.file_type == "tei"]

        if not tei_files:
            raise HTTPException(status_code=404, detail="No annotation versions found")

        # Parse each TEI file and extract complete document info
        plugin = AnnotationHistoryPlugin()
        documents = []
        for file_metadata in tei_files:
            # Filter by variant if specified (and not "all" or empty)
            if variant and variant not in ("all", ""):
                file_variant = getattr(file_metadata, "variant", None)
                if file_variant != variant:
                    continue

            try:
                content_bytes = file_storage.read_file(file_metadata.id, "tei")
                if not content_bytes:
                    logger.warning(f"Empty content for file {file_metadata.id}")
                    continue

                xml_content = content_bytes.decode("utf-8")
                doc_info = plugin._parse_tei_document_info(xml_content, file_metadata)
                if doc_info:
                    documents.append(doc_info)
            except Exception as e:
                logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                continue

        if not documents:
            raise HTTPException(
                status_code=404,
                detail="No annotation versions found matching the filter"
            )

        # Determine if we should show variant column
        show_variant_column = not variant or variant in ("all", "")

        # Sort documents: gold first, then by last change date (newest first)
        plugin._sort_documents(documents)

        # Generate CSV
        csv_content = plugin._generate_csv(documents, show_variant_column)

        # Create streaming response with CSV content
        output = StringIO(csv_content)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename=annotation_history_{pdf}.csv"
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to export annotation history for PDF {pdf}: {e}")
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")

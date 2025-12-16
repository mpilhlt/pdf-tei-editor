"""
Custom routes for Annotation Versions Analyzer plugin.
"""

from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import StreamingResponse
from io import StringIO
import csv
import logging

from fastapi_app.lib.dependencies import get_db, get_file_storage
from fastapi_app.lib.file_repository import FileRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/annotation-versions-analyzer", tags=["plugins"])


@router.get("/export")
async def export_csv(
    pdf: str = Query(..., description="PDF stable_id or file hash"),
    variant: str = Query("all", description="Model variant filter")
):
    """
    Export annotation versions as CSV file.

    Args:
        pdf: PDF stable_id or file hash
        variant: Model variant filter (or 'all')

    Returns:
        CSV file download
    """
    from fastapi_app.plugins.annotation_versions_analyzer.plugin import AnnotationVersionsAnalyzerPlugin

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

        # Parse each TEI file and extract information
        plugin = AnnotationVersionsAnalyzerPlugin()
        versions = []
        for file_metadata in tei_files:
            if file_metadata.file_type != "tei":
                continue

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
                version_info = plugin._parse_tei_version_info(xml_content, file_metadata)
                if version_info:
                    versions.append(version_info)
            except Exception as e:
                logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                continue

        # Sort versions: gold first, then by date (newest first)
        plugin._sort_versions(versions)

        # Determine if we should include variant column
        show_variant_column = not variant or variant in ("all", "")

        # Generate CSV
        output = StringIO()
        writer = csv.writer(output)

        # Write header
        header = ["Title", "Gold"]
        if show_variant_column:
            header.append("Variant")
        header.extend(["Last Change", "Annotator", "Date"])
        writer.writerow(header)

        # Write data rows
        for version in versions:
            row = [
                version["title"],
                "Yes" if version["is_gold"] else "No",
            ]
            if show_variant_column:
                row.append(version.get("variant", ""))
            row.extend([
                version["last_change_desc"],
                version["last_annotator"],
                version["last_change_date"],
            ])
            writer.writerow(row)

        # Get CSV content
        csv_content = output.getvalue()
        output.close()

        # Generate filename
        filename = f"annotation_versions_{pdf[:8]}.csv"

        # Return StreamingResponse for file download
        return StreamingResponse(
            iter([csv_content]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to export annotation versions for PDF {pdf}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

"""
Custom routes for Inter-Annotator Agreement Analyzer plugin.
"""

import csv
import logging
from io import StringIO

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from fastapi_app.lib.dependencies import get_db, get_file_storage
from fastapi_app.lib.file_repository import FileRepository

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/plugins/iaa-analyzer", tags=["plugins"]
)


@router.get("/export")
async def export_csv(
    pdf: str = Query(..., description="PDF stable_id or file hash"),
    variant: str = Query("all", description="Model variant filter"),
):
    """
    Export inter-annotator agreement results as CSV file.

    Args:
        pdf: PDF stable_id or file hash
        variant: Model variant filter (or 'all')

    Returns:
        CSV file download
    """
    from fastapi_app.plugins.iaa_analyzer.plugin import IAAAnalyzerPlugin

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get doc_id from the PDF's stable_id or file hash
        doc_id = file_repo.get_doc_id_by_file_id(pdf)
        if not doc_id:
            raise HTTPException(status_code=404, detail="PDF file not found")

        # Get all TEI files for this document
        all_files = file_repo.get_files_by_doc_id(doc_id)
        tei_files = [f for f in all_files if f.file_type == "tei"]

        # Filter by variant if specified (and not "all" or empty)
        if variant and variant not in ("all", ""):
            tei_files = [
                f for f in tei_files if getattr(f, "variant", None) == variant
            ]

        if len(tei_files) < 2:
            raise HTTPException(
                status_code=404,
                detail=f"Need at least 2 TEI versions to compare. Found {len(tei_files)} version(s).",
            )

        # Reuse plugin methods to extract data
        plugin = IAAAnalyzerPlugin()
        versions = []

        for file_metadata in tei_files:
            try:
                content_bytes = file_storage.read_file(file_metadata.id, "tei")
                if not content_bytes:
                    logger.warning(f"Empty content for file {file_metadata.id}")
                    continue

                xml_content = content_bytes.decode("utf-8")
                metadata = plugin._extract_metadata(xml_content, file_metadata)
                elements = plugin._extract_element_sequence(xml_content)

                versions.append(
                    {
                        "file_id": file_metadata.id,
                        "metadata": metadata,
                        "elements": elements,
                    }
                )
            except Exception as e:
                logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                continue

        if len(versions) < 2:
            raise HTTPException(
                status_code=404,
                detail=f"Need at least 2 valid TEI versions to compare. Found {len(versions)} valid version(s).",
            )

        # Compute pairwise agreements
        comparisons = plugin._compute_pairwise_agreements(versions)

        # Generate CSV
        output = StringIO()
        writer = csv.writer(output)

        # Write header
        header = [
            "Version 1",
            "Stable ID 1",
            "Annotator 1",
            "Elements 1",
            "Version 2",
            "Stable ID 2",
            "Annotator 2",
            "Elements 2",
            "Matches",
            "Total",
            "Agreement (%)",
        ]
        writer.writerow(header)

        # Write data rows
        for comp in comparisons:
            v1 = comp["version1"]
            v2 = comp["version2"]
            row = [
                v1["title"],
                v1["stable_id"],
                v1["annotator"],
                comp["v1_count"],
                v2["title"],
                v2["stable_id"],
                v2["annotator"],
                comp["v2_count"],
                comp["matches"],
                comp["total"],
                comp["agreement"],
            ]
            writer.writerow(row)

        # Get CSV content
        csv_content = output.getvalue()
        output.close()

        # Generate filename
        filename = f"iaa_agreement_{pdf[:8]}.csv"

        # Return StreamingResponse for file download
        return StreamingResponse(
            iter([csv_content]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to export inter-annotator agreement for PDF {pdf}: {e}"
        )
        raise HTTPException(status_code=500, detail=str(e))

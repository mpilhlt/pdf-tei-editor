"""
File export API router for FastAPI.

Implements GET /api/v1/export - Exports and downloads files as a zip archive.

Key features:
- Session-based authentication
- Collection-based access control
- Two-step export: stats check then download
- Zip archive creation
- Streaming file download
"""

from fastapi import APIRouter, Depends, Query, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from typing import Optional, List
from pathlib import Path
import tempfile

from ..lib.database import DatabaseManager
from ..lib.file_repository import FileRepository
from ..lib.file_storage import FileStorage
from ..lib.file_zip_exporter import FileZipExporter
from ..lib.file_exporter import FileExporter
from ..lib.dependencies import (
    get_db,
    get_file_repository,
    get_file_storage,
    require_authenticated_user,
    get_session_id
)
from ..lib.user_utils import get_user_collections
from ..config import get_settings
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/export", tags=["export"])


@router.get("", response_model=None)
def export_files(
    request: Request,
    collections: Optional[str] = Query(None, description="Comma-separated list of collections to export"),
    variants: Optional[str] = Query(None, description="Comma-separated list of variants to export (supports glob patterns)"),
    include_versions: bool = Query(False, description="Include versioned TEI files"),
    group_by: str = Query("collection", description="Grouping strategy: type, collection, or variant"),
    download: bool = Query(False, description="If true, download ZIP; if false, return stats as JSON"),
    db: DatabaseManager = Depends(get_db),
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict = Depends(require_authenticated_user)
):
    """
    Export files as a downloadable zip archive or return export statistics.

    Two-step export process:
    1. Call without download=true to get stats (files_exported count)
    2. If files_exported > 0, call with download=true to get the ZIP

    Requires valid session authentication. Exports files filtered by:
    - Collections: If specified, only those collections (filtered by user access)
    - Variants: Optional variant filtering with glob pattern support
    - User access control: Only collections user has access to

    Args:
        collections: Comma-separated collection names (optional)
        variants: Comma-separated variant names (optional)
        include_versions: Include versioned TEI files (default: False)
        group_by: Directory grouping: "type", "collection", or "variant"
        download: If true, return ZIP file; if false, return stats JSON
        db: Database manager (injected)
        repo: File repository (injected)
        storage: File storage (injected)
        current_user: Current user dict (injected)

    Returns:
        FileResponse with zip archive (download=true) or JSONResponse with stats
    """
    logger.info(
        f"Export request - user={current_user.get('username')}, "
        f"collections={collections}, variants={variants}, group_by={group_by}"
    )

    # Validate group_by parameter
    if group_by not in ("type", "collection", "variant"):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid group_by: {group_by}. Must be 'type', 'collection', or 'variant'"
        )

    # Get accessible collections for user
    settings = get_settings()
    accessible_collections = get_user_collections(current_user, settings.db_dir)

    # Parse requested collections
    requested_collections: Optional[List[str]] = None
    if collections:
        requested_collections = [c.strip() for c in collections.split(',') if c.strip()]

    # Determine final collection filter
    final_collections: Optional[List[str]] = None

    if accessible_collections is None:
        # User has access to all collections (admin or wildcard)
        final_collections = requested_collections  # Use requested filter, or None for all
    else:
        # User has limited access - filter by intersection
        if requested_collections:
            # Filter to only accessible collections from requested
            final_collections = [
                col for col in requested_collections
                if col in accessible_collections
            ]
            if not final_collections:
                raise HTTPException(
                    status_code=403,
                    detail="You don't have access to any of the requested collections"
                )
        else:
            # Export all accessible collections
            final_collections = accessible_collections
            if not final_collections:
                raise HTTPException(
                    status_code=403,
                    detail="You don't have access to any collections"
                )

    logger.info(f"Exporting collections: {final_collections or 'all'}")

    # Parse variants
    variants_list: Optional[List[str]] = None
    if variants:
        variants_list = [v.strip() for v in variants.split(',') if v.strip()]

    # If not downloading, just return stats using dry_run mode
    if not download:
        try:
            # Use FileExporter in dry_run mode to get stats without creating files
            exporter = FileExporter(db, storage, repo, dry_run=True)
            # Need a dummy target path for dry_run
            temp_dir = Path(tempfile.mkdtemp(prefix="pdf-tei-export-dryrun-"))
            try:
                stats = exporter.export_files(
                    target_path=temp_dir,
                    collections=final_collections,
                    variants=variants_list,
                    include_versions=include_versions,
                    group_by=group_by
                )
                logger.info(
                    f"Export stats: {stats['files_exported']} files would be exported "
                    f"({stats['files_skipped']} skipped)"
                )
                return JSONResponse(content={
                    "files_exported": stats["files_exported"],
                    "files_skipped": stats["files_skipped"],
                    "files_scanned": stats["files_scanned"],
                    "errors": stats["errors"]
                })
            finally:
                # Clean up temp dir
                import shutil
                if temp_dir.exists():
                    shutil.rmtree(temp_dir)
        except Exception as e:
            logger.error(f"Export stats failed: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")

    # Download mode: create actual ZIP file
    zip_exporter = FileZipExporter(db, storage, repo)

    try:
        # Export to zip
        zip_path = zip_exporter.export_to_zip(
            collections=final_collections,
            variants=variants_list,
            include_versions=include_versions,
            group_by=group_by
        )

        logger.info(f"Export completed: {zip_path} ({zip_path.stat().st_size} bytes)")

        # Return as file download
        # Note: FileResponse will clean up temp file after sending
        from starlette.background import BackgroundTask
        return FileResponse(
            path=str(zip_path),
            media_type="application/zip",
            filename="export.zip",
            background=BackgroundTask(zip_exporter.cleanup)
        )

    except ValueError as e:
        logger.error(f"Invalid export parameters: {e}")
        zip_exporter.cleanup()
        raise HTTPException(status_code=400, detail=str(e))

    except Exception as e:
        logger.error(f"Export failed: {e}", exc_info=True)
        zip_exporter.cleanup()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")

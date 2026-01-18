"""
Custom routes for GROBID plugin.

Provides download endpoint for GROBID training data packages.
"""

import io
import logging
import os
import shutil
import zipfile

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.sse_utils import ProgressBar

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/grobid", tags=["grobid"])


@router.get("/download")
async def download_training_package(
    pdf: str = Query(..., description="PDF stable_id"),
    flavor: str = Query("default", description="GROBID processing flavor"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    sse_service=Depends(get_sse_service),
):
    """
    Download GROBID training package as ZIP.

    Fetches fresh training data from GROBID server, renames files according to
    document ID, and includes gold standard TEI files where available.

    Args:
        pdf: PDF stable_id
        flavor: GROBID processing flavor
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        ZIP file as streaming response
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

    # Get user and check reviewer role
    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    user_roles = user.get("roles", [])
    if "reviewer" not in user_roles and "admin" not in user_roles:
        raise HTTPException(status_code=403, detail="Reviewer role required")

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get PDF file metadata from stable_id
        pdf_file = file_repo.get_file_by_stable_id(pdf)
        if not pdf_file:
            raise HTTPException(status_code=404, detail="PDF not found")

        if pdf_file.file_type != "pdf":
            raise HTTPException(status_code=400, detail="File is not a PDF")

        # Check collection access
        for collection_id in pdf_file.doc_collections or []:
            if user_has_collection_access(user, collection_id, settings.db_dir):
                break
        else:
            if pdf_file.doc_collections:
                raise HTTPException(status_code=403, detail="Access denied to document")

        doc_id = pdf_file.doc_id
        if not doc_id:
            raise HTTPException(status_code=400, detail="PDF has no document ID")

        # Get PDF file path
        pdf_path = file_storage.get_file_path(pdf_file.id, "pdf")
        if not pdf_path:
            raise HTTPException(status_code=404, detail="PDF file not found in storage")

        # Get GROBID server URL
        grobid_server_url = os.environ.get("GROBID_SERVER_URL")
        if not grobid_server_url:
            raise HTTPException(status_code=503, detail="GROBID server not configured")

        # Show progress widget while fetching from GROBID
        progress = ProgressBar(sse_service, session_id_value)
        progress.show(label="Retrieving training data from GROBID...", cancellable=False)

        try:
            # Fetch training package from GROBID
            from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor

            extractor = GrobidTrainingExtractor()
            temp_dir, extracted_files = extractor._fetch_training_package(
                str(pdf_path), grobid_server_url, flavor
            )
        finally:
            # Hide progress widget before download starts
            progress.hide()

        try:
            # Get all gold standard TEI files for this document
            all_files = file_repo.get_files_by_doc_id(doc_id)
            gold_files = [
                f for f in all_files
                if f.file_type == "tei" and f.is_gold_standard
            ]

            # Build map of variant -> gold file content
            gold_by_variant = {}
            for gold_file in gold_files:
                variant = gold_file.variant
                if variant:
                    content = file_storage.read_file(gold_file.id, "tei")
                    if content:
                        gold_by_variant[variant] = content.decode("utf-8")

            # Create output ZIP in memory
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                for filename in extracted_files:
                    src_path = os.path.join(temp_dir, filename)

                    # Handle non-TEI files (e.g., .txt, .xml raw files)
                    # Include them with doc_id prefix but no gold matching
                    if not filename.endswith(".tei.xml"):
                        # Extract the part after the hash prefix
                        # Format: <hash>.<rest-of-filename>
                        parts = filename.split(".", 1)
                        if len(parts) == 2:
                            new_name = f"{doc_id}.{parts[1]}"
                        else:
                            new_name = f"{doc_id}.{filename}"
                        with open(src_path, "rb") as f:
                            zf.writestr(new_name, f.read())
                        continue

                    # Parse the filename to extract variant info
                    # Format: <hash>.training.<variant-suffix>.tei.xml
                    # e.g., abc123.training.segmentation.tei.xml
                    # or abc123.training.references.referenceSegmenter.tei.xml

                    # Extract variant suffix from filename
                    # Remove .tei.xml suffix and split by .training.
                    base_name = filename.rsplit(".tei.xml", 1)[0]
                    parts = base_name.split(".training.", 1)
                    if len(parts) != 2:
                        # Doesn't match expected pattern, include as-is with doc_id
                        hash_parts = filename.split(".", 1)
                        if len(hash_parts) == 2:
                            new_name = f"{doc_id}.{hash_parts[1]}"
                        else:
                            new_name = f"{doc_id}.{filename}"
                        with open(src_path, "r", encoding="utf-8") as f:
                            zf.writestr(new_name, f.read())
                        continue

                    variant_suffix = parts[1]  # e.g., "segmentation" or "references.referenceSegmenter"
                    full_variant = f"grobid.training.{variant_suffix}"

                    # Determine output filename
                    if full_variant in gold_by_variant:
                        # We have a gold file for this variant
                        # Rename generated file to .generated.tei.xml
                        generated_name = f"{doc_id}.training.{variant_suffix}.generated.tei.xml"
                        gold_name = f"{doc_id}.training.{variant_suffix}.tei.xml"

                        # Add generated file
                        with open(src_path, "r", encoding="utf-8") as f:
                            zf.writestr(generated_name, f.read())

                        # Add gold file
                        zf.writestr(gold_name, gold_by_variant[full_variant])
                    else:
                        # No gold file, just rename with doc_id
                        new_name = f"{doc_id}.training.{variant_suffix}.tei.xml"
                        with open(src_path, "r", encoding="utf-8") as f:
                            zf.writestr(new_name, f.read())

            zip_buffer.seek(0)

            # Generate timestamp for filename
            from datetime import datetime
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            zip_filename = f"{doc_id}-grobid-training-{timestamp}.zip"

            # Return ZIP as streaming response
            return StreamingResponse(
                zip_buffer,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="{zip_filename}"'
                },
            )

        finally:
            # Clean up temp directory
            if settings.application_mode == "production":
                shutil.rmtree(temp_dir, ignore_errors=True)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate GROBID training package: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

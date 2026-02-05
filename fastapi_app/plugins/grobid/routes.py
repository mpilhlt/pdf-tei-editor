"""
Custom routes for GROBID plugin.

Provides download endpoint for GROBID training data packages.
"""

import asyncio
import io
import logging
import os
import shutil
import zipfile
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.sse_utils import ProgressBar, send_notification
from fastapi_app.plugins.grobid.cache import check_cache, cache_training_data
from fastapi_app.plugins.grobid.config import get_grobid_server_url, get_supported_variants

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/grobid", tags=["grobid"])

# Cancellation tokens for in-progress downloads
_cancellation_tokens: dict[str, bool] = {}


class CancellationToken:
    """Simple cancellation token for cooperative cancellation."""

    def __init__(self, progress_id: str):
        self.progress_id = progress_id
        _cancellation_tokens[progress_id] = False

    def cancel(self):
        """Request cancellation."""
        _cancellation_tokens[self.progress_id] = True

    @property
    def is_cancelled(self) -> bool:
        """Check if cancellation was requested."""
        return _cancellation_tokens.get(self.progress_id, False)

    def cleanup(self):
        """Remove token from registry."""
        _cancellation_tokens.pop(self.progress_id, None)


@router.post("/cancel/{progress_id}")
async def cancel_progress(progress_id: str):
    """
    Cancel an in-progress download operation.

    Args:
        progress_id: The progress ID to cancel

    Returns:
        Status of the cancellation request
    """
    if progress_id in _cancellation_tokens:
        _cancellation_tokens[progress_id] = True
        return {"status": "cancelled"}
    return {"status": "not_found"}


@router.get("/download")
async def download_training_package(
    collection: str = Query(..., description="Collection ID"),
    flavor: str = Query("default", description="GROBID processing flavor"),
    force_refresh: bool = Query(False, description="Force re-download from GROBID"),
    gold_only: bool = Query(False, description="Only include documents/variants with gold files"),
    no_progress: bool = Query(True, description="Suppress SSE progress events (for programmatic API use)"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    sse_service=Depends(get_sse_service),
):
    """
    Download GROBID training package for all documents in a collection as ZIP.

    For each document and variant:
    - If gold standard file exists: include gold file as main, GROBID output as .generated
    - If no gold standard file: include GROBID output as main (unless gold_only=True)

    Args:
        collection: Collection ID to process
        flavor: GROBID processing flavor
        force_refresh: Force re-download from GROBID (ignore cached data)
        gold_only: If True, only include variants with gold standard files
        session_id: Session ID from query parameter
        x_session_id: Session ID from header

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

    # Check collection access
    if not user_has_collection_access(user, collection, settings.db_dir):
        raise HTTPException(status_code=403, detail="Access denied to collection")

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get all PDF files in the collection
        all_files = file_repo.get_files_by_collection(collection)
        pdf_files = [f for f in all_files if f.file_type == "pdf" and not f.deleted]

        if not pdf_files:
            raise HTTPException(status_code=404, detail="No PDF files in collection")

        # Get GROBID server URL
        grobid_server_url = get_grobid_server_url()
        if not grobid_server_url:
            raise HTTPException(status_code=503, detail="GROBID server not configured")

        supported_variants = get_supported_variants()

        # Get GROBID version info for cache key
        from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor
        extractor = GrobidTrainingExtractor()
        _, grobid_revision = extractor._get_grobid_version(grobid_server_url)

        # Set up progress tracking with cancellation (only if progress is enabled)
        progress = None
        cancellation_token = None
        if not no_progress:
            progress = ProgressBar(sse_service, session_id_value)
            cancel_url = f"/api/plugins/grobid/cancel/{progress.progress_id}"
            cancellation_token = CancellationToken(progress.progress_id)

            progress.show(
                label=f"Processing {len(pdf_files)} documents...",
                cancellable=True,
                cancel_url=cancel_url
            )
            await asyncio.sleep(0)  # Yield to allow SSE event delivery

        try:
            # Create output ZIP in memory
            zip_buffer = io.BytesIO()
            documents_processed = 0
            documents_skipped = 0

            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                for i, pdf_file in enumerate(pdf_files):
                    # Check for cancellation
                    if cancellation_token and cancellation_token.is_cancelled:
                        send_notification(
                            sse_service, session_id_value,
                            "Download cancelled", "warning"
                        )
                        progress.hide()
                        cancellation_token.cleanup()
                        raise HTTPException(status_code=499, detail="Download cancelled by user")

                    doc_id = pdf_file.doc_id
                    if not doc_id:
                        documents_skipped += 1
                        continue

                    if progress:
                        progress.set_label(f"Document {i+1}/{len(pdf_files)}: {doc_id[:20]}...")
                        progress.set_value(int((i / len(pdf_files)) * 100))
                        await asyncio.sleep(0)  # Yield to allow SSE event delivery

                    # Get PDF file path
                    pdf_path = file_storage.get_file_path(pdf_file.id, "pdf")
                    if not pdf_path:
                        documents_skipped += 1
                        continue

                    # Get all gold standard TEI files for this document
                    doc_files = file_repo.get_files_by_doc_id(doc_id)
                    gold_files = [
                        f for f in doc_files
                        if f.file_type == "tei" and f.is_gold_standard
                    ]

                    # Build map of variant -> gold file
                    gold_by_variant = {}
                    for gold_file in gold_files:
                        if gold_file.variant in supported_variants:
                            content = file_storage.read_file(gold_file.id, "tei")
                            if content:
                                gold_by_variant[gold_file.variant] = content.decode("utf-8")

                    # Determine which variants to process
                    if gold_only:
                        if not gold_by_variant:
                            documents_skipped += 1
                            continue
                        variants_to_process = list(gold_by_variant.keys())
                    else:
                        variants_to_process = supported_variants

                    # Check cache first
                    cached_data = check_cache(doc_id, grobid_revision, force_refresh)

                    if cached_data:
                        temp_dir = cached_data["temp_dir"]
                        extracted_files = cached_data["files"]
                    else:
                        try:
                            # Run blocking GROBID fetch in thread pool to allow SSE events
                            temp_dir, extracted_files = await asyncio.to_thread(
                                extractor._fetch_training_package,
                                str(pdf_path), grobid_server_url, flavor
                            )
                            # Cache the training data
                            cache_training_data(doc_id, grobid_revision, temp_dir, extracted_files)
                        except Exception as e:
                            logger.warning(f"Failed to fetch training data for {doc_id}: {e}")
                            documents_skipped += 1
                            continue

                    try:
                        if gold_only:
                            # Only include supported variants that have gold files
                            for variant in variants_to_process:
                                has_gold = variant in gold_by_variant

                                # Find the GROBID output file for this variant
                                variant_suffix = variant.removeprefix("grobid.")
                                grobid_file = None
                                for filename in extracted_files:
                                    if filename.endswith(f".{variant_suffix}.tei.xml"):
                                        grobid_file = os.path.join(temp_dir, filename)
                                        break

                                if not grobid_file or not os.path.exists(grobid_file):
                                    continue

                                # Read GROBID output
                                with open(grobid_file, "r", encoding="utf-8") as f:
                                    grobid_content = f.read()

                                # Add files to ZIP in doc_id subdirectory
                                if has_gold:
                                    # Gold file as main, GROBID as .generated
                                    gold_name = f"{doc_id}/{doc_id}.{variant_suffix}.tei.xml"
                                    generated_name = f"{doc_id}/{doc_id}.{variant_suffix}.generated.tei.xml"
                                    zf.writestr(gold_name, gold_by_variant[variant])
                                    zf.writestr(generated_name, grobid_content)
                                else:
                                    # GROBID as main (no .generated suffix)
                                    main_name = f"{doc_id}/{doc_id}.{variant_suffix}.tei.xml"
                                    zf.writestr(main_name, grobid_content)
                        else:
                            # Include ALL files from GROBID package
                            # Gold files replace originals, originals get .generated infix
                            for filename in extracted_files:
                                src_path = os.path.join(temp_dir, filename)
                                if not os.path.exists(src_path):
                                    continue

                                # Extract suffix after hash prefix
                                # e.g., "hash.training.segmentation.tei.xml" -> "training.segmentation.tei.xml"
                                parts = filename.split(".", 1)
                                if len(parts) < 2:
                                    continue
                                file_suffix = parts[1]

                                # Check if this file has a corresponding gold file
                                matching_gold_variant = None
                                for variant in gold_by_variant:
                                    variant_suffix = variant.removeprefix("grobid.")
                                    if file_suffix == f"{variant_suffix}.tei.xml":
                                        matching_gold_variant = variant
                                        break

                                if matching_gold_variant:
                                    # Gold replaces original, original gets .generated infix
                                    base = file_suffix[:-8]  # Remove ".tei.xml"
                                    gold_name = f"{doc_id}/{doc_id}.{file_suffix}"
                                    generated_name = f"{doc_id}/{doc_id}.{base}.generated.tei.xml"
                                    zf.writestr(gold_name, gold_by_variant[matching_gold_variant])
                                    with open(src_path, "r", encoding="utf-8") as f:
                                        zf.writestr(generated_name, f.read())
                                else:
                                    # No gold - include file as-is with doc_id prefix
                                    dest_name = f"{doc_id}/{doc_id}.{file_suffix}"
                                    zf.write(src_path, dest_name)

                        documents_processed += 1

                    finally:
                        # Clean up temp directory in production mode
                        if settings.application_mode == "production" and not cached_data:
                            shutil.rmtree(temp_dir, ignore_errors=True)

            # Hide progress and clean up
            if progress:
                progress.hide()
            if cancellation_token:
                cancellation_token.cleanup()

            if documents_processed == 0:
                raise HTTPException(
                    status_code=404,
                    detail=f"No documents could be processed. {documents_skipped} skipped."
                )

            zip_buffer.seek(0)

            # Generate timestamp for filename
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            zip_filename = f"{collection}-training-data-{timestamp}.zip"

            # Send success notification (only if progress is enabled)
            if not no_progress:
                send_notification(
                    sse_service, session_id_value,
                    f"Processed {documents_processed} documents ({documents_skipped} skipped)",
                    "success"
                )

            # Return ZIP as streaming response
            return StreamingResponse(
                zip_buffer,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="{zip_filename}"'
                },
            )

        except HTTPException:
            if progress:
                progress.hide()
            if cancellation_token:
                cancellation_token.cleanup()
            raise
        except Exception as e:
            if progress:
                progress.hide()
            if cancellation_token:
                cancellation_token.cleanup()
            raise e

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate GROBID training package: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# XSLT for extracting bibliographic references from TEI documents
BIBL_STRUCT_XSLT = '''<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:tei="http://www.tei-c.org/ns/1.0">

  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/">
    <html>
      <head>
        <style>
          body { font-family: system-ui, sans-serif; padding: 16px; line-height: 1.5; }
          h2 { margin-top: 0; color: #333; }
          ol { padding-left: 24px; }
          li { margin-bottom: 8px; padding: 8px; background: #f5f5f5; border-radius: 4px; }
          .count { color: #666; font-size: 0.9em; margin-bottom: 16px; }
        </style>
      </head>
      <body>
        <h2>Bibliographic References</h2>
        <p class="count">
          <xsl:value-of select="count(//tei:biblStruct)"/> references found
        </p>
        <ol>
          <xsl:apply-templates select="//tei:biblStruct"/>
        </ol>
      </body>
    </html>
  </xsl:template>

  <xsl:template match="tei:biblStruct">
    <li>
      <xsl:value-of select="normalize-space(.)"/>
    </li>
  </xsl:template>

</xsl:stylesheet>'''


@router.get("/xslt/bibl-struct")
async def get_bibl_struct_xslt():
    """
    Return XSLT stylesheet for extracting biblStruct elements from TEI documents.

    Returns:
        XSLT document as text/xml
    """
    from fastapi.responses import PlainTextResponse

    return PlainTextResponse(
        content=BIBL_STRUCT_XSLT,
        media_type="application/xslt+xml"
    )

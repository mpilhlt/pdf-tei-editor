"""
Custom routes for GROBID plugin.

Provides download endpoint for GROBID training data packages, and the Grobid
Trainer dashboard for managing model training and evaluation.
"""

import asyncio
import io
import logging
import os
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.sse.sse_utils import ProgressBar, send_notification
from fastapi_app.plugins.grobid.cache import check_cache, cache_training_data, get_cache_dir
from fastapi_app.plugins.grobid.config import (
    get_grobid_server_url,
    get_grobid_trainer_url,
    get_supported_variants,
    get_variant_to_trainer_model,
)

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
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.permissions.user_utils import user_has_collection_access

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
                        progress.hide() # type:ignore
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
                                extractor._fetch_training_package, # type:ignore
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


# ---------------------------------------------------------------------------
# Grobid Trainer Dashboard routes
# ---------------------------------------------------------------------------

# Mapping from Grobid trainer model names to training file suffixes (without hash prefix)
_TRAINER_MODEL_SUFFIXES: dict[str, list[str]] = {
    "segmentation": [".training.segmentation", ".training.segmentation.tei.xml"],
    "header": [".training.header", ".training.header.tei.xml"],
    "citation": [".training.references.tei.xml"],
    "reference-segmentation": [
        ".training.references.referenceSegmenter",
        ".training.references.referenceSegmenter.tei.xml",
    ],
    "fulltext": [".training.fulltext", ".training.fulltext.tei.xml"],
    "figure": [".training.figure.tei.xml"],
    "table": [".training.table.tei.xml"],
    "name-header": [".training.header.authors.tei.xml"],
    "name-citation": [".training.references.authors.tei.xml"],
    "affiliation-address": [".training.header.affiliation.tei.xml"],
}


def _authenticate_admin(
    x_session_id: str | None,
    session_id: str | None,
    session_manager,
    auth_manager,
) -> tuple[str, dict]:
    """Validate session and require admin role. Returns (session_id_value, user)."""
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

    roles = user.get("roles", [])
    if "admin" not in roles:
        raise HTTPException(status_code=403, detail="Admin role required")

    return session_id_value, user


def _get_latest_cached_zip(doc_id: str) -> Path | None:
    """Return the most recently modified training.zip for a doc_id, or None."""
    cache_dir = get_cache_dir()
    matches: list[tuple[float, Path]] = []
    for p in cache_dir.iterdir():
        if p.is_dir() and (p.name == doc_id or p.name.startswith(f"{doc_id}_")):
            zip_path = p / "training.zip"
            if zip_path.exists():
                matches.append((zip_path.stat().st_mtime, zip_path))
    if not matches:
        return None
    return max(matches)[1]


async def _fetch_and_cache(
    doc_id: str,
    pdf_path: str | Path,
    grobid_server_url: str,
    flavor: str,
    grobid_revision: str,
) -> bool:
    """Fetch training data from GROBID for one document and store it in the cache.

    Returns True on success, False if the fetch failed.
    """
    from fastapi_app.plugins.grobid.handlers.training import TrainingHandler

    handler = TrainingHandler()
    try:
        temp_dir, files = await asyncio.to_thread(
            handler._fetch_training_package,
            str(pdf_path),
            grobid_server_url,
            flavor,
        )
        cache_training_data(doc_id, grobid_revision, temp_dir, files)
        return True
    except Exception as e:
        logger.warning(f"Failed to fetch training data for {doc_id}: {e}")
        return False


async def _proxy_json(method: str, path: str, **kwargs) -> dict:
    """Forward a JSON request to the Grobid Trainer service."""
    url = get_grobid_trainer_url().rstrip("/") + path
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.request(method, url, **kwargs)
            response.raise_for_status()
            return response.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Grobid Trainer service is not reachable")
    except httpx.HTTPStatusError as e:
        try:
            detail = e.response.json().get("detail", e.response.text)
        except Exception:
            detail = e.response.text
        raise HTTPException(status_code=e.response.status_code, detail=detail)


@router.get("/trainer/dashboard", response_class=HTMLResponse)
async def trainer_dashboard(
    collection: str = Query(""),
    variant: str = Query(""),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> HTMLResponse:
    """Serve the Grobid Trainer dashboard HTML page."""
    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    session_id_value, _ = _authenticate_admin(
        x_session_id, session_id, session_manager, auth_manager
    )
    import json as _json
    html = load_plugin_html(__file__, "trainer_dashboard.html")
    html = html.replace("{{ SESSION_ID }}", session_id_value)
    html = html.replace("{{ COLLECTION }}", collection)
    html = html.replace("{{ VARIANT }}", variant)
    html = html.replace("{{ VARIANT_MODEL_MAP }}", _json.dumps(get_variant_to_trainer_model()))
    return HTMLResponse(content=html)


@router.get("/trainer/eval-report", response_class=HTMLResponse)
async def trainer_eval_report(
    model: str = Query(""),
    flavor: str = Query(""),
    file: str = Query(""),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> HTMLResponse:
    """Serve the evaluation comparison report page."""
    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    session_id_value, _ = _authenticate_admin(
        x_session_id, session_id, session_manager, auth_manager
    )
    html = load_plugin_html(__file__, "trainer_eval_report.html", inject_sandbox=False)
    html = html.replace("{{ SESSION_ID }}", session_id_value)
    html = html.replace("{{ MODEL }}", model)
    html = html.replace("{{ FLAVOR }}", flavor)
    html = html.replace("{{ FILE }}", file)
    return HTMLResponse(content=html)


@router.get("/trainer/log/{job_id}", response_class=HTMLResponse)
async def trainer_log_stream_page(
    job_id: str,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> HTMLResponse:
    """Serve the SSE log viewer page for a job."""
    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    session_id_value, _ = _authenticate_admin(
        x_session_id, session_id, session_manager, auth_manager
    )
    html = load_plugin_html(__file__, "trainer_log_stream.html", inject_sandbox=False)
    html = html.replace("{{ SESSION_ID }}", session_id_value)
    html = html.replace("{{ JOB_ID }}", job_id)
    return HTMLResponse(content=html)


@router.get("/trainer/api/extraction-health")
async def trainer_extraction_health(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    """Return health status of the GROBID extraction server."""
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    url = get_grobid_server_url()
    if not url:
        return {"ok": False, "detail": "GROBID_SERVER_URL not configured"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{url.rstrip('/')}/api/version")
            r.raise_for_status()
            return {"ok": True, "version": r.text.strip()}
    except httpx.ConnectError:
        return {"ok": False, "detail": f"Cannot connect to {url}"}
    except Exception as e:
        return {"ok": False, "detail": str(e)}


@router.get("/trainer/api/health")
async def trainer_health(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("GET", "/health")


@router.get("/trainer/api/jobs")
async def trainer_list_jobs(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> list:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("GET", "/jobs")


@router.get("/trainer/api/jobs/{job_id}")
async def trainer_get_job(
    job_id: str,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("GET", f"/jobs/{job_id}")


@router.post("/trainer/api/jobs/{job_id}/stop")
async def trainer_stop_job(
    job_id: str,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("POST", f"/jobs/{job_id}/stop")


@router.get("/trainer/api/jobs/{job_id}/stream")
async def trainer_stream_job(
    job_id: str,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> StreamingResponse:
    """Proxy SSE stream from Grobid Trainer service to the client."""
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    trainer_url = get_grobid_trainer_url().rstrip("/")

    async def event_generator():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "GET", f"{trainer_url}/jobs/{job_id}/stream"
                ) as response:
                    async for chunk in response.aiter_text():
                        yield chunk
        except httpx.ConnectError:
            yield "event: error\ndata: Grobid Trainer service is not reachable\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.delete("/trainer/api/jobs/{job_id}")
async def trainer_delete_job(
    job_id: str,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("DELETE", f"/jobs/{job_id}")


@router.delete("/trainer/api/jobs")
async def trainer_delete_all_jobs(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("DELETE", "/jobs")


@router.get("/trainer/api/models/{model_name}")
async def trainer_list_model_files(
    model_name: str,
    flavor: str | None = Query(None),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    params = {}
    if flavor:
        params["flavor"] = flavor
    return await _proxy_json("GET", f"/models/{model_name}", params=params)


@router.delete("/trainer/api/models/{model_name}")
async def trainer_delete_model_file(
    model_name: str,
    name: str = Query(...),
    flavor: str | None = Query(None),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    params = {"name": name}
    if flavor:
        params["flavor"] = flavor
    return await _proxy_json("DELETE", f"/models/{model_name}", params=params)


@router.get("/trainer/api/flavors")
async def trainer_list_flavors(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("GET", "/flavors")


@router.post("/trainer/api/train/{model_name}")
async def trainer_start_training(
    model_name: str,
    body: dict = Body(default={}),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("POST", f"/train/{model_name}", json=body)


@router.post("/trainer/api/evaluate/{eval_type}")
async def trainer_start_evaluation(
    eval_type: str,
    body: dict = Body(default={}),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("POST", f"/evaluate/{eval_type}", json=body)


@router.get("/trainer/api/uploads")
async def trainer_list_uploads(
    model: str | None = Query(None),
    flavor: str | None = Query(None),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> list:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    params = {}
    if model:
        params["model"] = model
    if flavor:
        params["flavor"] = flavor
    return await _proxy_json("GET", "/uploads", params=params)


@router.get("/trainer/api/uploads/{batch_id}")
async def trainer_get_upload(
    batch_id: str,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("GET", f"/uploads/{batch_id}")


@router.post("/trainer/api/revert/{batch_id}")
async def trainer_revert_upload(
    batch_id: str,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> dict:
    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)
    return await _proxy_json("POST", f"/revert/{batch_id}")


@router.post("/trainer/api/upload")
async def trainer_upload_collection(
    body: dict = Body(...),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
    file_storage=Depends(get_file_storage),
) -> dict:
    """
    Package GROBID training data for a collection and upload to the Grobid Trainer
    service. Uses cached data when available; fetches from GROBID for documents that
    have not yet been cached.

    Body fields:
        model_name: Target Grobid model (e.g. "segmentation")
        collection: PDF-TEI editor collection ID
        flavor: Grobid trainer flavor (optional)
        variant: Application variant identifier (not used as flavor)
        batch_name: Optional human-readable label for the uploaded batch
    """
    from fastapi_app.lib.repository.file_repository import FileRepository

    _authenticate_admin(x_session_id, session_id, session_manager, auth_manager)

    model_name = body.get("model_name", "").strip()
    collection = body.get("collection", "").strip()
    variant = body.get("variant", "").strip()
    flavor = (body.get("flavor") or "").strip()
    batch_name = body.get("batch_name", "").strip()

    if not model_name:
        raise HTTPException(status_code=422, detail="model_name is required")
    if not collection:
        raise HTTPException(status_code=422, detail="collection is required")

    suffixes = _TRAINER_MODEL_SUFFIXES.get(model_name)
    if suffixes is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown model '{model_name}'. Known models: {list(_TRAINER_MODEL_SUFFIXES)}"
        )

    file_repo = FileRepository(db)
    all_files = file_repo.get_files_by_collection(collection)
    pdf_files = [f for f in all_files if f.file_type == "pdf" and not f.deleted]

    if not pdf_files:
        raise HTTPException(status_code=404, detail="No PDF files in collection")

    # Resolve GROBID server for on-demand fetching when cache is missing
    grobid_server_url = get_grobid_server_url()
    grobid_revision = "unknown"
    grobid_available = False
    if grobid_server_url:
        from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor
        try:
            _, grobid_revision = GrobidTrainingExtractor()._get_grobid_version(grobid_server_url)
            grobid_available = True
        except Exception as e:
            logger.warning(f"GROBID server unreachable at {grobid_server_url}: {e}")

    # Build the upload ZIP in memory
    upload_buffer = io.BytesIO()
    files_added: list[str] = []
    docs_without_cache: list[str] = []
    docs_fetch_failed: list[str] = []

    with zipfile.ZipFile(upload_buffer, "w", zipfile.ZIP_DEFLATED) as out_zip:
        for pdf in pdf_files:
            doc_id = pdf.doc_id
            if not doc_id:
                continue

            cached_zip_path = _get_latest_cached_zip(doc_id)
            if cached_zip_path is None and grobid_available:
                pdf_path = file_storage.get_file_path(pdf.id, "pdf")
                if pdf_path:
                    ok = await _fetch_and_cache(
                        doc_id, pdf_path, grobid_server_url,
                        flavor or "default", grobid_revision,
                    )
                    if ok:
                        cached_zip_path = _get_latest_cached_zip(doc_id)
                    else:
                        docs_fetch_failed.append(doc_id)

            if cached_zip_path is None:
                docs_without_cache.append(doc_id)
                continue

            with zipfile.ZipFile(cached_zip_path, "r") as src_zip:
                for name in src_zip.namelist():
                    # Strip hash prefix: "hash.training.segmentation.tei.xml" → ".training.segmentation.tei.xml"
                    dot_idx = name.find(".")
                    if dot_idx == -1:
                        continue
                    suffix = name[dot_idx:]  # e.g. ".training.segmentation.tei.xml"
                    if suffix not in suffixes:
                        continue
                    new_name = doc_id + suffix
                    data = src_zip.read(name)
                    out_zip.writestr(new_name, data)
                    files_added.append(new_name)

    if not files_added:
        parts = [f"No matching training files found for model '{model_name}'."]
        if not grobid_server_url:
            parts.append("GROBID server URL is not configured (GROBID_SERVER_URL); cannot fetch missing training data.")
        elif not grobid_available:
            parts.append(f"GROBID server at {grobid_server_url} was unreachable.")
        if docs_fetch_failed:
            parts.append(f"{len(docs_fetch_failed)} document(s) failed to fetch from GROBID.")
        if docs_without_cache:
            parts.append(f"{len(docs_without_cache)} document(s) had no cached training data.")
        raise HTTPException(status_code=404, detail=" ".join(parts))

    upload_buffer.seek(0)
    zip_bytes = upload_buffer.read()

    trainer_url = get_grobid_trainer_url().rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{trainer_url}/upload/{model_name}",
                files={"file": ("training.zip", zip_bytes, "application/zip")},
                data={"flavor": flavor, "batch_name": batch_name},
            )
            response.raise_for_status()
            result = response.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Grobid Trainer service is not reachable")
    except httpx.HTTPStatusError as e:
        try:
            detail = e.response.json().get("detail", e.response.text)
        except Exception:
            detail = e.response.text
        raise HTTPException(status_code=e.response.status_code, detail=detail)

    if docs_without_cache:
        result["docs_without_cache"] = docs_without_cache

    return result

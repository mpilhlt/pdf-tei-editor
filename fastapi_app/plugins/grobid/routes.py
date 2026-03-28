"""
Custom routes for GROBID plugin.

Provides download endpoint for GROBID training data packages and a diagnostics
endpoint for debugging connectivity issues with the GROBID server.
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

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.utils.auth import AuthManager
from fastapi_app.lib.sse.sse_service import SSEService
from fastapi_app.lib.sse.sse_utils import ProgressBar, send_notification
from fastapi_app.lib.permissions.acl_utils import user_is_admin
from fastapi_app.plugins.grobid.cache import check_cache, cache_training_data
from fastapi_app.plugins.grobid.config import get_grobid_server_url, get_model_path, get_grobid_server_timeout

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/grobid", tags=["grobid"])


def _corpus_base_path(tei_content: str, variant: str, fallback_flavor: str) -> str:
    """
    Derive the corpus base path from TEI header labels.

    Reads model and flavor from encodingDesc/appInfo/application[@type='extractor'].
    Tries both namespaced and un-namespaced XPath because the actual namespace of
    encodingDesc elements depends on how the TEI was created and serialized.

    Falls back to parsing variant and fallback_flavor if labels are absent.
    For the default flavor the path is ``{model}/corpus``; otherwise
    ``{model}/{flavor}/corpus``.
    """
    from lxml import etree
    NS = "http://www.tei-c.org/ns/1.0"

    def _find_app(root: etree._Element) -> etree._Element | None:  # type: ignore[name-defined]
        """Find application[@type='extractor'] trying both namespace variants."""
        return (
            root.find(".//encodingDesc/appInfo/application[@type='extractor']")
            or root.find(
                f".//{{{NS}}}encodingDesc/{{{NS}}}appInfo"
                f"/{{{NS}}}application[@type='extractor']"
            )
        )

    def _find_label(app: etree._Element, label_type: str) -> str | None:  # type: ignore[name-defined]
        """Find label text by type, trying both namespace variants."""
        el = app.find(f"label[@type='{label_type}']") or app.find(
            f"{{{NS}}}label[@type='{label_type}']"
        )
        return el.text if el is not None and el.text else None

    try:
        parser = etree.XMLParser(recover=True)
        root = etree.fromstring(tei_content.encode("utf-8"), parser)
        app = _find_app(root)
        if app is not None:
            tei_flavor = _find_label(app, "flavor") or fallback_flavor
            variant_id_label = _find_label(app, "variant-id") or ""
            model = (
                _find_label(app, "model")
                or (get_model_path(variant_id_label) if variant_id_label else "")
                or get_model_path(variant)
            )
            if tei_flavor == "default":
                return f"{model}/corpus"
            return f"{model}/{tei_flavor}/corpus"
    except Exception:
        pass
    # Last-resort fallback: derive from variant + fallback_flavor
    model_path = get_model_path(variant)
    if fallback_flavor == "default":
        return f"{model_path}/corpus"
    return f"{model_path}/{fallback_flavor}/corpus"


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


@router.get("/diagnostics")
async def grobid_diagnostics(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
):
    """
    Run connectivity diagnostics for the GROBID server.

    Performs layered checks to distinguish between general network outages,
    DNS failures, TLS issues, and GROBID-specific problems:

    1. Environment: proxy env vars and configured GROBID URL.
    2. DNS resolution of the GROBID hostname.
    3. TCP connection to port 443.
    4. TLS handshake.
    5. HTTPS GET to a neutral public URL (https://1.1.1.1) to verify general
       internet access independent of the GROBID host.
    6. GROBID /api/health request with the configured timeout.

    Admin role required.
    """
    import platform
    import socket
    import ssl
    import sys
    import time
    from urllib.parse import urlparse

    import requests as _requests

    from fastapi_app.config import get_settings

    # Auth
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    if not user_is_admin(user):
        raise HTTPException(status_code=403, detail="Admin role required")

    def _check(label: str, fn):
        """Run fn(), return a result dict with status/duration/detail."""
        t0 = time.monotonic()
        try:
            detail = fn()
            return {"check": label, "status": "ok", "duration_ms": round((time.monotonic() - t0) * 1000), "detail": detail}
        except Exception as exc:
            return {"check": label, "status": "fail", "duration_ms": round((time.monotonic() - t0) * 1000), "detail": str(exc)}

    results: list[dict] = []

    # 1 – Environment
    grobid_url = get_grobid_server_url()
    timeout = get_grobid_server_timeout()
    proxy_vars = {k: os.environ.get(k) for k in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy") if os.environ.get(k)}
    results.append({
        "check": "environment",
        "status": "ok",
        "detail": {
            "python": sys.version,
            "platform": platform.platform(),
            "grobid_url": grobid_url,
            "grobid_timeout_s": timeout,
            "proxy_env": proxy_vars,
        },
    })

    if not grobid_url:
        results.append({"check": "grobid_url_configured", "status": "fail", "detail": "GROBID_SERVER_URL is not set"})
        return {"checks": results}

    parsed = urlparse(grobid_url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    # 2 – DNS
    def _dns():
        addrs = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        return [a[4][0] for a in addrs]

    dns_result = _check(f"dns_resolution:{host}", _dns)
    results.append(dns_result)

    # 3 – TCP (only if DNS succeeded)
    if dns_result["status"] == "ok":
        def _tcp():
            with socket.create_connection((host, port), timeout=10) as s:
                return f"connected to {s.getpeername()}"

        tcp_result = _check(f"tcp_connect:{host}:{port}", _tcp)
        results.append(tcp_result)

        # 4 – TLS (only if TCP succeeded and scheme is https)
        if tcp_result["status"] == "ok" and parsed.scheme == "https":
            def _tls():
                ctx = ssl.create_default_context()
                with socket.create_connection((host, port), timeout=10) as raw:
                    with ctx.wrap_socket(raw, server_hostname=host) as tls:
                        cert = tls.getpeercert()
                        subject = {k: v for rdn in ((cert or {}).get("subject") or ()) for k, v in rdn}
                        return {"cipher": tls.cipher(), "subject": subject}

            results.append(_check(f"tls_handshake:{host}:{port}", _tls))

    # 5 – General internet access (neutral URL, bypasses GROBID host issues)
    def _internet():
        resp = _requests.get("https://1.1.1.1", timeout=10, allow_redirects=False)
        return {"status_code": resp.status_code, "elapsed_ms": round(resp.elapsed.total_seconds() * 1000)}

    results.append(_check("internet_access:1.1.1.1", _internet))

    # 6 – GROBID health endpoint
    def _grobid_health():
        health_url = grobid_url.rstrip("/") + "/api/health"
        resp = _requests.get(health_url, timeout=timeout)
        return {"status_code": resp.status_code, "elapsed_ms": round(resp.elapsed.total_seconds() * 1000), "body": resp.text[:500]}

    results.append(_check("grobid_health", _grobid_health))

    return {"checks": results}


@router.get("/download")
async def download_training_package(
    collection: str = Query(..., description="Collection ID"),
    flavor: str = Query("default", description="GROBID processing flavor"),
    force_refresh: bool = Query(False, description="Force re-download from GROBID"),
    no_progress: bool = Query(True, description="Suppress SSE progress events (for programmatic API use)"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
    sse_service: SSEService = Depends(get_sse_service),
):
    """
    Download GROBID training package for all documents in a collection as ZIP.

    Only documents with gold standard TEI files are included. The ZIP mirrors
    the grobid-trainer/resources/dataset/ folder structure and can be dropped
    directly into that directory.

    ZIP structure:
        {model}/{flavor}/corpus/tei/{doc_id}.{model_name}.tei.xml  ← gold TEI annotation
        {model}/{flavor}/corpus/raw/{doc_id}           ← GROBID raw feature file

    Args:
        collection: Collection ID to process
        flavor: GROBID processing flavor (e.g. "default", "article/dh-law-footnotes")
        force_refresh: Force re-download from GROBID (ignore cached data)
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

        # Get GROBID version info for cache key
        from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor
        from fastapi_app.plugins.grobid.handlers.training import TrainingHandler
        from fastapi_app.plugins.grobid.handlers.training import denormalize_grobid_content
        extractor = GrobidTrainingExtractor()
        training_handler = TrainingHandler()
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
            # Generate filename before writing so it can be used as the top-level dir
            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            zip_stem = f"{collection}-training-data-{timestamp}"
            zip_filename = f"{zip_stem}.zip"

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

                    # Get all gold standard training TEI files for this document
                    doc_files = file_repo.get_files_by_doc_id(doc_id)
                    gold_files = [
                        f for f in doc_files
                        if f.file_type == "tei"
                        and f.is_gold_standard
                        and f.variant
                        and f.variant.startswith("grobid.training.")
                    ]

                    # Build map of variant -> gold file content
                    gold_by_variant: dict[str, str] = {}
                    for gold_file in gold_files:
                        content = file_storage.read_file(gold_file.id, "tei")
                        if content and gold_file.variant:
                            gold_by_variant[gold_file.variant] = content.decode("utf-8")

                    # Skip documents without any gold standard files
                    if not gold_by_variant:
                        documents_skipped += 1
                        continue
                    variants_to_process = list(gold_by_variant.keys())

                    # Check cache first
                    cached_data = check_cache(doc_id, grobid_revision, force_refresh)

                    if cached_data:
                        temp_dir = cached_data["temp_dir"]
                        extracted_files = cached_data["files"]
                    else:
                        try:
                            # Run blocking GROBID fetch in thread pool to allow SSE events
                            temp_dir, extracted_files = await asyncio.to_thread(
                                training_handler._fetch_training_package,
                                str(pdf_path), grobid_server_url, flavor
                            )
                            # Cache the training data
                            cache_training_data(doc_id, grobid_revision, temp_dir, extracted_files)
                        except Exception as e:
                            logger.warning(f"Failed to fetch training data for {doc_id}: {e}")
                            documents_skipped += 1
                            continue

                    try:
                        for variant in variants_to_process:
                            grobid_suffix = variant.removeprefix("grobid.")
                            tei_content = denormalize_grobid_content(gold_by_variant[variant], variant)
                            base_path = _corpus_base_path(tei_content, variant, flavor)
                            model_name = variant.removeprefix("grobid.")

                            # Write gold TEI to corpus/tei/
                            zf.writestr(
                                f"{zip_stem}/{base_path}/tei/{doc_id}.{model_name}.tei.xml",
                                tei_content
                            )

                            # Write raw feature file to corpus/raw/ (no extension)
                            raw_file = next(
                                (f for f in extracted_files
                                 if f.endswith(f".{grobid_suffix}") and not f.endswith(".tei.xml")),
                                None
                            )
                            if raw_file:
                                raw_path = os.path.join(temp_dir, raw_file)
                                if os.path.exists(raw_path):
                                    zf.write(raw_path, f"{zip_stem}/{base_path}/raw/{doc_id}.{grobid_suffix}")

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

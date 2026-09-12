"""
Core logic for the GROBID "reload feature file" reviewer action.

Separated from plugin.py (the trigger endpoint) and routes.py (the preview/
execute HTTP routes) so both can share the same precondition checks and
business logic without duplicating it. See the "Reload feature file" section
of README.md for the full rationale.
"""

import asyncio
import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from fastapi_app.lib.models.models import FileMetadata, FileUpdate
from fastapi_app.lib.plugins.plugin_tools import (
    escape_html,
    wrap_html_with_sandbox_client,
)
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.plugins.grobid.cache import cache_training_data
from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor
from fastapi_app.plugins.grobid.handlers.training import TrainingHandler
from fastapi_app.plugins.grobid.sync import parse_encoding_labels, set_revision_label


class ReloadPreconditionError(Exception):
    """Raised when the target document cannot be resolved for a reload."""


@dataclass
class ReloadTarget:
    """The document a feature-file reload would act on."""

    file_meta: FileMetadata
    tei_content: str
    doc_id: str
    variant_id: str
    flavor: str
    old_revision: str | None
    pdf_path: Path


@dataclass
class ReloadResult:
    """Outcome of actually performing the reload."""

    grobid_revision: str
    updated_label: bool

    @property
    def message(self) -> str:
        message = f"Feature file refreshed for GROBID revision '{self.grobid_revision}'."
        if self.updated_label:
            message += " Document revision label updated to match."
        return message


def resolve_reload_target(
    file_repo: FileRepository, file_storage: FileStorage, stable_id: str
) -> ReloadTarget:
    """
    Resolve and validate the document a feature-file reload would target.

    Read-only: does not contact GROBID or write anything. Raises
    ReloadPreconditionError with a user-facing message if the document
    cannot be resolved.
    """
    file_meta = file_repo.get_file_by_stable_id(stable_id)
    if not file_meta or file_meta.file_type != "tei":
        raise ReloadPreconditionError("No TEI document open.")

    content_bytes = file_storage.read_file(file_meta.id, "tei")
    if not content_bytes:
        raise ReloadPreconditionError("File content not found.")
    tei_content = content_bytes.decode("utf-8")

    labels = parse_encoding_labels(tei_content)
    variant_id = labels.get("variant-id")
    if not variant_id or not variant_id.startswith("grobid.training."):
        raise ReloadPreconditionError("Not a GROBID training document.")

    doc_id = file_meta.doc_id
    pdf_file = file_repo.get_pdf_for_document(doc_id)
    if not pdf_file:
        raise ReloadPreconditionError("No PDF found for this document.")
    pdf_path = file_storage.get_file_path(pdf_file.id, "pdf")
    if not pdf_path:
        raise ReloadPreconditionError("PDF file not found in storage.")

    return ReloadTarget(
        file_meta=file_meta,
        tei_content=tei_content,
        doc_id=doc_id,
        variant_id=variant_id,
        flavor=labels.get("flavor", "default"),
        old_revision=labels.get("revision"),
        pdf_path=pdf_path,
    )


def check_grobid_revision(grobid_server_url: str) -> tuple[str, str]:
    """Check GROBID health and return (version, revision). Raises RuntimeError on failure."""
    extractor = GrobidTrainingExtractor()
    extractor._check_grobid_health(grobid_server_url)
    return extractor._get_grobid_version(grobid_server_url)


async def perform_reload(
    target: ReloadTarget,
    grobid_server_url: str,
    file_repo: FileRepository,
    file_storage: FileStorage,
) -> ReloadResult:
    """
    Re-fetch the training package from GROBID and refresh the cache entry.

    Overwrites the training-data cache for (doc_id, current GROBID revision).
    If that revision differs from the one recorded in the TEI, patches the
    `revision` label in place (same stable_id, no new version) - the
    `<text>` content and any human corrections are never touched.

    Raises RuntimeError if GROBID is unreachable or the fetch fails.
    """
    _, grobid_revision = check_grobid_revision(grobid_server_url)

    training_handler = TrainingHandler()
    temp_dir, extracted_files = await asyncio.to_thread(
        training_handler._fetch_training_package,
        str(target.pdf_path),
        grobid_server_url,
        target.flavor,
    )
    try:
        cache_training_data(target.doc_id, grobid_revision, temp_dir, extracted_files)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    updated_label = False
    if target.old_revision and target.old_revision != grobid_revision:
        new_content = set_revision_label(target.tei_content, target.old_revision, grobid_revision)
        if new_content != target.tei_content:
            new_bytes = new_content.encode("utf-8")
            saved_hash, _ = file_storage.save_file(
                new_bytes, target.file_meta.file_type, increment_ref=False
            )
            if saved_hash != target.file_meta.id:
                file_repo.update_file(
                    target.file_meta.id,
                    FileUpdate(id=saved_hash, file_size=len(new_bytes)),
                )
                updated_label = True

    return ReloadResult(grobid_revision=grobid_revision, updated_label=updated_label)


_PAGE_STYLE = """
body { font-family: sans-serif; padding: 20px; max-width: 700px; margin: 0 auto; }
h2 { color: #333; border-bottom: 2px solid #ddd; padding-bottom: 10px; }
.notice { background: #fff3cd; border: 1px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }
.notice strong { color: #856404; }
table { border-collapse: collapse; margin: 15px 0; width: 100%; }
th, td { text-align: left; padding: 6px 12px; border-bottom: 1px solid #ddd; }
.error { color: #842029; background: #f8d7da; border: 1px solid #f5c2c7; padding: 12px; border-radius: 4px; }
.success { color: #0f5132; background: #d1e7dd; border: 1px solid #badbcc; padding: 12px; border-radius: 4px; }
"""


def _page(body: str) -> str:
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<title>Reload GROBID Feature File</title>"
        f"<style>{_PAGE_STYLE}</style></head><body>"
        f"<h2>Reload GROBID Feature File</h2>{body}</body></html>"
    )


def render_precondition_error_html(message: str) -> str:
    """Render the preview page shown when the document cannot be resolved."""
    return _page(f"<div class='error'>{escape_html(message)}</div>")


def render_preview_html(
    target: ReloadTarget, live_revision: str | None, live_error: str | None
) -> str:
    """Render the reviewer confirmation page shown before executing a reload."""
    if live_error:
        revision_html = (
            f"<p class='error'>Could not reach the GROBID server: {escape_html(live_error)}. "
            "Execute may fail.</p>"
        )
    else:
        will_update = bool(
            live_revision and target.old_revision and live_revision != target.old_revision
        )
        revision_html = (
            "<table>"
            f"<tr><th>Document revision label</th><td>{escape_html(target.old_revision or '(none)')}</td></tr>"
            f"<tr><th>Current GROBID server revision</th><td>{escape_html(live_revision or 'unknown')}</td></tr>"
            "</table>"
        )
        revision_html += (
            "<p>The document's revision label will be updated to match.</p>"
            if will_update
            else "<p>The document's revision label is already current and will not change.</p>"
        )

    body = (
        "<div class='notice'><strong>This is a special-case action.</strong> "
        "It re-fetches the training data for this document from the GROBID server and "
        "overwrites the cached feature file used by the sync-check lint. The gold-standard "
        "annotation (the document's &lt;text&gt; content) is never touched. Use this after "
        "a GROBID model has been retrained or swapped.</div>"
        "<table>"
        f"<tr><th>Document</th><td>{escape_html(target.doc_id)}</td></tr>"
        f"<tr><th>Variant</th><td>{escape_html(target.variant_id)}</td></tr>"
        "</table>"
        f"{revision_html}"
        "<p>Click <strong>Execute</strong> below to proceed, or close this dialog to cancel.</p>"
    )
    return _page(body)


def render_result_html(result: ReloadResult) -> str:
    """Render the execute-result page: a summary plus a sandbox-driven toast and reload."""
    message = result.message
    body = (
        f"<div class='success'>{escape_html(message)}</div>"
        "<script>"
        f"sandbox.notify({json.dumps(message)}, 'success', 'check-circle');"
        "sandbox.reloadCurrentDocument();"
        "</script>"
    )
    return wrap_html_with_sandbox_client(_page(body))


def render_error_html(message: str) -> str:
    """Render the execute-result page shown when the reload failed."""
    return _page(f"<div class='error'>{escape_html(message)}</div>")

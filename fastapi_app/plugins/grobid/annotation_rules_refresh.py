"""
Core logic for the GROBID "Refresh Annotation Rules" reviewer action.

Regenerates a document's editorialDecl guideline references from the
current annotation_guides.py config, re-resolving permalinks to whatever
commit is current now. Separated from plugin.py (trigger endpoint) and
routes.py (preview/execute HTTP routes) so both share the same precondition
checks and business logic, mirroring reload_feature_file.py. See
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part G).
"""

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from lxml import etree

from fastapi_app.config import get_settings
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.models.models import FileMetadata, FileUpdate
from fastapi_app.lib.permissions.access_control import check_file_access
from fastapi_app.lib.plugins.plugin_tools import escape_html, wrap_html_with_sandbox_client
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef, extract_annotation_rule_refs
from fastapi_app.plugins.grobid.annotation_rules import build_editorial_decl_entries
from fastapi_app.plugins.grobid.sync import parse_encoding_labels

TEI_NS = "http://www.tei-c.org/ns/1.0"


class RefreshPreconditionError(Exception):
    """Raised when the target document cannot be resolved for a refresh."""


@dataclass
class RefreshTarget:
    """The document a rules-refresh would act on."""

    file_meta: FileMetadata
    tei_content: str
    variant_id: str


@dataclass
class RefreshResult:
    """Outcome of actually performing the refresh."""

    entry_count: int
    changed: bool

    @property
    def message(self) -> str:
        if not self.changed:
            return "Annotation rules reference is already up to date."
        plural = "y" if self.entry_count == 1 else "ies"
        return f"Annotation rules reference updated ({self.entry_count} entr{plural})."


def resolve_refresh_target(
    file_repo: FileRepository,
    file_storage: FileStorage,
    stable_id: str,
    user: dict | None,
) -> RefreshTarget:
    """
    Resolve and validate the document a rules refresh would target.

    Read-only. Raises RefreshPreconditionError with a user-facing message if
    the document cannot be resolved, including when *user* lacks edit
    access to it.
    """
    file_meta = file_repo.get_file_by_stable_id(stable_id)
    if not file_meta or file_meta.file_type != "tei":
        raise RefreshPreconditionError("No TEI document open.")

    if not check_file_access(file_meta, user, "edit"):
        raise RefreshPreconditionError("You don't have permission to edit this document.")

    content_bytes = file_storage.read_file(file_meta.id, "tei")
    if not content_bytes:
        raise RefreshPreconditionError("File content not found.")
    tei_content = content_bytes.decode("utf-8")

    labels = parse_encoding_labels(tei_content)
    variant_id = labels.get("variant-id")
    if not variant_id:
        raise RefreshPreconditionError("Document has no recognizable extractor variant.")

    return RefreshTarget(file_meta=file_meta, tei_content=tei_content, variant_id=variant_id)


def _replace_editorial_decl(tei_content: str, entries: list[AnnotationRuleRef]) -> str:
    """
    Replace (or insert) the document's editorialDecl with fresh entries.

    Inserted as the first child of encodingDesc, before appInfo/schemaRef,
    matching the order create_encoding_desc_with_extractor() uses. Returns
    the content unchanged if entries is empty and there was nothing to
    replace either. Also returns the content unchanged (defensive, expected
    unreachable in practice since every TEI document created by this app
    has an encodingDesc) if the document has no encodingDesc at all.
    """
    root = etree.fromstring(tei_content.encode("utf-8"))
    ns = {"tei": TEI_NS}

    encoding_desc = root.find(".//tei:encodingDesc", ns)
    if encoding_desc is None:
        return tei_content

    existing = encoding_desc.find("tei:editorialDecl", ns)
    if existing is not None:
        encoding_desc.remove(existing)

    if not entries:
        return etree.tostring(root, encoding="unicode")

    editorial_decl = etree.Element(f"{{{TEI_NS}}}editorialDecl")
    for entry in entries:
        interpretation = etree.SubElement(editorial_decl, f"{{{TEI_NS}}}interpretation", type=entry["category"])
        p = etree.SubElement(interpretation, f"{{{TEI_NS}}}p")
        for ref_entry in entry["refs"]:
            ref = etree.SubElement(p, f"{{{TEI_NS}}}ref", target=ref_entry["target"], subtype=ref_entry["subtype"])
            content_type = ref_entry["content_type"]
            if content_type is not None:
                ref.set("type", content_type)
    encoding_desc.insert(0, editorial_decl)

    return etree.tostring(root, encoding="unicode")


def _add_revision_change(tei_content: str, who: str | None) -> str:
    """Append a <change> entry to revisionDesc noting the rules-reference update."""
    root = etree.fromstring(tei_content.encode("utf-8"))
    ns = {"tei": TEI_NS}

    revision_desc = root.find(".//tei:revisionDesc", ns)
    if revision_desc is None:
        tei_header = root.find(".//tei:teiHeader", ns)
        if tei_header is None:
            raise RuntimeError("Document has no teiHeader; cannot record the refresh as a revision.")
        revision_desc = etree.SubElement(tei_header, f"{{{TEI_NS}}}revisionDesc")

    change = etree.SubElement(revision_desc, f"{{{TEI_NS}}}change")
    change.set("when", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    if who:
        change.set("who", f"#{who}")
    desc = etree.SubElement(change, f"{{{TEI_NS}}}desc")
    desc.text = "Updated annotation rules reference to latest guidelines"

    return etree.tostring(root, encoding="unicode")


async def perform_refresh(
    target: RefreshTarget,
    file_repo: FileRepository,
    file_storage: FileStorage,
    who: str | None,
) -> RefreshResult:
    """
    Regenerate the document's editorialDecl from the current config and save it.

    Re-resolves permalinks (a fresh commit SHA if the guideline branch has
    moved on); if the resulting entries are unchanged from what the document
    already has (nothing configured, or already current), no new version is
    written. Entries are compared semantically (parsed, not as raw XML text)
    so re-serialization whitespace never triggers a spurious save.

    Raises RuntimeError if the document's XML cannot be re-parsed for the
    rewrite (it passed the lenient parse in resolve_refresh_target() but is
    not strictly well-formed) or has no teiHeader to record the change in -
    callers (routes.py's refresh_annotation_rules_execute) catch this the
    same way reload_feature_file.py's routes catch RuntimeError from
    perform_reload().
    """
    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    entries = build_editorial_decl_entries(target.variant_id, cache)

    existing_entries = extract_annotation_rule_refs(target.tei_content)
    changed = entries != existing_entries
    if changed:
        try:
            new_content = _replace_editorial_decl(target.tei_content, entries)
            new_content = _add_revision_change(new_content, who)
        except etree.XMLSyntaxError as e:
            raise RuntimeError(f"Could not parse document XML for refresh: {e}") from e

        new_bytes = new_content.encode("utf-8")
        saved_hash, _ = file_storage.save_file(new_bytes, target.file_meta.file_type, increment_ref=False)
        if saved_hash != target.file_meta.id:
            file_repo.update_file(
                target.file_meta.id,
                FileUpdate(id=saved_hash, file_size=len(new_bytes)),
            )

    return RefreshResult(entry_count=len(entries), changed=changed)


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
        "<title>Refresh Annotation Rules</title>"
        f"<style>{_PAGE_STYLE}</style></head><body>"
        f"<h2>Refresh Annotation Rules</h2>{body}</body></html>"
    )


def render_precondition_error_html(message: str) -> str:
    """Render the preview page shown when the document cannot be resolved."""
    return _page(f"<div class='error'>{escape_html(message)}</div>")


def render_preview_html(target: RefreshTarget) -> str:
    """Render the reviewer confirmation page shown before executing a refresh."""
    body = (
        "<div class='notice'><strong>This re-derives the annotation rules reference</strong> "
        "for this document from the current configuration, re-resolving it to whatever commit "
        "is current now. Nothing else in the document is touched.</div>"
        "<table>"
        f"<tr><th>Document</th><td>{escape_html(target.file_meta.filename or target.file_meta.id)}</td></tr>"
        f"<tr><th>Variant</th><td>{escape_html(target.variant_id)}</td></tr>"
        "</table>"
        "<p>Click <strong>Execute</strong> below to proceed, or close this dialog to cancel.</p>"
    )
    return _page(body)


def render_result_html(result: RefreshResult) -> str:
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
    """Render the execute-result page shown when the refresh failed."""
    return _page(f"<div class='error'>{escape_html(message)}</div>")

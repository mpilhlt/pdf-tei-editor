"""
Core logic for the "Refresh document rules" reviewer action: regenerates a
document's interpretation-ref editorialDecl entries and its schema
processing instruction from its extractor's current DocumentRulesProvider,
re-resolving permalinks/schema URLs to what's current now. Generalizes what
was GROBID-plugin-specific annotation_rules_refresh.py (see
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
Part G) to any registered extractor, and adds schema-PI regeneration
(replacing the removed tei_wizard "Add RNG Schema Definition" enhancement).
See docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Refreshing document rules").
"""

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from lxml import etree

from fastapi_app.lib.core.schema_validator import extract_schema_locations
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document
from fastapi_app.lib.models.models import FileMetadata, FileUpdate
from fastapi_app.lib.permissions.access_control import check_file_access
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef, extract_annotation_rule_refs
from fastapi_app.lib.utils.tei_utils import create_schema_processing_instruction

TEI_NS = "http://www.tei-c.org/ns/1.0"


class RefreshPreconditionError(Exception):
    """Raised when the target document cannot be resolved for a refresh."""


@dataclass
class RefreshTarget:
    """
    The document a rules-refresh would act on.

    Resolving one only needs file/permission/content - not an existing
    editorialDecl, and not even a readable extractor variant, so a legacy
    or malformed-provenance document still resolves here (see the design
    spec's "Refreshing document rules" precondition note). Whether anything
    can actually be refreshed is determined separately, by looking up a
    DocumentRulesProvider (see _plan_refresh()).
    """

    file_meta: FileMetadata
    tei_content: str


@dataclass
class RefreshOutcome:
    """
    Shared result shape for both preview_refresh() (dry run) and
    perform_refresh() (real write).

    `available=False` means no rules-refresh provider is registered for
    this document's extractor - not an error, just nothing to refresh.
    `changed` is always False from preview_refresh() (nothing is ever
    written there); from perform_refresh() it reflects whether anything
    was actually rewritten.
    """

    available: bool
    changed: bool
    entry_count: int
    variant_id: Optional[str]
    message: str


def resolve_refresh_target(
    file_repo: FileRepository,
    file_storage: FileStorage,
    stable_id: str,
    user: Optional[dict],
) -> RefreshTarget:
    """
    Resolve and validate the document a rules refresh would target.

    Read-only. Raises RefreshPreconditionError with a user-facing message if
    the document cannot be resolved, including when *user* lacks edit access
    to it.
    """
    file_meta = file_repo.get_file_by_stable_id(stable_id)
    if not file_meta or file_meta.file_type != "tei":
        raise RefreshPreconditionError("No TEI document open.")

    if not check_file_access(file_meta, user, "edit"):
        raise RefreshPreconditionError("You don't have permission to edit this document.")

    content_bytes = file_storage.read_file(file_meta.id, "tei")
    if not content_bytes:
        raise RefreshPreconditionError("File content not found.")

    return RefreshTarget(file_meta=file_meta, tei_content=content_bytes.decode("utf-8"))


def _current_schema_location(tei_content: str) -> Optional[str]:
    """The document's current RelaxNG schema location, if any (v1 scope: RelaxNG only)."""
    for location in extract_schema_locations(tei_content):
        if location["type"] == "relaxng":
            return location["schemaLocation"]
    return None


_XML_MODEL_PI_RE = re.compile(
    r'<\?xml-model\s+[^>]*schematypens="http://relaxng\.org/ns/structure/1\.0"[^>]*\?>\n?'
)
_XML_DECL_RE = re.compile(r"^<\?xml\b[^>]*\?>\n?")


def _replace_schema_pi(tei_content: str, schema_url: str) -> str:
    """
    Replace (or insert) the document's RelaxNG <?xml-model?> schema PI.

    Text-level remove-then-insert, mirroring what the now-deleted
    tei_wizard/enhancements/add-rng-schema-definition.js did in the browser
    DOM (see the design spec's Migration section) - lxml's
    etree.fromstring()/tostring() round-trip on just the root element does
    not preserve a document-level PI that precedes the root element (see
    this plan's header note), so this operates on the raw text instead,
    consistent with how extract_schema_locations() already reads this PI.
    Inserted immediately after the XML declaration if present (documents
    this app saves never have one - see serialize_tei_with_formatted_header()
    - so in practice this always inserts at the very start of the string).

    Only removes an xml-model PI whose schematypens is RelaxNG, scoped
    identically to _current_schema_location()'s own detection (v1 scope:
    RelaxNG only) - a document that also carried some other kind of
    xml-model PI (e.g. Schematron) would otherwise have it silently deleted
    here despite this module never having detected or accounted for it.
    """
    without_existing = _XML_MODEL_PI_RE.sub("", tei_content)
    new_pi = create_schema_processing_instruction(schema_url) + "\n"
    decl_match = _XML_DECL_RE.match(without_existing)
    if decl_match:
        insert_at = decl_match.end()
        return without_existing[:insert_at] + new_pi + without_existing[insert_at:]
    return new_pi + without_existing


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


def _add_revision_change(tei_content: str, who: Optional[str]) -> str:
    """Append a <change> entry to revisionDesc noting the rules refresh."""
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
    desc.text = "Updated document rules"

    return etree.tostring(root, encoding="unicode")


@dataclass
class _RefreshPlan:
    """Internal: what a refresh would do, computed once and shared by preview_refresh() and perform_refresh()."""

    available: bool
    variant_id: Optional[str]
    new_entries: list[AnnotationRuleRef]
    editorial_decl_changed: bool
    new_schema_url: Optional[str]
    existing_schema_url: Optional[str]
    schema_changed: bool


def _plan_refresh(tei_content: str, cache: UrlCache) -> _RefreshPlan:
    lookup = get_document_rules_provider_for_document(tei_content)
    if lookup is None:
        return _RefreshPlan(
            available=False, variant_id=None, new_entries=[], editorial_decl_changed=False,
            new_schema_url=None, existing_schema_url=None, schema_changed=False,
        )
    variant_id, provider = lookup

    new_entries = provider.build_editorial_decl_entries(variant_id, cache)
    existing_entries = extract_annotation_rule_refs(tei_content)
    # NOTE: extract_annotation_rule_refs() can return entries carrying an "n"
    # key (interpretation/@n); no provider currently sets it when building
    # fresh entries. This comparison only stays symmetric because nothing
    # currently writes @n. If a future provider starts producing @n, update
    # both sides together, or every document with @n will look "changed"
    # and lose its label on refresh.
    editorial_decl_changed = new_entries != existing_entries

    new_schema_url = provider.get_schema_url(variant_id)
    existing_schema_url = _current_schema_location(tei_content)
    schema_changed = new_schema_url is not None and new_schema_url != existing_schema_url

    return _RefreshPlan(
        available=True, variant_id=variant_id, new_entries=new_entries,
        editorial_decl_changed=editorial_decl_changed,
        new_schema_url=new_schema_url, existing_schema_url=existing_schema_url,
        schema_changed=schema_changed,
    )


def _describe_plan(plan: _RefreshPlan, verb: str) -> str:
    """Build RefreshOutcome.message. verb is 'Would update' (preview) or 'Updated' (execute)."""
    if not plan.available:
        return "No rule-refresh provider for this document's extractor."
    if not plan.editorial_decl_changed and not plan.schema_changed:
        return "Document rules are already up to date."
    parts = []
    if plan.editorial_decl_changed:
        plural = "y" if len(plan.new_entries) == 1 else "ies"
        parts.append(f"the annotation rules reference ({len(plan.new_entries)} entr{plural})")
    if plan.schema_changed:
        parts.append("the schema reference")
    return f"{verb} " + " and ".join(parts) + "."


def preview_refresh(target: RefreshTarget, cache: UrlCache) -> RefreshOutcome:
    """Read-only: reports what perform_refresh() would change, without writing anything."""
    plan = _plan_refresh(target.tei_content, cache)
    return RefreshOutcome(
        available=plan.available,
        changed=plan.editorial_decl_changed or plan.schema_changed,
        entry_count=len(plan.new_entries),
        variant_id=plan.variant_id,
        message=_describe_plan(plan, "Would update"),
    )


async def perform_refresh(
    target: RefreshTarget,
    file_repo: FileRepository,
    file_storage: FileStorage,
    who: Optional[str],
    cache: UrlCache,
) -> RefreshOutcome:
    """
    Regenerate the document's editorialDecl and/or schema PI from its
    extractor's current DocumentRulesProvider and save it, if anything
    changed. Works on a legacy document with no editorialDecl or schema PI
    at all - see RefreshTarget's docstring and the design spec's
    "Refreshing document rules" precondition note.

    Raises RuntimeError if the document's XML cannot be re-parsed for the
    rewrite (its extractor provenance was readable via a lenient parse, but
    the document is not strictly well-formed) or has no teiHeader to record
    the change in - callers catch this the same way
    reload_feature_file.py's routes catch RuntimeError from
    perform_reload().
    """
    plan = _plan_refresh(target.tei_content, cache)
    if not plan.available:
        return RefreshOutcome(
            available=False, changed=False, entry_count=0, variant_id=None,
            message=_describe_plan(plan, "Updated"),
        )

    if not plan.editorial_decl_changed and not plan.schema_changed:
        return RefreshOutcome(
            available=True, changed=False, entry_count=len(plan.new_entries),
            variant_id=plan.variant_id, message=_describe_plan(plan, "Updated"),
        )

    try:
        new_content = target.tei_content
        if plan.editorial_decl_changed:
            new_content = _replace_editorial_decl(new_content, plan.new_entries)
        new_content = _add_revision_change(new_content, who)

        # Both round-trips above silently drop any PI preceding the root
        # element (confirmed empirically - see this plan's header note), so
        # restoring the schema PI must happen last, unconditionally whenever
        # anything was rewritten, using whichever URL should currently be in
        # effect - not only when schema_changed - or an editorialDecl-only
        # refresh would silently delete an untouched schema PI.
        final_schema_url = plan.new_schema_url if plan.new_schema_url is not None else plan.existing_schema_url
        if final_schema_url is not None:
            new_content = _replace_schema_pi(new_content, final_schema_url)
    except etree.XMLSyntaxError as e:
        raise RuntimeError(f"Could not parse document XML for refresh: {e}") from e

    new_bytes = new_content.encode("utf-8")
    saved_hash, _ = file_storage.save_file(new_bytes, target.file_meta.file_type, increment_ref=False)
    if saved_hash != target.file_meta.id:
        file_repo.update_file(target.file_meta.id, FileUpdate(id=saved_hash, file_size=len(new_bytes)))

    return RefreshOutcome(
        available=True, changed=True, entry_count=len(plan.new_entries),
        variant_id=plan.variant_id, message=_describe_plan(plan, "Updated"),
    )

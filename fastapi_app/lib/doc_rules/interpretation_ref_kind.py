"""
The "interpretation-ref" resource kind: prompt/rule fragments referenced
by editorialDecl/interpretation. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md.

Each rule category exposes up to two layers (#666): the human-readable
guide and the machine rules the LLM annotation reviewer consumes, each with
its own overrides, keyed by file + heading anchor (see resource_key()).
"""

import logging
from typing import Optional

from fastapi_app.config import get_settings
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.kinds import ResourceDescriptor, ResourceKind, ResourceLayer
from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRef,
    AnnotationRuleRefTarget,
    extract_annotation_rule_refs,
    fetch_rule_excerpt,
    fetch_rule_section,
    heading_anchor_at_line,
    line_range_start,
)

logger = logging.getLogger(__name__)


def representative_ref(refs: list[AnnotationRuleRefTarget]) -> Optional[AnnotationRuleRefTarget]:
    """
    The one ref of an interpretation entry that represents it as a single
    resource: its "machine" ref (the text the LLM annotation reviewer
    consumes - a line-range excerpt of the human section or of a separate
    condensed, LLM-only document) if present, else its sole "human" ref (a
    whole document or an HTML section, for which no machine excerpt could
    be derived - see grobid/annotation_rules.py's _build_refs_for_guide).
    discover() no longer uses it - it emits one descriptor per layer (see
    layer_refs()) - but rules_refresh.py and the annotation reviewer's
    fallback still need the single ref the reviewer reads. Exported (not
    module-private) for those consumers, including pte-plugins.
    """
    for ref in refs:
        if ref["subtype"] == "machine":
            return ref
    return refs[0] if refs else None


def legacy_resource_key(url: str) -> str:
    """The pre-#666 resource key of `url` (line-range fragment kept verbatim), under which older overrides were stored."""
    return normalize_resource_key(url)


def _ref_base(url: str) -> str:
    """`url` with its fragment dropped and its forge ref stripped, for comparing which file two refs point to."""
    return normalize_resource_key(url.partition("#")[0])


def layer_refs(entry: AnnotationRuleRef) -> dict[ResourceLayer, AnnotationRuleRefTarget]:
    """
    The layers an interpretation entry exposes, in order human, machine:
    "human" is its human ref, if any; "machine" is its machine ref, unless
    that ref points into the same file as the human ref - then it is an
    excerpt of the human guide and is folded into the human layer.
    """
    human = next((r for r in entry["refs"] if r["subtype"] == "human"), None)
    machine = next((r for r in entry["refs"] if r["subtype"] == "machine"), None)
    layers: dict[ResourceLayer, AnnotationRuleRefTarget] = {}
    if human is not None:
        layers["human"] = human
    if machine is not None and (human is None or _ref_base(machine["target"]) != _ref_base(human["target"])):
        layers["machine"] = machine
    return layers


class InterpretationRefKind(ResourceKind):
    name = "interpretation-ref"

    def discover(self, xml_string: str) -> list[ResourceDescriptor]:
        descriptors: list[ResourceDescriptor] = []
        for entry in extract_annotation_rule_refs(xml_string):
            layers = layer_refs(entry)
            label = entry.get("n") or entry["category"]
            group = f"{self.name}:{entry['category']}"
            for layer, ref in layers.items():
                related_urls = [ref["target"]]
                if layer == "human" and "machine" not in layers:
                    # A same-file machine ref folded into the human layer
                    related_urls += [r["target"] for r in entry["refs"] if r["subtype"] == "machine"]
                descriptors.append(ResourceDescriptor(
                    kind=self.name,
                    url=ref["target"],
                    key=self.resource_key(ref["target"]),
                    label=label,
                    format=infer_format(ref["target"]),
                    related_urls=related_urls,
                    layer=layer,
                    group=group,
                ))
        return descriptors

    def resource_key(self, url: str) -> str:
        """
        Key overrides by file + heading anchor, so a machine ref's line range
        shifting as the file is edited upstream doesn't orphan them: a
        line-range fragment whose start line is a Markdown heading maps to
        that heading's anchor. Falls back to legacy_resource_key() if the
        start line isn't a heading or the file can't be fetched.
        """
        base, _, fragment = url.partition("#")
        start = line_range_start(fragment) if fragment else None
        if start is None:  # no fragment, or a heading anchor already
            return normalize_resource_key(url)
        cache = UrlCache(get_settings().annotation_rules_cache_dir)
        try:
            full_text = fetch_rule_excerpt(base, cache)
        except Exception as e:
            logger.warning(f"Could not fetch {base} to derive a heading-anchor resource key, using the line-range key: {e}")
            return legacy_resource_key(url)
        anchor = heading_anchor_at_line(full_text, start)
        if anchor is None:
            return legacy_resource_key(url)
        return normalize_resource_key(f"{base}#{anchor}")

    def resolve_original(self, url: str) -> str:
        cache = UrlCache(get_settings().annotation_rules_cache_dir)
        return fetch_rule_section(url, cache)


def selected_rule_override_text(store: DocumentRulesStore, entry: AnnotationRuleRef, owner: str) -> Optional[str]:
    """
    The text of `owner`'s selected override for the layer the annotation
    reviewer reads from `entry`: "machine" if the entry has a separate machine
    layer, else "human" (a same-file machine excerpt is folded into it).
    Lazily migrates that layer's pre-#666 line-range key first. None if the
    entry has no layer or the owner uses the original.
    """
    layers = layer_refs(entry)
    ref = layers.get("machine") or layers.get("human")
    if ref is None:
        return None
    kind = InterpretationRefKind()
    key = kind.resource_key(ref["target"])
    store.migrate_resource_key(kind.name, legacy_resource_key(ref["target"]), key)
    return store.get_selected_override_text(kind.name, key, owner)

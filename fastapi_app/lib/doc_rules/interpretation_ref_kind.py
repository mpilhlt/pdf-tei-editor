"""
The "interpretation-ref" resource kind: prompt/rule fragments referenced
by editorialDecl/interpretation. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md.
"""

from typing import Optional

from fastapi_app.config import get_settings
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.kinds import ResourceDescriptor, ResourceKind
from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRefTarget,
    extract_annotation_rule_refs,
    fetch_rule_excerpt,
)


def representative_ref(refs: list[AnnotationRuleRefTarget]) -> Optional[AnnotationRuleRefTarget]:
    """
    The one ref of an interpretation entry that represents it as a single
    editable resource: its "machine" ref (the text the LLM annotation
    reviewer consumes - a line-range excerpt of the human section or of a
    separate condensed, LLM-only document) if present, else its sole
    "human" ref (a whole document or an HTML section, for which no machine
    excerpt could be derived - see grobid/annotation_rules.py's
    _build_refs_for_guide). Document rules overrides are layered on the
    machine rules, not the human-readable guide (issue #645): the
    resource's original text, its override key and the reviewer's override
    lookup all derive from this ref. Exported (not module-private) so other
    consumers of editorialDecl (e.g. annotation_review/review_logic.py's
    gather_rule_excerpts()) compute the same resource key this kind's
    discover() reports.
    """
    for ref in refs:
        if ref["subtype"] == "machine":
            return ref
    return refs[0] if refs else None


class InterpretationRefKind(ResourceKind):
    name = "interpretation-ref"

    def discover(self, xml_string: str) -> list[ResourceDescriptor]:
        descriptors: list[ResourceDescriptor] = []
        for entry in extract_annotation_rule_refs(xml_string):
            ref = representative_ref(entry["refs"])
            if ref is None:
                continue
            label = entry.get("n") or entry["category"]
            descriptors.append(ResourceDescriptor(
                kind=self.name,
                url=ref["target"],
                key=normalize_resource_key(ref["target"]),
                label=label,
                format=infer_format(ref["target"]),
                related_urls=[r["target"] for r in entry["refs"]],
            ))
        return descriptors

    def resolve_original(self, url: str) -> str:
        cache = UrlCache(get_settings().annotation_rules_cache_dir)
        return fetch_rule_excerpt(url, cache)

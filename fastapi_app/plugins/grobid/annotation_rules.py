"""
Resolves this plugin's annotation-guide config into editorialDecl-ready
entries, shared by extraction-time generation (extractor.py) and the
"Refresh Annotation Rules" reviewer action (annotation_rules_refresh.py) so
both regenerate editorialDecl the same way. See
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Parts B and G) and
docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md
(the variant_ids/"primary" schema and dual human/machine refs).
"""

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRef,
    AnnotationRuleRefTarget,
    is_line_range_fragment,
    resolve_forge_permalink,
    translate_anchor_to_line_range,
)
from fastapi_app.plugins.grobid.config import AnnotationGuide, get_annotation_guides


def build_editorial_decl_entries(variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
    """
    Resolve this variant's configured annotation guides into editorialDecl entries.

    A guide matches `variant_id` if its `variant_ids` list contains that id
    or the wildcard "*" (applies to every variant). Each matching guide
    produces one or two refs depending on its configured url/type - see
    _build_refs_for_guide(). "primary" is the category sentinel the
    frontend drawer looks up by default. Returns [] if no guides are
    configured for this variant.
    """
    entries: list[AnnotationRuleRef] = []
    for guide in get_annotation_guides():
        if variant_id not in guide["variant_ids"] and "*" not in guide["variant_ids"]:
            continue
        refs = _build_refs_for_guide(guide, cache)
        entries.append({"category": guide["category"], "refs": refs})
    return entries


def _build_refs_for_guide(guide: AnnotationGuide, cache: UrlCache) -> list[AnnotationRuleRefTarget]:
    """
    Build the one or two refs a single configured guide produces, permalink-
    pinning every target. Which refs are generated depends on the
    configured url's fragment shape and content type:

    - No fragment (whole document): a single "human" ref, unchanged.
    - An already-machine-style line-range fragment (#L10-L50): a single
      "machine" ref, unchanged - this is how a purely machine-oriented
      topic (e.g. "footnote-annotation") stays configurable without ever
      needing a human-facing anchor.
    - A heading-anchor fragment with type "html": a single "human" ref -
      there's no heading/line-range concept for HTML.
    - A heading-anchor fragment with type "markdown": both a "human" ref
      (as configured) and an auto-derived "machine" ref (a line range
      covering that heading's section, computed by
      annotation_rules_utils.translate_anchor_to_line_range). If the anchor
      can't be found in the fetched document, only the "human" ref is
      returned - this never fails extraction/refresh, matching this
      feature's established error-handling philosophy.
    """
    _, _, fragment = guide["url"].partition("#")
    content_type = guide["type"]

    if not fragment:
        human_target = resolve_forge_permalink(guide["url"], cache)
        return [{"target": human_target, "content_type": content_type, "subtype": "human"}]

    if is_line_range_fragment(fragment):
        machine_target = resolve_forge_permalink(guide["url"], cache)
        return [{"target": machine_target, "content_type": content_type, "subtype": "machine"}]

    human_target = resolve_forge_permalink(guide["url"], cache)
    refs: list[AnnotationRuleRefTarget] = [
        {"target": human_target, "content_type": content_type, "subtype": "human"},
    ]
    if content_type == "markdown":
        pinned_base = human_target.partition("#")[0]
        line_range = translate_anchor_to_line_range(pinned_base, fragment, cache)
        if line_range is not None:
            start, end = line_range
            refs.append({
                "target": f"{pinned_base}#L{start}-L{end}",
                "content_type": content_type,
                "subtype": "machine",
            })
    return refs

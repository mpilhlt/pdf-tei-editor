"""
Fetches and slices annotation-rules text referenced from a TEI document's
editorialDecl, and resolves such references to forge permalinks.

See docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part E) for the rationale.
"""

import logging
import re
from typing import Literal, Optional, TypedDict

import requests
from lxml import etree

from fastapi_app.lib.core.git_forge_adapters import GitForgeAdapterRegistry
from fastapi_app.lib.core.url_cache import UrlCache

logger = logging.getLogger(__name__)

# Matches GitHub's #L10-L50 and GitLab's #L10-50 (no second "L")
_LINE_RANGE_RE = re.compile(r'^L(\d+)(?:-L?(\d+))?$')


class RuleFetchError(Exception):
    """Raised when fetched content is not usable as raw rule text (e.g. an HTML blob page)."""


def resolve_forge_permalink(url: str, cache: UrlCache) -> str:
    """
    Resolve a branch-relative git-forge URL to a commit-SHA-pinned permalink.

    Returns `url` unchanged if no registered adapter recognizes it (e.g. a
    HedgeDoc pad URL) - such URLs are assumed already stable - or if
    resolution fails for any reason (forge API unreachable, rate limited,
    unexpected response shape, etc.). A failure is logged but never raised,
    so callers (extraction, the "Refresh Annotation Rules" action) are never
    blocked by it - see the Error Handling section of
    docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md.
    """
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(url)
    if adapter is None:
        return url
    try:
        return adapter.resolve_ref_to_sha(url, cache)
    except Exception as e:
        logger.warning(f"Could not resolve permalink for {url}, using it as given: {e}", exc_info=True)
        return url


def fetch_rule_excerpt(url: str, cache: UrlCache, allow_redirects: bool = True) -> str:
    """
    Fetch the raw text a rules-document URL points to, sliced to its
    line-range fragment if one is present (e.g. "#L10-L40" or GitLab's
    "#L10-40").

    Returns the whole fetched text if there is no fragment, or if the
    fragment doesn't parse as a recognized line-range. Line numbers are
    1-based and inclusive; out-of-range values are clamped to the available
    lines.

    `allow_redirects` defaults to True (preserving prior behavior for
    existing callers); pass False when the caller has validated `url`
    itself and needs the fetch to hit that exact host, not wherever it
    redirects to (see the annotation-review plugin's SSRF mitigation).

    Raises:
        RuleFetchError: if the fetched content's Content-Type is text/html,
            which indicates a rendered page was fetched instead of raw text
            (e.g. an unrecognized forge's blob view).
    """
    base_url, _, fragment = url.partition("#")
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(base_url)
    fetch_url = adapter.to_raw_url(base_url) if adapter else base_url

    text = cache.get_text(fetch_url)
    if text is None:
        response = requests.get(fetch_url, timeout=30, allow_redirects=allow_redirects)
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "")
        if "text/html" in content_type:
            raise RuleFetchError(
                f"Expected raw text but got '{content_type}' from {fetch_url}"
            )
        text = response.text
        cache.set_text(fetch_url, text)

    match = _LINE_RANGE_RE.match(fragment) if fragment else None
    if not match:
        return text

    lines = text.splitlines()
    start = max(1, int(match.group(1)))
    end = int(match.group(2)) if match.group(2) else start
    end = max(start, end)
    start_idx = min(start - 1, len(lines))
    end_idx = min(end, len(lines))
    return "\n".join(lines[start_idx:end_idx])


def is_line_range_fragment(fragment: str) -> bool:
    """True if `fragment` matches a line-range anchor (GitHub's #L10-L50 or GitLab's #L10-50)."""
    return bool(_LINE_RANGE_RE.match(fragment))


_ATX_HEADING_RE = re.compile(r'^(#{1,6})\s+(.+?)(?:\s+#+)?$')
_SLUG_STRIP_RE = re.compile(r'[^\w\s-]')
_SLUG_WHITESPACE_RE = re.compile(r'\s')
_FENCE_RE = re.compile(r'^(`{3,}|~{3,})')


class _Heading(TypedDict):
    """One scanned Markdown heading: its line, nesting level, and computed anchor slug."""

    line: int
    level: int
    slug: str


def _slugify_heading(title: str) -> str:
    """
    Compute a GitHub-style heading anchor slug: lowercase, strip characters
    that aren't word characters/spaces/hyphens, then replace each
    whitespace character with a hyphen.
    """
    slug = title.strip().lower()
    slug = _SLUG_STRIP_RE.sub("", slug)
    slug = _SLUG_WHITESPACE_RE.sub("-", slug)
    return slug


def _scan_markdown_headings(text: str) -> list[_Heading]:
    """
    Scan ATX-style Markdown headings ("# Title", "## Title", ...), returning
    each with its 1-based line number, level, and GitHub-style anchor slug.
    Lines inside fenced code blocks (```` ``` ```` or `~~~`) are skipped, so
    a "#"-prefixed comment inside an embedded code example is never
    misdetected as a heading. Repeated slugs are de-duplicated with a "-1",
    "-2", ... suffix, matching GitHub's own anchor-generation behavior.
    """
    seen: dict[str, int] = {}
    headings: list[_Heading] = []
    in_fence = False
    for line_no, line in enumerate(text.splitlines(), start=1):
        if _FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = _ATX_HEADING_RE.match(line)
        if not match:
            continue
        level = len(match.group(1))
        slug = _slugify_heading(match.group(2))
        if slug in seen:
            seen[slug] += 1
            slug = f"{slug}-{seen[slug]}"
        else:
            seen[slug] = 0
        headings.append({"line": line_no, "level": level, "slug": slug})
    return headings


def translate_anchor_to_line_range(url: str, anchor: str, cache: UrlCache) -> Optional[tuple[int, int]]:
    """
    Find the 1-based, inclusive line range a Markdown heading anchor covers.

    `url` must have no fragment (the whole document is fetched). The range
    spans from the matched heading's own line to the line before the next
    heading at the same or shallower level (or end of file if there is
    none), so a subsection's own sub-headings never bound its parent's
    range. See
    docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md
    for the rationale.

    Returns None (never raises) if the anchor isn't found among the
    document's headings, or if fetching/parsing the document fails for any
    reason - callers should skip generating a machine-targeted ref in that
    case rather than fail extraction/refresh.
    """
    try:
        text = fetch_rule_excerpt(url, cache)
    except Exception as e:
        logger.warning(f"Could not fetch {url} to translate anchor '{anchor}': {e}", exc_info=True)
        return None

    headings = _scan_markdown_headings(text)
    matched_index = next((i for i, h in enumerate(headings) if h["slug"] == anchor), None)
    if matched_index is None:
        logger.warning(f"Heading anchor '{anchor}' not found in {url}; no machine-targeted ref generated")
        return None

    matched = headings[matched_index]
    end_line = len(text.splitlines())
    for later in headings[matched_index + 1:]:
        if later["level"] <= matched["level"]:
            end_line = later["line"] - 1
            break

    return (matched["line"], end_line)


TEI_NS = "http://www.tei-c.org/ns/1.0"


class AnnotationRuleRefTarget(TypedDict):
    """
    One <ref> within an editorialDecl/interpretation.

    "target" is the ref's permalink-pinned URL; "content_type" is its own
    @type ("markdown"/"html", or None if absent); "subtype" distinguishes a
    "human" ref (a heading-anchor URL for the drawer) from an auto-derived
    "machine" ref (a line-range URL for token-bounded fetching) - see
    docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md.
    """

    target: str
    content_type: Optional[str]
    subtype: Literal["human", "machine"]


class AnnotationRuleRef(TypedDict):
    """
    One editorialDecl/interpretation entry: a rule category and its one or two refs.

    "category" is interpretation/@type (e.g. "primary", "footnote-annotation").
    """

    category: str
    refs: list[AnnotationRuleRefTarget]


def extract_annotation_rule_refs(xml_string: str) -> list[AnnotationRuleRef]:
    """
    Parse a TEI document's editorialDecl/interpretation entries.

    An interpretation missing @type is skipped, as is any <ref> within
    it missing @target or whose @subtype isn't "human" or "machine" - such
    a document is malformed with respect to this app's own conventions, but
    extraction/validation elsewhere already guards against producing such
    documents, so this is treated as "nothing usable here" rather than
    raised. An interpretation whose @type is present but which ends up with
    no usable refs is also skipped entirely (not returned with an empty
    refs list). Returns an empty list if the document has no editorialDecl
    or is not well-formed XML.
    """
    try:
        root = etree.fromstring(xml_string.encode("utf-8"))
    except etree.XMLSyntaxError:
        return []

    ns = {"tei": TEI_NS}
    results: list[AnnotationRuleRef] = []
    for interpretation in root.findall(".//tei:editorialDecl/tei:interpretation", ns):
        category = interpretation.get("type")
        if category is None:
            continue

        refs: list[AnnotationRuleRefTarget] = []
        for ref in interpretation.findall(".//tei:ref", ns):
            target = ref.get("target")
            subtype_raw = ref.get("subtype")
            if target is None:
                continue
            if subtype_raw == "human":
                subtype: Literal["human", "machine"] = "human"
            elif subtype_raw == "machine":
                subtype = "machine"
            else:
                continue
            refs.append({
                "target": target,
                "content_type": ref.get("type"),
                "subtype": subtype,
            })

        if not refs:
            continue
        results.append({"category": category, "refs": refs})
    return results

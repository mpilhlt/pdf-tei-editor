"""
Fetches and slices annotation-rules text referenced from a TEI document's
editorialDecl, and resolves such references to forge permalinks.

See docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part E) for the rationale.
"""

import logging
import posixpath
import re
from typing import Literal, NotRequired, Optional, TypedDict
from urllib.parse import urljoin

import requests
from lxml import etree

from fastapi_app.lib.core.git_forge_adapters import GitForgeAdapterRegistry
from fastapi_app.lib.core.url_cache import UrlCache

logger = logging.getLogger(__name__)

# Matches GitHub's #L10-L50 and GitLab's #L10-50 (no second "L")
_LINE_RANGE_RE = re.compile(r'^L(\d+)(?:-L?(\d+))?$')

# Matches an inline markdown link/image target: `[...](url)` or `![...](url)`,
# optionally followed by a "title" in quotes. Reference-style links/images
# (`![alt][ref]`) are not matched - rare enough in the annotation-rules
# guides this targets that supporting them isn't worth the complexity.
_MD_INLINE_LINK_RE = re.compile(r'(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))')

_ABSOLUTE_URL_RE = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.\-]*://')


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


def _rewrite_relative_markdown_urls(text: str, base_dir_url: str) -> str:
    """
    Rewrite a markdown document's inline link/image targets that are
    relative (e.g. "img/foo.png") to absolute URLs resolved against
    `base_dir_url`, so images and links keep working when the document is
    rendered outside its original repository - e.g. this app's document-
    rules resource editor preview, which would otherwise resolve them
    against its own origin instead of the source repo.
    """
    def replace(match: "re.Match[str]") -> str:
        prefix, target, suffix = match.group(1), match.group(2), match.group(3)
        if target.startswith("#") or target.startswith("data:") or target.startswith("mailto:"):
            return match.group(0)
        if target.startswith("//") or _ABSOLUTE_URL_RE.match(target):
            return match.group(0)
        return f"{prefix}{urljoin(base_dir_url, target)}{suffix}"

    return _MD_INLINE_LINK_RE.sub(replace, text)


def _repo_path_via_any_adapter(url: str) -> "tuple[str, str] | None":
    """First (repo_id, path) any registered adapter's parse_repo_path() recognizes `url` as, or None."""
    for adapter in GitForgeAdapterRegistry.get_instance().all_adapters():
        repo_path = adapter.parse_repo_path(url)
        if repo_path is not None:
            return repo_path
    return None


def derelativize_markdown_urls(text: str, base_url: str) -> str:
    """
    Inverse of `_rewrite_relative_markdown_urls()`: rewrite `text`'s inline
    link/image targets that are absolute URLs into the *same repository* as
    `base_url` (regardless of which ref either one is pinned to) back into
    paths relative to `base_url`'s directory. A resource's `original_text`
    has already had its relative links rewritten to this app's own
    internally-resolved absolute form (possibly SHA-pinned to whatever
    commit it was last fetched at) so previews render correctly outside the
    source repo - but that resolved form must not leak into a real upstream
    file when the user proposes the override's text as the file's new
    content, or a same-repo relative link like "../other.md" would end up
    permanently hardcoded to `https://raw.githubusercontent.com/.../{sha}/other.md`
    in the actual repository.

    Absolute URLs into a *different* repo (or a non-git-forge URL) are left
    untouched - only same-repo links round-trip through this rewrite.
    Only applies to markdown resources (by `base_url`'s file extension, via
    `infer_format()`); returns `text` unchanged for any other format.
    """
    # Deferred import: see fetch_rule_excerpt()'s identical comment on why
    # this can't be a module-level import.
    from fastapi_app.lib.doc_rules.resource_key import infer_format
    if infer_format(base_url) != "markdown":
        return text

    base_repo_path = _repo_path_via_any_adapter(base_url)
    if base_repo_path is None:
        return text
    base_repo, base_path = base_repo_path
    base_dir = base_path.rsplit("/", 1)[0] if "/" in base_path else ""

    def replace(match: "re.Match[str]") -> str:
        prefix, target, suffix = match.group(1), match.group(2), match.group(3)
        if not _ABSOLUTE_URL_RE.match(target):
            return match.group(0)
        target_repo_path = _repo_path_via_any_adapter(target)
        if target_repo_path is None or target_repo_path[0] != base_repo:
            return match.group(0)
        relative = posixpath.relpath(target_repo_path[1], base_dir) if base_dir else target_repo_path[1]
        return f"{prefix}{relative}{suffix}"

    return _MD_INLINE_LINK_RE.sub(replace, text)


def fetch_rule_excerpt(url: str, cache: UrlCache, allow_redirects: bool = True) -> str:
    """
    Fetch the raw text a rules-document URL points to, sliced to its
    line-range fragment if one is present (e.g. "#L10-L40" or GitLab's
    "#L10-40").

    Returns the whole fetched text if there is no fragment, or if the
    fragment doesn't parse as a recognized line-range. Line numbers are
    1-based and inclusive; out-of-range values are clamped to the available
    lines.

    For a markdown resource (by file extension), relative link/image
    targets are rewritten to absolute URLs before slicing/caching - see
    `_rewrite_relative_markdown_urls()` - so the excerpt renders correctly
    outside its source repository.

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
    pinned = adapter.is_sha_pinned(base_url) if adapter else False

    text = cache.get_text(fetch_url, ignore_ttl=pinned)
    if text is None:
        response = requests.get(fetch_url, timeout=30, allow_redirects=allow_redirects)
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "")
        if "text/html" in content_type:
            raise RuleFetchError(
                f"Expected raw text but got '{content_type}' from {fetch_url}"
            )
        text = response.text
        # Deferred import: doc_rules/__init__.py imports extraction_contribution.py,
        # which imports this module - a module-level import here would be circular.
        from fastapi_app.lib.doc_rules.resource_key import infer_format
        if infer_format(base_url) == "markdown":
            base_dir_url = fetch_url.rsplit("/", 1)[0] + "/"
            text = _rewrite_relative_markdown_urls(text, base_dir_url)
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
    "n" is interpretation/@n, a short display label (TEI's att.global.attribute.n);
    absent (not merely None) when the document has no @n, so equality checks
    against entries built before this attribute existed are unaffected.
    """

    category: str
    n: NotRequired[Optional[str]]
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

        entry: AnnotationRuleRef = {"category": category, "refs": refs}
        n = interpretation.get("n")
        if n is not None:
            entry["n"] = n
        results.append(entry)
    return results

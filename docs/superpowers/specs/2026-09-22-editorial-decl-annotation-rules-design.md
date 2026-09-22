# Design: document-embedded `editorialDecl` with machine-readable annotation rules

Date: 2026-09-22
Status: approved (pending spec review)

## Problem

TEI documents produced by this app carry no machine-readable pointer to the
annotation rules that governed their extraction/correction. Two related gaps
follow from this:

- A future LLM-based annotation validator would have no way to discover which
  rules apply to a given document, or to fetch just the relevant slice of a
  (potentially long) rules document instead of the whole thing, which would
  waste context tokens on irrelevant material.
- Schema validation (`fastapi_app/lib/core/schema_validator.py`) only
  recognizes the `<?xml-model?>` processing instruction as a schema-location
  source, not the standard TEI `schemaRef` element.

Separately, the existing human-facing "Annotation Guide" drawer
(`app/src/plugins/annotation-guide.js`) sources its guide URL from a
server-side, per-`variant_id` config (`ANNOTATION_GUIDES` in
`fastapi_app/plugins/grobid/config/annotation_guides.py`) at *runtime*,
rather than from the document itself — so it always shows the *current*
guide, never the version that was actually in effect when a given document
was extracted or corrected. The guidelines source is also moving, from a
HedgeDoc pad (`pad.gwdg.de`) to a GitHub-hosted file
(`https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md`), which
raises the same question in a sharper form: extraction happens at one point
in time, the guidelines document keeps evolving, and the two need to be
distinguishable and reconcilable without hand-editing XML.

## Scope

Modular, independently implementable/deferrable parts:

| Part | What |
| --- | --- |
| A | `editorialDecl` TEI shape |
| B | Extraction-time generation of `editorialDecl` |
| C | `schemaRef` as a fallback schema-location source |
| D | Pluggable git-forge adapter registry (GitHub, GitLab, ...) |
| E | Rules-excerpt fetch/slice utility + shared URL cache |
| F | Frontend unification (`annotation-guide.js` reads the document) |
| G | "Refresh Annotation Rules" endpoint + `reload_feature_file` rename |

Out of scope, documented but not built in this round:

- An in-editor UI for viewing/editing `editorialDecl` content.
- A backfill migration script for already-extracted documents — Part F's
  runtime fallback covers them instead.
- The actual LLM-based annotation validator that would consume the rule
  excerpts — this spec ends at the plumbing that such a validator would call.
- `classDecl`/`taxonomy` for documenting the custom `@type` vocabulary used
  by the legal-citation annotation tags (a natural sibling `encodingDesc`
  addition, noted under "Other integration ideas" below).

## Part A — `editorialDecl` shape

```xml
<encodingDesc>
  <editorialDecl>
    <interpretation type="general">
      <p><ref target="https://github.com/mpilhlt/fossil/blob/a1b2c3d.../docs/guidelines.md#segmentation" type="markdown">Annotation Guidelines — Segmentation</ref></p>
    </interpretation>
    <interpretation type="footnote-annotation">
      <p><ref target="https://github.com/mpilhlt/fossil/blob/a1b2c3d.../docs/guidelines.md#L120-L180" type="markdown">Footnote annotation rules</ref></p>
    </interpretation>
  </editorialDecl>
  <schemaRef target="https://…/schema.rng" type="RELAXNG"/>
  <appInfo>…</appInfo>
</encodingDesc>
```

- Element order within `encodingDesc`: `editorialDecl`, then `schemaRef`,
  then `appInfo` — matches the TEI content-model convention and the existing
  `appInfo`-last pattern already present in generated documents.
- `editorialDecl` contains one or more `<interpretation type="...">` elements
  (TEI's generic, open-ended element for interpretive/annotation-practice
  notes; free-text `@type`, no fixed vocabulary needed), each wrapping a
  `<p><ref target="..." type="...">...</ref></p>`.
- **Two independent `@type` axes, deliberately kept on different elements**
  (this codebase already reuses `@type` for different local meanings across
  sibling elements in the same header, e.g. `<application type="editor">` vs
  `<label type="revision">` vs `<label type="flavor">`, so this isn't a new
  inconsistency):
  - `interpretation/@type` is the **rule category** (`general`,
    `footnote-annotation`, …) — see below.
  - `ref/@type` is the **content type** of the linked resource
    (`"markdown"` or `"html"`), carried through unchanged from today's
    `AnnotationGuide.type` config field (Part B). It tells the frontend
    (Part F) whether the link is fetchable-and-renderable (and, for a
    line-ranged category entry, sliceable — Part E) or an external-only
    page, exactly as `annotation-guide.js` already distinguishes
    `markdownGuide` from `htmlGuide` today. A category with both a
    fetchable and an external-only view would need two `<ref>`s inside its
    `<interpretation>` (uncommon; today's config has no such case).
  - **`variant_id` is not represented in `editorialDecl` at all**, and
    doesn't need to be: the matching against a document's variant happens
    once, at *generation* time (Part B), by looking up config entries for
    that specific variant and embedding only those. Nothing in Part F reads
    or re-derives `variant_id` from an already-embedded `editorialDecl` —
    it's implicitly scoped by construction.
- **`@type="general"` is *not* "the whole document"** — that reading was
  ambiguous and is corrected here. It is the primary, per-variant section a
  human annotator should read for the document they have open — i.e.
  exactly what today's single `AnnotationGuide` config entry per
  `variant_id` already points to: a **heading-anchor fragment** into a
  (possibly shared) guidelines document, e.g. `#segmentation`,
  `#reference-segmenter` — the same anchors already used by
  `annotation-guide.js` today. `annotation-guide.js` fetches, renders, and
  scrolls to it exactly as it does today (Part F); nothing about that
  behavior changes. It may carry no fragment at all (renders from the top)
  if a variant has no dedicated subsection yet, or may point to an entirely
  separate, variant-specific document rather than a shared one — both are
  valid, the fragment is just whatever heading anchor (or absence of one)
  is appropriate for that source document's structure.
  There is deliberately no separate "whole-guide/overview" category in this
  round — if a source ever wants one, it's just another free-text category
  name (e.g. `overview`) pointing at the document root; nothing in the
  design prevents adding it later without code changes.
- Category-specific entries (`footnote-annotation`, `reference-annotation`,
  …) are additive and optional: present only once someone curates a specific
  **line range** for that category in config (Part B). Category names are
  free text, chosen to match future validator needs (e.g. mirroring
  `fastapi_app/plugins/tei_annotator/annotators/{footnote,reference}.py`).
  Unlike `general`, these entries are **machine-only**: fetched and sliced
  by Part E for LLM prompt context, never opened or rendered by the human
  drawer. That split is deliberate, not a limitation to fix later — a raw
  source-text line range has no reliable, generic mapping onto a scroll
  position in *rendered* HTML (headings do, via `id` attributes; arbitrary
  line numbers don't, without a source-map/`data-line` mechanism this app
  doesn't have), whereas a heading anchor (used by `general`) already works
  natively via the browser's own `#anchor` scrolling. So: heading anchors
  for what a human reads, line ranges for what an LLM prompt slices —
  different addressing schemes for different consumers, on different
  categories, not two competing formats for the same one.
- Every `<ref target>` is a single canonical URL — a git-forge **blob**
  permalink where the source is a supported forge (commit-SHA-pinned, not
  branch-relative, so it accurately reflects the guidelines version at
  extraction/correction time; see Part B/D), or the source's own stable URL
  otherwise (e.g. a HedgeDoc pad's `/download` URL, unchanged from today).
  One URL suffices for both machine consumption (raw-text fetch, derived via
  Part D's adapter) and human consumption (open-in-browser, which for GitHub
  and GitLab blob URLs also natively highlights a referenced line range).
- Line-range fragment convention (category entries only, never `general`):
  `#L<start>-L<end>` or `#L<n>` for a single line. The parser (Part E) also
  accepts GitLab's native `#L<start>-<end>` (no second `L`), so a URL
  copied directly from either host's address bar works without
  hand-editing. This convention never appears on a `general` entry, so
  there's no ambiguity between a line-range fragment and a heading-slug
  fragment in practice.

## Part B — extraction-time generation

- `fastapi_app/plugins/grobid/config/annotation_guides.py` is migrated from
  its current `pad.gwdg.de` entries to the fossil repository. The
  `AnnotationGuide` TypedDict gains a `category` field (e.g. `"general"`,
  `"footnote-annotation"`); existing `variant_id`/`type`/`url` fields are
  unchanged. Non-fossil entries (e.g. the `readthedocs.io` `type: "html"`
  entry for `grobid.training.references`) are untouched and keep working
  through Part F's runtime fallback, unaffected by this migration.
- Config URLs are stored **branch-relative** — the human-maintained source
  of truth — with a fragment appropriate to the entry's category:
  `.../blob/main/docs/guidelines.md#segmentation` for a `general` entry
  (heading anchor, matching today's config exactly), or
  `.../blob/main/docs/guidelines.md#L120-L180` for a category entry (line
  range). Whoever edits `guidelines.md` and updates either just looks at
  `main`; no manual SHA bookkeeping.
- `create_encoding_desc_with_extractor()` (shared by the grobid, llamore,
  and test_plugin extractors — `fastapi_app/lib/utils/tei_utils.py`) gains an
  `editorialDecl` output, built by resolving each configured `(variant_id,
  category)` entry to a permalink via Part D/E's `resolve_forge_permalink()`
  and embedding the result as described in Part A. The config entry's
  `type` field (`"markdown"`/`"html"`) is copied verbatim onto the
  generated `<ref>`'s `@type` — permalink resolution and line-range
  fragments only apply to `"markdown"` entries; an `"html"` entry's URL is
  embedded as given, since it's an external-only view, not something Part E
  would ever fetch or slice.
- Resilience: if permalink resolution fails (forge API unreachable, rate
  limited, etc.), fall back to embedding the branch-relative URL as given
  and log a warning. Extraction must never fail because of this.

## Part C — `schemaRef` fallback

`extract_schema_locations()` in `schema_validator.py` also checks
`encodingDesc/schemaRef/@target` (and `@type`) when no `<?xml-model?>` PI is
found in the document, feeding the same validation pipeline used today.
Documents may carry either or both; when both are present, the PI remains
authoritative (matches the function's current regex-first behavior, simply
extended with a second, lower-priority source).

## Part D — pluggable git-forge adapter registry

New module `fastapi_app/lib/utils/git_forge_adapters.py`, modeled on the
existing `ExtractorRegistry` pattern (`fastapi_app/lib/extraction/registry.py`:
singleton `get_instance()`, `register()`, class-based entries):

```python
class BaseGitForgeAdapter(ABC):
    """One recognized git-forge URL shape (GitHub, GitLab, ...)."""

    @abstractmethod
    def matches(self, url: str) -> bool:
        """True if this adapter recognizes the URL's host/path shape."""

    @abstractmethod
    def to_raw_url(self, url: str) -> str:
        """Transform a blob/view URL into a directly-fetchable raw-text URL."""

    @abstractmethod
    def resolve_ref_to_sha(self, url: str, cache: "UrlCache") -> str:
        """Return `url` with its branch/tag ref replaced by the current commit SHA."""


class GitForgeAdapterRegistry:
    _instance: "GitForgeAdapterRegistry | None" = None

    @classmethod
    def get_instance(cls) -> "GitForgeAdapterRegistry": ...

    def register(self, adapter: BaseGitForgeAdapter) -> None: ...

    def get_adapter_for(self, url: str) -> BaseGitForgeAdapter | None:
        """First registered adapter whose matches() returns True, else None."""
```

- `GitHubAdapter` matches `hostname == "github.com"` with a `/blob/` path
  segment (hostname-gated deliberately, to avoid false-positives on
  unrelated sites that happen to contain `/blob/` in their path); transforms
  to `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`; resolves SHAs
  via `GET api.github.com/repos/{owner}/{repo}/commits/{ref}`.
- `GitLabAdapter` matches any host with a `/-/blob/` path segment (GitLab's
  path marker is distinctive enough to match on shape rather than hostname,
  so this also covers self-hosted GitLab instances without extra
  configuration); transforms `/-/blob/{ref}/{path}` →
  `/-/raw/{ref}/{path}`; resolves SHAs via that GitLab instance's own
  `GET {host}/api/v4/projects/{url-encoded path}/repository/commits/{ref}`.
- Both adapters are registered at module import time as built-ins.
- Adding a third platform later (Gitea, Bitbucket, a self-hosted forge, or
  even a non-git docs host) is one small adapter class plus one
  `registry.register(...)` call — no changes to calling code in Parts B/E.
- Not wired into the app's `Plugin`/`FrontendExtensionRegistry` lifecycle —
  this is an internal utility registry, not a user-facing plugin. Since it's
  a plain importable singleton, a future backend plugin's `initialize()`
  could still call `register()` on it if an institution-specific host ever
  needs its own adapter.
- URLs matched by no adapter (e.g. today's `pad.gwdg.de` links) are used
  as-is for both raw fetch and permalink resolution (i.e. permalink
  resolution is a no-op for them — the URL is already assumed stable) —
  identical to current behavior, nothing regresses.

## Part E — rules-excerpt fetch/slice utility + shared URL cache

- Extract the schema-cache logic in `schema_validator.py`
  (`get_schema_cache_info`, `is_schema_cache_stale`) into a generic cache
  utility, e.g. `fastapi_app/lib/core/url_cache.py`, reused by: schema
  fetching (unchanged behavior), the git-forge SHA lookups (Part D), and the
  rules-excerpt fetcher below. Same TTL mechanism throughout
  (`SCHEMA_CACHE_TTL_SECONDS`-style, possibly with a distinct default for
  non-schema entries).
- New module `fastapi_app/lib/utils/annotation_rules_utils.py`:
  - `resolve_forge_permalink(url: str, cache: UrlCache) -> str` — looks up
    an adapter via the Part D registry; if found, resolves the ref to a SHA
    and returns the rewritten URL; if no adapter matches, returns `url`
    unchanged.
  - `fetch_rule_excerpt(url: str, cache: UrlCache) -> str` — looks up an
    adapter; if found, converts to the raw URL via `to_raw_url()`, otherwise
    fetches `url` directly. Parses an optional `#L<n>` / `#L<n>-L<m>` (or
    GitLab's `#L<n>-<m>`) fragment and slices the corresponding lines from
    the fetched text; returns the whole text if no fragment is present.
    Defensive guard: if the response `Content-Type` is `text/html`, this is
    treated as a sign that we fetched a rendered page rather than raw text
    (e.g. an unrecognized forge's blob view) — log a warning and raise a
    dedicated, catchable error rather than returning HTML as if it were rule
    text.
  - `extract_annotation_rule_refs(xml_string: str) -> list[dict]` — parses a
    TEI document's `editorialDecl/interpretation` entries into
    `{category, target, content_type}` dicts (`category` from
    `interpretation/@type`, `content_type` from the nested `ref/@type` —
    named apart deliberately so callers never confuse the two `@type` axes
    described in Part A), mirroring the shape of
    `extract_schema_locations()`. Only `content_type == "markdown"` entries
    are meaningful input to `fetch_rule_excerpt()`.
- This part ships plumbing only — no new HTTP route, no LLM call. A future
  validator feature calls these functions directly from Python.

## Part F — frontend unification

- `app/src/modules/tei-utils.js` gains a client-side parser, alongside the
  existing XPath-based `getDocumentMetadata()`, that reads
  `editorialDecl/interpretation[@type]/p/ref/@target` from the loaded XML
  DOM into a structured list.
- `annotation-guide.js`, when loading a variant: first checks the open
  document's `editorialDecl` for an `interpretation[@type="general"]` entry
  (no `variant_id` matching needed here — see Part A — the document's own
  `editorialDecl` is already scoped to it). If present, it branches on the
  nested `ref/@type` exactly as it does on `markdownGuide`/`htmlGuide`
  today: `"markdown"` → fetch and render inline (with the client-side
  blob→raw derivation applied first; the original blob URL is used for
  "open in new window"), `"html"` → external-link-only, no fetch. If no
  `general` entry is present at all — i.e. an older document extracted
  before this feature — it falls back to today's runtime
  `ANNOTATION_GUIDES`-by-`variant_id` lookup. No migration script is needed;
  old and new documents both keep working.
- Scroll-to-section behavior is unchanged from today: the `general` entry's
  fragment is a heading-slug anchor (Part A), and the drawer's existing
  `querySelector('#' + anchor)` + `scrollIntoView` logic (already present in
  `annotation-guide.js`) applies to it exactly as it does now, whether the
  URL came from `editorialDecl` or the config fallback. Category entries
  (line-range-addressed) are never passed through this code path — they're
  fetched only by Part E's backend utility, not rendered in the drawer — so
  there's no line-range-to-scroll-position problem to solve here.
- The blob→raw transform itself (Part D) is Python-only; the client needs a
  small equivalent for the two built-in shapes (GitHub, GitLab) to fetch the
  `general` entry's raw markdown. This is a deliberate, minimal duplication
  rather than a shared module — the codebase already has this precedent
  (`app/src/plugins/services.js`'s RelaxNG `<?xml-model?>` regex mirrors
  `schema_validator.py`'s, independently). A third forge added to the Python
  registry later only needs a client-side mirror if it's also meant to back
  the human drawer; the excerpt-fetch use case (Part E) stays server-only.

## Part G — "Refresh Annotation Rules" endpoint + `reload_feature_file` rename

- New grobid-plugin endpoint, e.g. `refresh_annotation_rules` / label
  "Refresh Annotation Rules", `category: "grobid"`, `state_params: ["xml"]`,
  reviewer-gated (`required_roles: ["reviewer"]`, matching
  `reload_feature_file`), following the same **preview/execute**
  confirmation pattern (`fastapi_app/plugins/grobid/routes.py`'s
  `/reload-feature-file/preview` and `/execute` routes are the template).
  Re-derives `editorialDecl` for the open document's `variant_id` from the
  *current* config plus a freshly resolved permalink (reusing Part B's
  generation logic directly, not a duplicate implementation), replaces the
  existing guideline `interpretation` entries in the document, and appends a
  `<revisionDesc><change>` entry noting the update (e.g. `<change
  when="..." who="#user"><desc>Updated annotation rules reference to latest
  guidelines</desc></change>`), consistent with existing gold-file revision
  tracking.
- `reload_feature_file`'s endpoint metadata: `category` changes from
  `"document"` to `"grobid"`; `label` changes from `"Reload GROBID Feature
  File"` to `"Reload Feature File"` (the redundant "GROBID" is no longer
  needed once both actions group under a "Grobid" heading in the Tools
  menu, via `backend-plugins.js`'s existing category-grouping logic).

## Error handling

- Git-forge API/network failures during permalink resolution (extraction
  time or Part G's refresh): log and fall back to the branch-relative URL as
  given; never block the primary operation (extraction, or the refresh
  action's preview step, which should surface the degraded result rather
  than erroring outright).
- Malformed or out-of-range line-range fragments: `fetch_rule_excerpt`
  clamps to the available line count rather than raising; a fragment that
  doesn't parse as a recognized line-range pattern is ignored (whole text
  returned).
- Content that turns out to be HTML where raw text was expected (Part E's
  guard): raise a dedicated error type; callers (a future validator) decide
  whether to skip that excerpt or surface a warning — this spec does not
  define validator-side handling.
- Documents without `editorialDecl` (pre-existing documents): frontend falls
  back to the runtime config (Part F); `extract_annotation_rule_refs()`
  simply returns an empty list, which is a normal, non-error case for all
  backend consumers.

## Testing

- Part B/D: unit tests for `GitHubAdapter`/`GitLabAdapter` (`matches`,
  `to_raw_url`, `resolve_ref_to_sha` with a mocked forge API), and for
  `create_encoding_desc_with_extractor()`'s new `editorialDecl` output.
- Part C: unit tests for `extract_schema_locations()` with `schemaRef`-only,
  PI-only, and both-present cases.
- Part E: unit tests for `resolve_forge_permalink`, `fetch_rule_excerpt`
  (line-range parsing/slicing edge cases: single line, open range,
  malformed fragment, out-of-bounds range, the HTML content-type guard),
  `extract_annotation_rule_refs`, and cache reuse across calls.
- Part F: JS unit tests for the new `tei-utils.js` parser and for
  `annotation-guide.js`'s document-first/config-fallback branch.
- Part G: a backend test mirroring
  `fastapi_app/plugins/grobid/tests/test_reload_feature_file_routes.py` for
  the new preview/execute routes, plus a check on the menu-category rename.
- Test locations follow existing conventions: grobid-plugin-specific tests
  (Parts B, G) go in `fastapi_app/plugins/grobid/tests/` per that plugin's
  `CLAUDE.md`; generic backend-utility tests (Parts C, D, E) follow the
  existing `tests/unit/fastapi/` pattern; frontend tests (Part F) follow the
  existing `tests/unit/js/` pattern.

## Other integration ideas (noted, not built now)

- `tei_annotator` (LLM `<bibl>` annotation,
  `fastapi_app/plugins/tei_annotator/`) could pass the
  `reference-annotation`-category excerpt (i.e. the `interpretation`
  entry whose `@type="reference-annotation"`) as extra prompt context once
  Part E exists — a natural first real consumer of the plumbing, dogfooding
  it before a dedicated validator feature is built.
- `prompt-editor.js` could offer an "insert rule excerpt" helper that looks
  up a category's excerpt for inclusion in a custom instruction.
- `classDecl`/`taxonomy` for documenting the custom `@type` vocabulary used
  by the legal-citation annotation tags, as a sibling `encodingDesc`
  addition to `editorialDecl`.
- A correction's `<change>` entry could reference the pinned guidelines SHA
  that was in effect when the correction was made, for stronger provenance
  — would need a UI trigger point, deferred.

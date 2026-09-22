# Annotation Guide Vocabulary Fix & Dual-Target Refs — Design Spec

## Context

The `editorialDecl` annotation-rules feature (see
[2026-09-22-editorial-decl-annotation-rules-design.md](2026-09-22-editorial-decl-annotation-rules-design.md))
shipped with a config schema and TEI structure where each guide entry
(`fastapi_app/plugins/grobid/config/annotation_guides.py`) is pinned to
exactly one GROBID variant and carries a single `category` value, with
`"general"` as a sentinel meaning "the primary guide to show a human
annotator". That value's name and the schema's single-variant scoping
conflate two independent concerns:

1. **Variant scope**: does a guide apply to one specific extractor variant,
   several, or all of them? The current schema has no way to express
   "applies to all variants" without duplicating the same config entry once
   per variant — and "general" is easily misread as meaning that, even
   though it currently means something else ("the primary guide", scoped to
   one variant like everything else).
2. **Audience/target**: is a ref meant for a human to read (rendered in the
   drawer, scrolled to a heading anchor) or for a machine/LLM to fetch (a
   token-bounded line range, per the original motivating use case — see the
   first spec's Part E)? Today every configured guide URL uses a
   heading-anchor fragment (`#document-segmentation-model`), which is only
   useful for human scrolling — `fetch_rule_excerpt`'s line-range slicing
   never triggers for it, so a hypothetical future LLM validator fetching
   that URL would get the *entire* source document, defeating the
   token-saving purpose that motivated line-range support in the first
   place.

This spec fixes both, without breaking anything already shipped (this
feature has not been released or pushed, so no migration/back-compat
handling is needed).

## Design

### 1. Config schema

```python
class AnnotationGuide(TypedDict):
    variant_ids: list[str]
    category: str
    type: Literal["markdown", "html"]
    url: str
```

Changes from the current schema:

- `variant_id: str` → `variant_ids: list[str]`. A normal entry still lists
  exactly one id (e.g. `["grobid.training.segmentation"]`). The literal
  string `"*"` anywhere in the list means "applies to every GROBID
  variant" — no enumeration needed. Matching logic in
  `build_editorial_decl_entries()` becomes: an entry matches a requested
  `variant_id` if that id is in `variant_ids`, or `"*"` is in
  `variant_ids`.
- `category`'s sentinel value is renamed from `"general"` to `"primary"`.
  It means exactly one thing now: "the main guide to show a human
  annotator for this variant" — i.e. what `annotation-guide.js`'s drawer
  looks up by default. Any other value (e.g. `"footnote-annotation"`) is a
  narrow, machine-oriented topic, unchanged from today's behavior.

`url` keeps its current meaning: a branch-relative git-forge blob URL,
optionally with a heading-anchor fragment (`#some-heading`) or an
already-machine-style line-range fragment (`#L10-L50`), or no fragment at
all (whole document).

### 2. TEI structure: two `<ref>`s per `<interpretation>`

An `<interpretation>` can now hold two `<ref>` children, distinguished by a
new `@subtype` attribute:

```xml
<interpretation type="primary">
  <p>
    <ref subtype="human" target="https://github.com/mpilhlt/fossil/blob/<sha>/docs/guidelines.md#document-segmentation-model" type="markdown"/>
    <ref subtype="machine" target="https://github.com/mpilhlt/fossil/blob/<sha>/docs/guidelines.md#L45-L89" type="markdown"/>
  </p>
</interpretation>
```

- `subtype="human"`: the ref as configured, unchanged — a heading-anchor
  (or fragment-less) URL meant for the drawer's scroll-to-anchor rendering.
- `subtype="machine"`: **auto-derived**, never hand-authored — a
  line-range URL over the same permalink-pinned document, meant for future
  token-bounded machine/LLM fetching via the existing
  `fetch_rule_excerpt()` line-range slicing.

Which ref(s) actually get generated depends on the configured `url`'s
fragment shape and `type` — see "Which refs get generated" below.

### 3. Anchor → line-range translation

New logic in `fastapi_app/lib/utils/annotation_rules_utils.py` (forge-agnostic
— it only needs raw text plus a heading-slug fragment, so it doesn't belong
in `git_forge_adapters.py`):

1. Fetch the full raw text for the (already permalink-pinned) base URL, by
   calling the existing `fetch_rule_excerpt(base_url, cache)` with no
   fragment — it already returns the whole document in that case, so no new
   fetch/cache path is needed.
2. Scan line by line for ATX-style Markdown headings (`^#{1,6}\s+.+$`),
   recording each heading's 1-based line number and level (number of `#`s).
3. Compute a GitHub-style slug for each heading: lowercase, strip
   characters that aren't alphanumeric/space/hyphen, collapse spaces to
   hyphens, and de-duplicate repeated slugs within the document by
   appending `-1`, `-2`, ... in order of appearance (matching GitHub's own
   algorithm, since these guideline documents are fetched from GitHub/GitLab
   blob URLs).
4. Match the human ref's anchor fragment against the computed slugs.
5. The matched heading's section spans from its own line to the line
   immediately before the **next heading at the same or shallower level**
   (i.e. a subsection's own sub-headings stay inside its parent's range,
   never used as a boundary) — or to the end of the file if there is no
   such next heading.
6. The machine ref's target is the base URL (unchanged, still
   permalink-pinned) plus `#L<start>-L<end>`.

### 4. Which refs get generated

Per config entry, based on its `url`'s fragment shape and `type`:

| Configured `url` shape | `type` | Refs generated |
|---|---|---|
| Heading anchor (`#some-heading`) | `markdown` | Both: `human` (as configured) + `machine` (auto-derived line range) |
| Heading anchor (`#some-heading`) | `html` | `human` only — no heading/line-range concept for HTML |
| Already a line range (`#L10-L50`) | either | `machine` only — a line range has no heading to reverse-derive a human anchor from; this is how a purely machine-oriented topic (e.g. `"footnote-annotation"`) stays configurable without ever needing a human-facing anchor |
| No fragment (whole document) | either | `human` only — nothing to slice; a machine consumer fetching the same URL gets the same whole-document text either way, so a separate `machine` ref would be redundant |

### 5. Failure handling

Consistent with this feature's established "never block the primary
operation" philosophy (`resolve_forge_permalink`'s existing behavior):

- If the human ref's anchor slug isn't found anywhere in the fetched
  document (e.g. a heading was renamed or removed upstream), log a warning
  and emit **only** the human ref — extraction/refresh must never fail
  because of this.
- Any other failure while fetching/parsing for translation purposes (network
  error, etc.) — already handled by the existing `fetch_rule_excerpt`/cache
  machinery's own error paths — degrades the same way: skip the `machine`
  ref, keep the `human` one.

### 6. Integration point

This logic lives entirely inside `build_editorial_decl_entries()`
(`fastapi_app/plugins/grobid/annotation_rules.py`), which both GROBID
extraction (`extractor.py`) and the "Refresh Annotation Rules" reviewer
action (`annotation_rules_refresh.py`) already call. No new wiring is
needed at either call site — both automatically start producing dual-target
refs once this function is updated.

### 7. Downstream shape changes

`AnnotationRuleRef` changes from a flat shape to one interpretation holding
a list of ref targets:

```python
class AnnotationRuleRefTarget(TypedDict):
    target: str
    content_type: Optional[str]
    subtype: Literal["human", "machine"]

class AnnotationRuleRef(TypedDict):
    category: str
    refs: list[AnnotationRuleRefTarget]
```

This ripples through every piece of code that currently assumes "one ref
per interpretation":

- **Backend**: `extract_annotation_rule_refs()` (parses TEI →
  `AnnotationRuleRef`s) must collect all `<ref>` children per
  `<interpretation>`, not just the first. `create_encoding_desc_with_extractor()`
  and `_replace_editorial_decl()` (both generate TEI from `AnnotationRuleRef`s)
  must emit one `<ref>` per ref-target, each with its `@subtype`.
- **Frontend**: `getEditorialDeclGuides()` (`tei-utils.js`) must return all
  refs per interpretation (with their `subtype`), not just the first.
  `annotation-guide.js`'s `#getDocumentGeneralGuide()` must specifically
  select the `subtype="human"` ref (ignoring `machine` ones) when picking
  what to render in the drawer — the drawer never shows machine-oriented
  line-range content directly.
- **Config**: `annotation_guides.py`'s schema and its three existing entries
  update to the new `variant_ids`/`"primary"` shape (mechanical rename, same
  URLs).

No back-compat/migration handling is needed anywhere in this list, since
the shipped shape has not been released.

## Non-goals / deferred

- Actually consuming the new `machine` refs from an LLM-based annotation
  validator — out of scope here as it was for the original spec; this only
  ensures the *data* (correctly token-bounded line ranges) exists and stays
  in sync, ready for that future consumer.
- Multi-line-range refs (more than one machine excerpt per topic) — a
  config entry maps to at most one heading-derived range today; splitting
  a single logical topic across multiple non-contiguous ranges is not
  addressed.
- Non-ATX (Setext, `===`/`---` underline) Markdown headings — the fossil
  guidelines document in current use is ATX-only; Setext support can be
  added later if a source document needs it.
- Re-deriving line ranges for `type: "html"` sources — HTML has no
  Markdown-heading concept; if a future guide source is HTML and needs
  machine-targeted excerpts, that would need its own design.

## Testing considerations

- Unit tests for the heading-scan/slugging/section-boundary logic
  (ATX levels, GitHub-style slug collisions, same-or-shallower-level
  boundary detection, end-of-file boundary, anchor-not-found fallback).
- Unit tests for `build_editorial_decl_entries()`'s per-shape ref-generation
  table (heading-anchor+markdown → both refs; heading-anchor+html → human
  only; line-range → machine only; no-fragment → human only).
- Unit tests for the updated multi-ref parsers on both sides
  (`extract_annotation_rule_refs`, `getEditorialDeclGuides`) with
  interpretations holding 0, 1, and 2 refs.
- Unit tests for `annotation-guide.js`'s human-ref selection ignoring a
  sibling `machine` ref.

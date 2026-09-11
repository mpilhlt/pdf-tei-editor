# Collection Coverage Overview — Design Spec

Date: 2026-09-11
Status: Approved for planning

## Problem

A user with access to many collections has no single place to see which
collection/variant combinations still need annotation work. `annotation-progress`
answers this for one collection+variant at a time, but finding *which* combination
needs attention today means opening each one manually.

## Goal

A new backend plugin, **Collection Coverage Overview**, that lists every
collection × annotation-variant combination the current user can access, with:

- gold-standard coverage (`x`/`total` documents)
- annotation lifecycle progress (as used in annotation-progress / annotation
  history), computed from already-indexed file metadata, not by re-parsing TEI
  XML
- a one-click link into `annotation-progress` for that exact collection+variant
- a metric model designed so a new column can be added later without touching
  the aggregation shape

Non-goals: this plugin does not replace `annotation-progress`'s detailed
per-document view, does not modify `annotation-progress` itself, and does not
add a new untagged-only filter mode to it (see "Known limitation" below).

## Reference mockup

An interactive visual mockup was built and iterated during design (sample data,
not live): https://claude.ai/code/artifact/438dbbda-19dc-468a-b387-924f8952cd4d
It demonstrates the layout, the ordinal color ramp for lifecycle stages, the
gold-coverage bar, the faceted filter bar, and the "needs attention" flagging
described below. Two things differ intentionally in the real plugin (see
"Deviations from the mockup").

## Architecture

```text
fastapi_app/plugins/collection_overview/
├── __init__.py            # registers plugin + router (per convention)
├── plugin.py               # CollectionOverviewPlugin — metadata + endpoint
├── routes.py                # /view (HTML) and /export (CSV)
├── static/
│   ├── view.html            # page shell, loaded via load_plugin_html()
│   ├── view.js               # all client logic: render, sort, facet filter
│   └── styles.css            # extracted styles (linked from view.html)
└── tests/
    └── test_collection_overview.py   # @testCovers plugin.py, routes.py
```

- **id**: `collection-overview`
- **category**: `collection` (same menu group as annotation-progress)
- **required_roles**: `["user"]`
- **dependencies**: `["annotation-progress"]` — declared so plugin discovery
  guarantees annotation-progress is loaded before this plugin registers, and so
  plugin loading fails loudly (rather than shipping a dead "Open progress"
  link) if annotation-progress is ever removed or disabled. The deep-link URL
  itself (see below) is still a plain string constant in `view.js` — a static
  client-side file has no access to the Python plugin registry, so there is no
  way to resolve it dynamically; `annotation-progress`'s route prefix is a
  stable, well-known contract in the same sense its own id is.
- **endpoints**: one entry, `state_params: []` — this view is not scoped to
  the currently-open collection/document, so no state is threaded from the
  frontend.

```python
"endpoints": [{
    "name": "show_overview",
    "label": "Show Collection Coverage",
    "description": "Overview of gold-standard coverage and annotation progress across all accessible collections",
    "state_params": [],
}]
```

`show_overview(context, params)` takes no collection/variant params (unlike
annotation-progress) and simply returns:

```python
return {
    "outputUrl": "/api/plugins/collection-overview/view",
    "exportUrl": "/api/plugins/collection-overview/export",
}
```

### Why a custom static page, not `generate_datatable_page()`

annotation-progress and edit_history render through `generate_datatable_page()`
(jQuery + DataTables from CDN). This plugin instead ships its own
`static/view.html` + `view.js`, for two reasons:

1. The faceted collection/variant filter (tag-chip multiselect, OR within a
   facet, AND across facets, one facet narrowing the other's options) has no
   equivalent in stock DataTables and would mean fighting the library rather
   than using it.
2. Row count here is small (collections × variants a user can see — realistically
   a few dozen), so DataTables' pagination/virtualization benefits don't apply;
   a plain array + vanilla-JS sort/filter (as validated in the mockup) is
   simpler and has no external dependency.

The page still uses `load_plugin_html(__file__, "view.html")` for sandbox client
injection (needed for the `sandbox.navigateIframe()` deep link), consistent with
plugin conventions.

## Shared library changes — `fastapi_app/lib/services/statistics.py`

This module already has `calculate_collection_statistics()`, computed entirely
from indexed `FileMetadata` columns (`status`, `variant`, `is_gold_standard`,
`updated_at`) — no TEI XML parsing. It is currently unused by any route
(annotation-progress reimplements similar logic by parsing XML directly, for
version-chain/annotator features this plugin doesn't need). Because it has no
existing caller, this spec extends and slightly clarifies it rather than
introducing a parallel implementation, per the project's "factor out common
code" rule.

### 1. Clarify `variant` semantics

Current code treats both `None` and `""` as "no filter, include every variant."
That is ambiguous for this plugin, which needs a distinct "untagged annotations
only" bucket. Since nothing currently calls this function, its semantics are
changed (not currently a breaking change for any caller):

```python
def calculate_collection_statistics(
    file_repo: FileRepository,
    collection: str,
    variant: Optional[str] = None,
    lifecycle_order: Optional[list[str]] = None,
) -> dict:
    ...
    if variant:
        tei_files = [f for f in tei_files if getattr(f, "variant", None) == variant]
    else:
        # variant is None -> match files with no variant tag (the "untagged" bucket),
        # not "all variants combined". Every call site now passes a specific
        # bucket (a real variant string, or None for untagged) - there is no
        # "all variants at once" mode.
        tei_files = [f for f in tei_files if not getattr(f, "variant", None)]
```

### 2. Add gold-standard coverage to the same pass

`doc_annotations` entries gain `is_gold_standard` (already on `FileMetadata`,
just not copied over today):

```python
annotation_info = {
    "annotation_label": file_metadata.label or "Untitled",
    "stable_id": file_metadata.stable_id,
    "status": file_metadata.status or "",
    "updated_at": file_metadata.updated_at,
    "is_gold_standard": file_metadata.is_gold_standard,
}
```

And the return dict gains:

```python
gold_doc_ids = {
    doc_id for doc_id, anns in doc_annotations.items()
    if any(a["is_gold_standard"] for a in anns)
}
return {
    ...,
    "gold_count": len(gold_doc_ids),
}
```

`is_gold_standard` is scoped per `(doc_id, variant)` in the data model (see
`FileRepository.set_gold_standard`), so counting it within the already
variant-filtered `tei_files` is correct — no extra query needed.

### 3. New: `get_collection_variants()`

```python
def get_collection_variants(file_repo: FileRepository, collection_id: str) -> list[Optional[str]]:
    """Distinct variant values among a collection's TEI files, None first.

    Returns [None] (the "untagged" bucket) if the collection has no TEI files
    yet, so every collection produces at least one overview row.
    """
    files = file_repo.get_files_by_collection(collection_id)
    variants = {f.variant for f in files if f.file_type == "tei"}
    normalized = {v if v else None for v in variants}
    return sorted(normalized, key=lambda v: (v is not None, v or "")) or [None]
```

### 4. New: `build_overview_rows()`

The single aggregation entry point the plugin route calls:

```python
def build_overview_rows(
    file_repo: FileRepository,
    collections: list[dict],       # [{"id": ..., "name": ...}, ...]
    lifecycle_order: list[str],
) -> list[dict]:
    rows = []
    for coll in collections:
        for variant in get_collection_variants(file_repo, coll["id"]):
            stats = calculate_collection_statistics(file_repo, coll["id"], variant, lifecycle_order)
            rows.append({
                "collection_id": coll["id"],
                "collection_name": coll["name"],
                "variant": variant,
                **stats,
            })
    return rows
```

Each row dict: `collection_id`, `collection_name`, `variant`, `total_docs`,
`total_annotations`, `avg_progress`, `stage_counts`, `doc_annotations`,
`gold_count`.

### Extensibility for future metrics

Adding a metric later means: add one field to the dict returned by
`calculate_collection_statistics` (or a second small function called from
`build_overview_rows` and merged into the row), then add one entry to the
`COLUMNS` list in `routes.py` (below). No registry, no plugin-of-plugins - the
row dict is the extension point.

## Collection resolution (access control)

```python
from fastapi_app.lib.permissions.user_utils import get_user_collections
from fastapi_app.lib.utils.collection_utils import list_collections

accessible_ids = get_user_collections(user, settings.db_dir)  # None = wildcard/all
all_collections = list_collections(settings.db_dir)            # [{"id","name","description"}, ...]

if accessible_ids is None:
    collections = all_collections
else:
    accessible_set = set(accessible_ids)
    collections = [c for c in all_collections if c["id"] in accessible_set]
```

`collections` (list of `{"id", "name"}`) is passed to `build_overview_rows()`.
Collections referenced by a project but no longer present in `collections.json`
are silently skipped (same as today - `list_collections` is the source of truth
for what exists).

## Route: `GET /api/plugins/collection-overview/view`

1. Authenticate (standard session/header pattern, per `fastapi_app/CLAUDE.md`).
2. Resolve `collections` as above.
3. `lifecycle_order = get_config().get("annotation.lifecycle.order", default=[])`.
4. `rows = build_overview_rows(file_repo, collections, lifecycle_order)`.
5. Serialize `rows` to JSON (only the fields the page needs — `doc_annotations`
   is dropped, `stage_counts` kept for the distribution bar) and embed as
   `<script>window.__OVERVIEW_ROWS__ = [...];</script>` in the rendered
   `view.html`, followed by the sandbox client script.
6. `view.js` does all rendering/sorting/filtering client-side against that
   array, exactly as validated in the mockup.

### Row → column mapping (`COLUMNS`, defined in `view.js`)

| Column | Sortable | Content |
|---|---|---|
| Collection | yes (name) | Collection name, id as a faint subtitle |
| Variant | yes (raw value) | Tag-styled pill, or a dashed "— none —" pill when `variant` is `null` |
| Documents | yes (numeric) | `total_docs` |
| Gold standard | yes (numeric, `gold_count/total_docs`) | Fraction `gold_count/total_docs` + a single-hue progress bar (a **meter**, not the ordinal ramp — see palette note below); the fraction and bar switch to the warn color under 50% |
| Progress | yes (numeric, `avg_progress`) | `avg_progress`% (colored by the dominant stage's ordinal color) + a segmented stage-distribution bar + "mostly `{dominant stage}`" caption |
| Action | no | "Open progress →" |

`avg_progress` for a row = mean over that row's documents of
`(stage_index + 1) / len(lifecycle_order) * 100`, i.e. exactly the formula
`calculate_collection_statistics` already uses for its (unused today)
`avg_progress` field, just read per-row instead of per-collection. This is the
sortable number; the distribution bar is the "where do they cluster" visual,
not the sort key (this split was clarified with the user mid-design — see the
mockup's `avgProgress()` / `stageSegBar()`).

### Lifecycle stage color — ordinal ramp, not categorical

Lifecycle stage is a position in an ordered sequence, not a set of unrelated
identities, so its segments use a single-hue **ordinal** ramp (validated with
the dataviz skill's `validate_palette.js --ordinal`, both light and dark
surfaces at the time of the mockup — production page is light-only, see
deviations below), not one hue per stage. Validated light-mode hex steps
(index 0 = least progress → index 7 = most progress):

```text
#50b7b7 #35a0a0 #0e8989 #007373 #005d5e #004849 #003436 #002123
```

Checks passed: lightness monotone, adjacent ΔL ≥ 0.06 (OKLCH), light-end
contrast ≥ 2:1 against a white surface, single hue (±6°). Re-run the validator
if these steps are ever changed by hand rather than copied verbatim.

Mark spec: 2px surface-color gap between segments, per-segment `title`
tooltip (`"{stage}: {n} of {docs} documents ({pct}%)"`), no inline labels
(too narrow) - detail lives in the tooltip and the dominant-stage caption.

## KPI row (page header)

- **Collections in scope** — count of distinct `collection_id`
- **Documents tracked** — sum of `total_docs` per distinct collection (not
  per row — a collection's doc count must not be multiplied by its variant count)
- **Combinations** — row count (collections × variants)
- **Rows needing attention** — count of rows matching the "needs attention"
  rule, `n / total combinations`

"Gold coverage overall" from the mockup is dropped from the KPI row: a single
blended percentage across variants of the same collection double-counts
documents and doesn't have a clean definition. Per-row gold coverage remains
in the table; a collection-level rollup can be added later as a genuinely new
metric if wanted.

## "Needs attention" rule

A row is flagged (subtle warm left-edge tint, and counted in the KPI tile)
when `avg_progress < 45` **or** the row has no annotations at all (`dominant
stage is null`). This threshold lives as a single named constant in `view.js`
so it's easy to tune later; it is not exposed as a user setting in this
iteration.

## Filter bar

Two independent facets, **Collection** and **Variant**, each a plain
HTML/CSS/JS control styled like Shoelace's `<sl-select multiple>` (tag chips in
a bordered control, opening a checkbox dropdown) rather than the real Shoelace
component — this page is a standalone document outside the app's Shoelace
bundle, and pulling in the full component library for one filter isn't
justified. Semantics:

- Within a facet: checked values are OR'd.
- Across facets: AND'd (`collection ∈ selected ∪ {all if none selected}` AND
  same for variant).
- **Selecting one or more collections narrows the Variant facet's option list**
  to only variants actually present in the selected collection(s) (confirmed
  with the user during design). The reverse (variant narrowing collection
  options) is not implemented — not requested, and collections are the primary
  axis a user thinks in.
- A "Show needs-attention only" toggle stacks on top of both facets.
- "Clear filters" appears once any facet has a selection.
- All filtering is client-side over the embedded row array — no server
  round-trip per filter change.

## Deep link to annotation-progress

Each row's "Open progress →" action calls:

```js
sandbox.navigateIframe(
  `/api/plugins/annotation-progress/view?collection=${collectionId}` +
  (variant ? `&variant=${encodeURIComponent(variant)}` : "")
);
```

This navigates the *same* plugin dialog iframe to annotation-progress's own
view (the existing "Options-then-Execute" sandbox pattern), rather than
opening a new tab or duplicating annotation-progress's rendering logic.

**Known limitation**: for the untagged ("— none —") bucket, the link omits the
`variant` param entirely, because annotation-progress's own `/view` route has
no "untagged only" filter mode today (an empty/absent `variant` there means
"show all variants for this collection unfiltered"). Adding that mode to
annotation-progress is out of scope for this plugin; noted here so it isn't
mistaken for a bug when the "— none —" row's link shows more than expected.

## CSV export — `GET /api/plugins/collection-overview/export`

Recomputes the same rows server-side (unfiltered — the export is a complete
record regardless of what's currently shown on screen) and streams a CSV with
one row per collection/variant combination: `Collection ID, Collection Name,
Variant, Documents, Gold Standard Count, Gold Standard %, Avg Progress %,
Dominant Stage`. Same auth/access-control pattern as annotation-progress's
`/export`.

## Deviations from the mockup

The exploratory Artifact mockup (a general-purpose, CSP-sandboxed canvas) made
two choices that don't carry over to the real, self-hosted plugin page:

1. **Typography** — the mockup paired Google-hosted fonts (Libre Franklin /
   IBM Plex Sans / IBM Plex Mono) for a considered look. The real page uses the
   system font stack already used by annotation-progress
   (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`), so
   this plugin doesn't introduce an external font dependency into a
   self-hosted tool. `font-variant-numeric: tabular-nums` is kept for the
   numeric columns.
2. **Theming** — the mockup is light/dark aware (an Artifacts platform
   requirement). No existing backend-plugin page in this codebase supports
   dark mode; the real page stays light-only for consistency with
   annotation-progress, edit_history, etc. The ordinal ramp above is the
   light-mode ramp only; a dark variant is not needed.

Everything else — layout, the ordinal color ramp, the gold-coverage meter, the
distribution bar with tooltips, the KPI tiles, the faceted filter bar and its
interaction rules, the needs-attention flag — carries over as designed and
validated in the mockup.

## Testing

- `fastapi_app/plugins/collection_overview/tests/test_collection_overview.py`
  with `@testCovers` pointing at `plugin.py`, `routes.py`, and the changed
  functions in `fastapi_app/lib/services/statistics.py`.
- Unit tests for the `statistics.py` additions: `gold_count` correctness
  (including the per-variant scoping), the clarified `variant=None` = untagged
  semantics, `get_collection_variants()` (including the "no TEI files yet"
  → `[None]` case), and `build_overview_rows()` row shape.
- Route tests following the auth/access-control pattern used by
  annotation-progress's own tests (dependency overrides for `get_db`,
  `get_file_storage`, per `fastapi_app/CLAUDE.md`).
- No JS unit tests are planned for `view.js`'s client-side sort/filter logic
  beyond what was already validated interactively in the mockup, unless the
  testing guide's conventions call for one — check
  `docs/code-assistant/testing-guide.md` during implementation.

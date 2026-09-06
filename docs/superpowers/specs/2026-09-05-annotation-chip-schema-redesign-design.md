# Annotation chip system: schema-driven redesign

## Problem

Annotation tag chips (the "Annotate as…" / "Change to" palettes in the
visual XML editor) are hand-authored in
`fastapi_app/plugins/grobid/config/annotation_tags.py` (443 lines,
`ANNOTATION_TAGS: AnnotationTagsMap`). This has two costs:

1. **Drift.** The RelaxNG schemas at
   `data/schema/cache/mpilhlt.github.io/grobid-footnote-flavour/schema/*.rng`
   (downloaded from the external `mpilhlt/grobid-footnote-flavour` repo) are
   the actual source of truth for what's valid, but nothing keeps the manual
   config in sync. Concretely, today's config is already stale in both
   directions: `orgName@type` allows 6 values in the schema but only 2
   (`court`, `collaboration`) are exposed as chips; `references_ref`
   (`anaphoric`/`cataphoric`) exists in the schema with no chip at all; while
   `idno@type`, `biblScope@unit`, `ptr@type`, and `note@type` have curated
   chip presets (`DOI`, `page`, `web`, `report`, …) for attributes that are
   completely freeform in the schema (no enumeration at all).
2. **Crowding.** Every attribute-value variant is its own flat chip
   (`title[a]`, `title[j]`, `title[m]`, `title[s]`, `title[legislation]`,
   `title[caseName]` are six separate buttons for one `<title>` tag). The
   `grobid.training.references` palette alone has 28 entries. Finding the
   right one is slow.

## Goals

- Generate `AnnotationTagsMap` from the schema at startup instead of hand
  authoring it. A schema declaration becomes the *only* way to get a chip —
  no schema, no palette.
- One chip per tag name (alphabetical), with attribute-value variants moved
  into a split-button dropdown on that chip.
- Preserve the two things the manual config currently provides that aren't
  derivable from element/attribute names alone: hover descriptions, and
  curated attribute-value sets for attributes the schema doesn't enumerate.
  Both move into the schema itself (upstream repo), not into local config.
- No frontend API contract break: `get_annotation_tags()` keeps its
  signature and return shape; the frontend's `AnnotationTagDef` model is
  extended, not replaced.

## Non-goals

- Rewriting or replacing `fastapi_app/lib/utils/relaxng_to_codemirror.py`'s
  parser. This design extends it (one new capability: per-`<value>`
  documentation) and reuses the rest as-is.
- Changing how GROBID training/inference itself works.
- Migrating the `data/schema/cache/` download/TTL mechanism. It's reused
  unmodified (see "Cache lifecycle" below) — this design works within its
  existing lazy-refresh, mtime-based staleness model.
- A generic multi-schema plugin framework. This targets the three GROBID
  training variants (`grobid.training.segmentation`,
  `grobid.training.references.referenceSegmenter`,
  `grobid.training.references`) that already have cached RNG schemas.

## Architecture

### Data flow

```text
mpilhlt/grobid-footnote-flavour (external repo)
  schema/grobid.training.*.rng  (source, hand-authored, gets <a:documentation>)
        │  build-schema.py (lives in that repo)
        ▼
  https://mpilhlt.github.io/.../schema/*.rng  (published, built)
        │  fastapi_app/lib/core/schema_validator.py (existing download + TTL cache)
        ▼
  data/schema/cache/mpilhlt.github.io/.../schema/*.rng  (local cache, this repo)
        │  NEW: annotation_tags_generator.py (extends RelaxNGParser)
        ▼
  AnnotationTagsMap  (in-memory, regenerated when the cached .rng's mtime changes)
        │  get_annotation_tags()  (existing function, unchanged signature)
        ▼
  GET /extract/list → ext.annotationTags[variant]  (existing API, unchanged)
        │
        ▼
  xml-annotation-popup.js  (rendering changes: split-button dropdown)
```

The key point: everything from `data/schema/cache/` downward is new; the
API surface above `get_annotation_tags()` — the FastAPI model, the
`/extract/list` endpoint, `api-client-v1.js`, `xml-annotation.js`'s
`updateTagDefs` — is untouched. Only the shape of individual
`AnnotationTagDef` objects gains two optional fields (see below), and only
`xml-annotation-popup.js` changes its rendering.

### Backend: `annotation_tags_generator.py`

New module `fastapi_app/plugins/grobid/config/annotation_tags_generator.py`.
Builds on `RelaxNGParser` (`fastapi_app/lib/utils/relaxng_to_codemirror.py`),
which already extracts, per element definition: child elements, attributes
(with enumerated `<value>` lists or `None` for freeform), and
`<a:documentation>` text on both `<element>` and `<attribute>`. Two small
extensions are needed there (see "Parser extensions").

For each variant, generation proceeds as:

1. Parse the variant's cached `.rng` file with `RelaxNGParser`.
2. Look up the variant's **scope** (a tiny static config, see below): a root
   element name and an optional exclude set.
3. The chip set = `{root}` ∪ `children(root)`, minus the exclude set.
4. For each tag in that set, build one `AnnotationTag`:
   - `label` = tag name.
   - `description` = the element's `<a:documentation>` text, if any.
   - `color` = deterministic palette assignment (see "Color assignment").
   - `childTags` = the schema's content-model children for that tag (same
     `_extract_child_elements` output already used for autocomplete) — this
     is exactly what `xml-annotation.js#wrapSelectionWith` already consumes
     to decide nest-vs-split, so behavior here is unchanged.
   - `attributes` = one entry per attribute that has enumerated values,
     each `{name, values: [{value, description?}], required}`. `required`
     is `true` iff the RNG does not wrap that `<attribute>` in `<optional>`.
   - Attributes with no enumeration (freeform, e.g. `title@key`) are *not*
     turned into chip/dropdown variants — they stay editable as free-text
     fields in the existing attribute-properties popup, unchanged from
     today.

### Scope config (stays local, small, stable)

Unlike `ANNOTATION_TAGS`, this doesn't grow with every schema change — it
only changes if a variant's overall document shape changes (rare). New
file, replacing all of `annotation_tags.py`'s tag data:

```python
# fastapi_app/plugins/grobid/config/annotation_tags_scope.py

class TagScope(TypedDict):
    root: str
    exclude: set[str]

ANNOTATION_TAG_SCOPE: dict[str, TagScope] = {
    "grobid.training.segmentation": {
        "root": "text",
        "exclude": {"lb"},
    },
    "grobid.training.references.referenceSegmenter": {
        "root": "bibl",
        "exclude": {"lb"},
    },
    "grobid.training.references": {
        "root": "bibl",
        "exclude": {"lb"},
    },
}
```

`root` is the element whose content model defines "what can be tagged
here"; `bibl`'s own chip plus all of `bibl`'s allowed children (minus
`lb`) is exactly today's `grobid.training.references` chip set (verified
against the cached RNG: `label`, `author`, `orgName`, `title`, `date`,
`biblScope`, `citedRange`, `publisher`, `pubPlace`, `editor`, `edition`,
`ptr`, `idno`, `note`, `seg`, `ref`). `lb` is excluded consistently across
all three variants — a bare line-break isn't meaningfully "annotated" via
this popup, and no current manual config exposes it as a chip. For
`segmentation`, `text`'s children are `titlePage`, `toc`, `div`, `body`,
`front`, `lb`, `listBibl`, `note`, `page`.

### Color assignment

Reuse the current palette (the Catppuccin-Mocha-style hex values already in
`annotation_tags.py`) as a fixed, ordered list. Assignment:

```python
import hashlib

def color_for_tag(tag_name: str, taken: set[str]) -> str:
    index = int(hashlib.sha256(tag_name.encode()).hexdigest(), 16) % len(PALETTE)
    while PALETTE[index] in taken:
        index = (index + 1) % len(PALETTE)
    return PALETTE[index]
```

- Hash on tag name alone (not `(variant, tag)`) so the same tag name gets
  the same color in every variant's toolbar — e.g. `date` and `title` look
  the same whether you're in `segmentation` or `references`.
- `taken` tracks colors already assigned *within the current variant's chip
  set* (reset per variant), so two tags in the same toolbar never collide
  even if their hashes do. Cross-variant collisions are fine — the toolbars
  are never shown side by side.
- Use `hashlib`, not Python's built-in `hash()` — the latter is randomized
  per-process (`PYTHONHASHSEED`) and would reshuffle colors on every
  server restart.

### Cache lifecycle

No new caching layer. `get_annotation_tags()` keeps a per-variant
`(mtime, AnnotationTag list)` in memory; on each call it stats the cached
`.rng` file and regenerates only if the mtime changed since the last build
(mirrors `schema_validator.is_schema_cache_stale()`'s own mtime check, but
this is a separate, cheap comparison — it does not trigger a re-download).
If the `.rng` file is missing (schema never fetched, e.g. cold start before
any validation has run against that variant), the variant gets an empty
tag list rather than an error — consistent with "a schema declaration is
strictly necessary."

### Frontend: split-button chip

`xml-annotation-popup.js`'s `#renderPalette` changes from "one flat chip
per `AnnotationTagDef`" to "one chip per unique tag name in the def list,
plus a dropdown if that tag has enumerated attributes":

- **No enumerated attributes** (e.g. `author`, `pubPlace`): plain chip,
  same as today, click inserts the bare tag.
- **Enumerated attribute(s), none required** (e.g. `orgName@type`,
  `date@type`): chip inserts the bare tag on click; a caret button opens an
  `sl-dropdown`/`sl-menu` (Shoelace — already used for this pattern in
  `toolbar-menu-button.html`, just not yet for tag variants) listing one
  `sl-menu-item` per attribute value, e.g. `orgName[court]`,
  `orgName[collaboration]`, …
- **A required enumerated attribute** (currently only `citedRange@unit`,
  see schema fix list below — after the `title@level` fix, `title` joins
  this group): the chip body is visually inert (no hover/insert affordance)
  and clicking anywhere on it — body or caret — opens the dropdown. There
  is no bare-tag option in the menu.
- Tooltip (`title` attribute) on the main chip = tag-level `description`.
  Tooltip on each dropdown item = that value's own description if the
  schema provides one, else falls back to the tag-level description.

`AnnotationTagAttribute` (`fastapi_app/lib/models/models_extraction.py`)
changes shape: `values: Optional[List[str]]` becomes
`values: Optional[List[AttributeValueOption]]` where
`AttributeValueOption = {value: str, description: Optional[str]}`, and the
model gains `required: bool` (default `False`, for the freeform attributes
that still pass through the model unchanged). `AnnotationTagDef.color`
and `.description` are unchanged; `.priority` is dropped (ordering is
alphabetical by tag name now, computed at generation time, not per-def) —
`xml-annotation-popup.js:339`'s priority sort is replaced with a sort on
tag name, and `defaultAttributes`/`labelMap`-based multi-entry-per-tag
patterns in the old data go away since there's exactly one `AnnotationTag`
per tag name now.

## Descriptions: schema-side convention

Descriptions move into the RNG **source** in the upstream
`mpilhlt/grobid-footnote-flavour` repo (`schema/grobid.training.*.rng`,
pre-build — not the generated/published `.rng`, and not the local
`data/schema/cache/` copy, which is a downloaded build artifact silently
overwritten by `schema_validator.py` once its mtime crosses the 1-hour
`SCHEMA_CACHE_TTL_SECONDS` and a validation call touches that schema URL
again).

The mechanism is the standard RelaxNG Compatibility Annotations namespace,
`<a:documentation>`, already used this way in this repo's own
`schema/rng/tei-bib.rng` and already parsed by
`RelaxNGParser._extract_documentation()` for both `<element>` and
`<attribute>` nodes:

```xml
<define name="references_citedRange">
  <element name="citedRange">
    <a:documentation>Pinpoint into a statute or decision (section,
      subsection, marginal number, etc.)</a:documentation>
    <attribute name="unit">
      <choice>
        <value datatypeLibrary="">section</value>
        <value datatypeLibrary="">sub-section</value>
        ...
      </choice>
    </attribute>
    ...
  </element>
</define>
```

### Parser extension needed: per-value documentation

`_extract_attribute_values()` currently collects `<value>` text but not any
annotation on it. To get per-variant tooltips (e.g. distinguishing
`citedRange[unit=page]` from `citedRange[unit=section]`), extend it to also
read `<a:documentation>` as a child of `<value>`:

```xml
<attribute name="unit">
  <choice>
    <value datatypeLibrary="">page</value>
    <!-- becomes -->
    <value datatypeLibrary="">page<a:documentation>Pinpoint by printed page number</a:documentation></value>
  </choice>
</attribute>
```

RelaxNG permits annotation elements as children of any pattern, so this is
valid without a schema-language change — just an additional small XPath in
the existing extraction function, returned as
`{value, description}` instead of a bare string.

### Known complexity: correlated attribute presets

Most current curated variants are independent single-attribute choices
(`orgName@type=court`, `citedRange@unit=page`) and map cleanly to "one
dropdown item per enumerated value." Two current presets don't:
`title[legislation]` (`level=m` **and** `type=legislation` together) and
`title[caseName]` (`level=a` **and** `type=caseName` together) are specific
paired combinations, not independent axes — the schema doesn't mean
"any level with type=legislation."

Recommended fix: restructure `title`'s attributes in the upstream schema
from two independent optional attributes into an optional `<choice>` of
`<group>`s, one per named preset:

```xml
<optional>
  <choice>
    <group>
      <attribute name="level"><value>a</value></attribute>
    </group>
    <group>
      <attribute name="level"><value>j</value></attribute>
    </group>
    <group>
      <attribute name="level"><value>m</value></attribute>
    </group>
    <group>
      <attribute name="level"><value>s</value></attribute>
    </group>
    <group>
      <a:documentation>Title of a statute / legislative act</a:documentation>
      <attribute name="level"><value>m</value></attribute>
      <attribute name="type"><value>legislation</value></attribute>
    </group>
    <group>
      <a:documentation>Case name of a court ruling</a:documentation>
      <attribute name="level"><value>a</value></attribute>
      <attribute name="type"><value>caseName</value></attribute>
    </group>
  </choice>
</optional>
```

This requires one more parser extension: recognize a top-level `<choice>`
of `<attribute>`/`<group>` alternatives directly under an (optional)
attribute-position as a set of named "presets," where a `<group>` preset
carries multiple attribute assignments plus its own `<a:documentation>`,
rather than assuming every enumerated attribute is independent. This is
the one piece of real parser work beyond the per-value documentation
extension; everything else in this design reuses existing extraction
logic. Flagging this explicitly because it needs sign-off from whoever
maintains the upstream schema before implementation — it changes the shape
of `title`'s content model, not just its documentation.

## Required schema fixes (upstream repo)

Beyond adding `<a:documentation>`, these attributes need real enumerations
added (or a required-ness change) to avoid losing current behavior when
the manual config is deleted. None of these are drift — the current manual
curation *for these specific attributes* has no schema backing at all
today (`values: []` / freeform `<attribute>`), so schema generation
produces nothing for them until fixed:

| Variant | Element@Attribute | Values to add | Currently |
| --- | --- | --- | --- |
| references | `idno@type` | DOI, arXiv, report, docket, ECLI, CELEX | freeform |
| references | `biblScope@unit` | page, volume, issue | freeform |
| references | `ptr@type` | web | freeform |
| references | `note@type` | report | freeform |
| references | `title@type` | legislation, caseName | freeform (see correlated-preset fix above) |
| references | `title@level` | (no new values) make **required** | optional |
| segmentation | `div@type` | contribution (add to existing 6) | partially enumerated |
| referenceSegmenter | `bibl@type` | decision, legislation (add to existing `footnote`) | partially enumerated |

These already fully enumerated and need **no schema change** — generation
will surface them as new chips/variants that don't exist in today's manual
config, which is an intended improvement, not a bug to fix:

- `orgName@type`: already has `court`, `jurisdiction`, `institution`,
  `collaboration`, `department`, `laboratory` (manual config only exposes
  2 of 6 today).
- `references_date@type` (the `date` tag in `references`): already has
  `decision`, `enacted`, `publication` (manual config omits `publication`).
- `references_ref` (the `ref` tag, `type=anaphoric`/`cataphoric`): fully
  enumerated in the schema, has no chip at all today — will appear as a
  brand-new chip.
- `title@level` value `u` (unpublished): already enumerated; whether to
  keep it as a real dropdown option or remove it from the schema is a
  content decision for whoever maintains the upstream schema, not a
  blocker for this design.

## Description migration table

Every `description` string currently in `annotation_tags.py`, to be pasted
into the upstream RNG as `<a:documentation>` (element-level unless an
attribute/value is named):

### `grobid.training.segmentation`

| Tag | Attribute=Value | Description |
| --- | --- | --- |
| body | — | The main body of the document |
| listBibl | — | Bibliographical section |
| front | — | Document header / front matter |
| titlePage | — | Cover page |
| note | place=footnote | Page footer or numbered footnote |
| page | — | Page number indicator |
| div | type=acknowledgement | Acknowledgement statement in the annex |
| div | type=toc | Table of contents |
| note | place=headnote | Page header / running head |
| div | type=annex | Any other annex section |
| div | type=funding | Funding information annex |
| div | type=conflict | Conflict of interest statement |
| div | type=contribution | Author contribution statement |
| div | type=availability | Data/code availability statement |

### `grobid.training.references.referenceSegmenter`

| Tag | Attribute=Value | Description |
| --- | --- | --- |
| bibl | — | An individual bibliographic reference |
| bibl | type=footnote | A note or comment that is not a bibliographic reference |
| label | — | Reference number or footnote marker (e.g. [1], ¹) |
| bibl | type=decision | A court ruling / judicial decision citation |
| bibl | type=legislation | A statute / legislation citation |

### `grobid.training.references`

| Tag | Attribute=Value | Description |
| --- | --- | --- |
| bibl | — | An individual bibliographic reference |
| bibl | type=footnote | A note or comment that is not a bibliographic reference |
| bibl | type=decision | A court ruling / judicial decision citation |
| bibl | type=legislation | A statute / legislation citation |
| title | level=m,type=legislation | Title of a statute / legislative act |
| title | level=a,type=caseName | Case name of a court ruling |
| orgName | type=court | Court issuing a decision |
| citedRange | — | Pinpoint into a statute or decision (section, subsection, marginal number, etc.) |
| citedRange | unit=section | (none currently; candidate: "Numbered section, e.g. § 19a") |
| citedRange | unit=sub-section | (none currently; candidate: "Subsection, e.g. Abs. 2") |
| citedRange | unit=sentence | (none currently; candidate: "Sentence within a subsection, e.g. Satz 2") |
| citedRange | unit=number | (none currently; candidate: "Numbered item, e.g. Nr. 3") |
| citedRange | unit=letter | (none currently; candidate: "Lettered item, e.g. lit. b") |
| citedRange | unit=margin | (none currently; candidate: "Marginal number, e.g. Rn./Tz. 12") |
| citedRange | unit=recital | (none currently; candidate: "Recital of an EU legal act") |
| citedRange | unit=page | (none currently; candidate: "Pinpoint by printed page number") |
| seg | type=signal | Discourse signal word introducing or framing a citation (e.g. 'see', 'vgl.', 'cf.') |
| author | — | Complete sequence of author names |
| title | level=a | Article or chapter title (analytics) |
| title | level=j | Journal title |
| date | — | Publication date sequence |
| date | type=decision | (none currently; candidate: "Date a court decision was issued") |
| date | type=enacted | (none currently; candidate: "Date a statute was enacted") |
| date | type=publication | (none currently; candidate: "Date of publication") |
| biblScope | unit=page | Full page range of the article |
| title | level=m | Monograph, proceedings, book, or thesis title |
| publisher | — | Publisher name; also used for corporate authors such as web pages |
| biblScope | unit=volume | Volume number |
| biblScope | unit=issue | Issue / number |
| edition | — | Edition of a publication |
| orgName | — | Institution for theses or technical reports |
| pubPlace | — | Publication place or location of publishing institution |
| editor | — | Sequence of editor names |
| ptr | type=web | Web URL (exclude prefixes like 'URL:' and trailing periods) |
| idno | type=DOI | (none currently; candidate: "Digital Object Identifier") |
| idno | type=arXiv | (none currently; candidate: "arXiv preprint identifier") |
| idno | type=report | (none currently; candidate: "Technical/institutional report number") |
| idno | type=docket | (none currently; candidate: "Court docket number") |
| idno | type=ECLI | (none currently; candidate: "European Case Law Identifier") |
| idno | type=CELEX | (none currently; candidate: "EU CELEX document identifier") |
| note | — | Any note not covered by another tag |
| title | level=s | Series title |
| orgName | type=collaboration | Project-based collaboration acting as an author group |
| note | type=report | Type of report or thesis (e.g. 'Ph.D. thesis', 'Technical Report') |

Rows marked "none currently" have no existing description to migrate
(the current config leaves them undocumented, relying on the label alone)
but need one now since the attribute-value is only reachable via the
dropdown, not visible as its own labeled chip — a placeholder candidate is
suggested; whoever authors the upstream schema should review/replace these
rather than take them as final wording.

## Testing

- **Backend**: rewrite `fastapi_app/plugins/grobid/tests/test_annotation_config.py`
  and `tests/unit/fastapi/test_annotation_tag_models.py` to test
  `annotation_tags_generator.py` against small fixture `.rng` files (not
  the full downloaded schema) — covering: bare-vs-required attribute
  gating, color determinism/collision-avoidance, childTags derivation,
  missing-schema → empty list, mtime-based regeneration.
- **Frontend**: existing e2e annotation tests that click specific chips
  (search for `title[a]`-style selectors) need updating for the
  split-button interaction — clicking a caret before selecting a menu
  item instead of clicking a uniquely-labeled chip directly.

## Migration / rollout order

1. Upstream repo: add `<a:documentation>` (tag + attribute + value level)
   per the migration table above; add the missing enums and the
   `title@level` required-ness / `title` attribute-group restructuring
   from "Required schema fixes."
2. This repo: extend `RelaxNGParser` (per-value docs, attribute-group
   presets), add `annotation_tags_generator.py` and
   `annotation_tags_scope.py`, wire `get_annotation_tags()` to the
   generator, delete `annotation_tags.py`.
3. This repo: extend `AnnotationTagAttribute`/`AnnotationTagDef` models,
   update `xml-annotation-popup.js` for the split-button rendering.
4. Update tests per above.

Step 1 can land independently and early (it only adds annotations/enums,
it doesn't change what currently-valid documents look like), so backend
work in step 2 can be developed and reviewed against the real upstream
schema rather than fixtures alone, once it's published.

# Legal citation annotation tags — design

## Problem

The visual annotation editor lets annotators relabel spans inside a `<bibl>`
(author, title, date, etc.) via a "Change to" popup, but two things are
missing/broken:

1. **`<bibl>` itself has no popup at all** in the `grobid.training.references`
   variant (the view used for fully-annotated reference content). It's only
   defined as a clickable tag in the sibling
   `grobid.training.references.referenceSegmenter` variant. So an annotator
   can never change a bibl's own `@type` (e.g. `footnote` → `decision`) from
   this view.
2. **The palette is broken whenever two presets share a tag name.** Today
   `title[a]`/`title[j]`/`title[m]`/`title[s]` all share `tag: "title"`.
   `#renderPalette`'s "current" check only compares `def.tag === currentTag`,
   so *all* same-tag presets show as greyed-out/unclickable. Even if that
   were bypassed, `#retag()` has `if (element.localName === newDef.tag) return`,
   which no-ops the instant the tag name matches — so switching between
   `title[a]` and `title[j]` (or any bibl subtype) silently does nothing.

Separately, the mpilhlt/grobid-footnote-flavour project has proposed a
schema extension for labelling German-language legal citations (statutes,
court rulings) inside footnotes — see
`docs/spec-legal-references.md` in that repo. It introduces:

- `<bibl type="legislation"|"decision">`
- `<citedRange unit="section"|"sub-section"|"sentence"|"number"|"letter"|"margin"|"recital"|"page">`
- `<orgName type="court">`
- `<idno type="docket"|"ECLI"|"CELEX">` (extending the existing `idno` type list)
- `<title level="m" type="legislation" key="...">` / `<title level="a" type="caseName">`
- `<date type="decision"|"enacted">`

This design fixes the two bugs above and adds the full legal-citation
tagset as annotation presets, so annotators can label these constructs in
the visual editor.

## Goals

- Make `<bibl>` clickable/retaggable in `grobid.training.references`.
- Make same-tag presets (title levels, bibl types, and the new ones)
  actually work when clicked in the "Change to" palette.
- Add annotation presets for the full legal-citation tagset from the spec.

## Non-goals

- Changes to the TEI/RelaxNG validation schema used for document validation
  (`schema/rng/`, `data/schema/cache/`) — unrelated to this GROBID
  training-annotation tag config.
- Changes to GROBID model training/inference itself.
- A generic `ELEMENT[VALUE]` parsing convention. Presets remain individually
  authored dict entries, matching the existing style (no new abstraction
  introduced).

## Design

### 1. Config additions — `fastapi_app/plugins/grobid/config/annotation_tags.py`

**`grobid.training.references`** (the variant shown in the reported screenshot):

| Preset | tag | defaultAttributes | attributes (in-popup dropdown/input) |
|---|---|---|---|
| `bibl` | bibl | *(none)* | — |
| `bibl[footnote]` | bibl | `{type: footnote}` | — |
| `bibl[decision]` | bibl | `{type: decision}` | — |
| `bibl[legislation]` | bibl | `{type: legislation}` | — |
| `title[legislation]` | title | `{level: m, type: legislation}` | `key` (free text, e.g. `key="UrhG"`) |
| `title[caseName]` | title | `{level: a, type: caseName}` | — |
| `date[decision]` | date | `{type: decision}` | — |
| `date[enacted]` | date | `{type: enacted}` | — |
| `orgName[court]` | orgName | `{type: court}` | — |
| `citedRange[section]` | citedRange | `{unit: section}` | `unit` (all 8 values) |
| `citedRange[sub-section]` | citedRange | `{unit: sub-section}` | `unit` (all 8 values) |
| `citedRange[sentence]` | citedRange | `{unit: sentence}` | `unit` (all 8 values) |
| `citedRange[number]` | citedRange | `{unit: number}` | `unit` (all 8 values) |
| `citedRange[letter]` | citedRange | `{unit: letter}` | `unit` (all 8 values) |
| `citedRange[margin]` | citedRange | `{unit: margin}` | `unit` (all 8 values) |
| `citedRange[recital]` | citedRange | `{unit: recital}` | `unit` (all 8 values) |
| `citedRange[page]` | citedRange | `{unit: page}` | `unit` (all 8 values) |

Plus: extend the existing `idno` entry's `attributes[0].values` from
`["DOI", "arXiv", "report"]` to also include `"docket"`, `"ECLI"`, `"CELEX"`
(reuses the existing in-popup dropdown rather than adding new chips, per
prior agreement — docket/ECLI/CELEX are picked after wrapping as plain
`idno`, same as DOI/arXiv/report today).

Each `citedRange[*]` entry carries the full `attributes: [{"name": "unit",
"values": [...]}]` list (all 8 values), matching the existing convention
used by `title[a/j/m/s]` and `biblScope`'s volume/issue/pages presets.

**`childTags` requirement:** once `bibl` becomes a clickable tag in this
variant, it also becomes an "enclosing annotation" candidate for the
split-vs-wrap logic in `xml-annotation.js#wrapSelectionWith`. Without
listing its children, selecting text inside a `<bibl>` and annotating it
would incorrectly try to *split* the bibl. All four `bibl` presets in this
variant must declare:

```
"childTags": ["author", "title", "date", "biblScope", "publisher", "edition",
              "orgName", "pubPlace", "editor", "ptr", "idno", "note", "citedRange"]
```

(every content tag used as a direct child annotation in this variant, plus
the newly added `citedRange`).

**`grobid.training.references.referenceSegmenter`**: add `bibl[decision]`
and `bibl[legislation]` alongside the existing `bibl`/`bibl[footnote]`,
same `childTags: ["label"]` as those two.

### 2. Popup fix — `app/src/modules/codemirror/xml-annotation-popup.js`

- `#show(coords, def, element)`: pass the matched `def` object itself
  (not just `def.tag`) through to `#renderPalette` and to the retag
  callback.
- `#renderPalette(container, currentDef, onChipClick)`: change the
  "current" check from `def.tag === currentTag` (string) to
  `def === currentDef` (object identity). This is safe because both the
  palette's defs and the matched current def are drawn from the same
  `#tagDefs` array reference — no deep comparison needed.
- `#retag(element, currentDef, newDef)`: replace the
  `if (element.localName === newDef.tag) return` guard with a check that
  also compares `defaultAttributes` (only true no-ops are skipped). Then:
  1. If `newDef.tag !== element.localName`, create a new element as today
     (copy existing attributes, replace in parent).
  2. Remove any attribute key present in `currentDef.defaultAttributes` but
     absent from `newDef.defaultAttributes` (e.g. switching
     `bibl[decision]` → plain `bibl` must remove `type`).
  3. Apply `newDef.defaultAttributes` on top.

This generalizes correctly for every existing and new multi-preset tag
(`title[a/j/m/s/legislation/caseName]`, `bibl[*]`, `citedRange[*]`,
`orgName[collaboration/court]`) without per-tag special-casing.

**Known limitation, accepted:** attributes outside `defaultAttributes` that
a user added via the in-popup attribute editor (e.g. a `key="UrhG"` typed
into `title[legislation]`) are not cleared when switching to a preset that
doesn't use them (e.g. `title[caseName]`). This matches the scope of the
fix (diff only what the presets declare) and avoids building a more
elaborate attribute-ownership tracking system. Users can remove such
attributes manually if needed.

## Testing

- `fastapi_app/plugins/grobid/tests/test_annotation_config.py`: extend with
  assertions for the new entries — presence, `defaultAttributes` shape, and
  that `childTags` on the `references`-variant `bibl` presets includes every
  other tag used in that variant (a structural check, not just individual
  spot-checks, so future additions to the variant don't silently break the
  split-vs-wrap behavior).
- `tests/unit/js/xml-annotation-popup.test.js`: it already has a
  `tagDefsWithDuplicates` fixture (`bibl` / `bibl[footnote]`) anticipating
  this exact scenario, currently only exercised for title-resolution.
  Add cases (using `#renderPalette`/`#retag` reached via the public
  `ann-badge-click` + chip-click path, consistent with the file's existing
  approach of testing through the public event surface) covering:
  - clicking the *other* same-tag preset actually retags (previously a
    no-op)
  - the previously-active preset's attribute is removed when the new
    preset doesn't share it (e.g. `bibl[decision]` → `bibl` clears `type`)
  - a genuine no-op (same tag, same `defaultAttributes`) still does
    nothing (no spurious `updateEditorFromNode` call)

## Out of scope / follow-ups

- No changes to the document-validation RelaxNG/XSD schema paths — this is
  purely the GROBID training-annotation tag config and its editor popup.
- Colors for new entries follow the existing Catppuccin-ish palette already
  used in the file loosely (exact hex values aren't specified here; picked
  during implementation, existing file already reuses colors across
  distinct labels within a variant, e.g. `title[j]` and `URL` both use
  `#74c7ec`).

# Annotation Tag Configuration — Design Spec

**Date:** 2026-06-17
**Status:** Draft
**Parent spec:** [docs/superpowers/specs/2026-06-16-xml-annotation-design.md](2026-06-16-xml-annotation-design.md)
**Branch:** `feat-visual-annotations`

## Overview

This spec covers everything needed to make the visual annotation mode actually usable:

1. Tag definitions for three GROBID variants (`segmentation`, `referenceSegmenter`, `references`)
2. Extended `AnnotationTagDef` model: `description` (tooltip), `priority` (menu order), `defaultAttributes` (attributes baked into the wrapped tag)
3. Extended `ExtractorInfo` model: `annotationTags` changed from flat list to per-variant dict; new `annotationTagsCutoff` dict for menu split
4. Priority-based context menu: top-N items at the top level, the rest in a "More…" submenu — both counts and ordering are configurable per variant
5. Context menu rebuild fix: currently tag items are created at startup when `#tagDefs` is empty; this spec redesigns the flow so items are built dynamically each time the menu opens
6. Correct wrapping for tags with mandatory default attributes (e.g. `<div type="acknowledgement">`)
7. Statusbar switch: change from `disabled` to `hidden` when no tags are defined; lower priority from 90 → 3

---

## Known Bug: Context Menu Tag Items Are Never Shown

**Root cause.** `XmlAnnotationPlugin.#contextMenuItems()` is the extension point handler called by `XmlEditorPlugin.start()`. At that point `this.#tagDefs` is always empty, so the `for (const def of this.#tagDefs)` loop creates zero items. `#updateTagDefs()` later populates `this.#tagDefs` but never re-adds menu items. This is a pre-existing bug introduced with the initial implementation.

**Fix: sentinel + rebuild on `onBeforeShow`.**

`#contextMenuItems()` contributes three things to the context menu:

1. The annotation divider (existing)
2. The "Remove annotation" item (existing)
3. A new hidden sentinel `<sl-divider>` with an `onBeforeShow` callback that calls `#rebuildTagMenuItems()`

`#rebuildTagMenuItems()` is called each time the context menu opens. It:

- Removes all items in `this.#menuTagItems` from the parent `<sl-menu>` via `item.remove()`
- Clears `this.#menuTagItems`
- If annotation mode is OFF or `#tagDefs` is empty, returns immediately
- Sorts `#tagDefs` by `priority` ascending (lower = shown first)
- Splits at `#topLevelCount`:
  - First N items → created as top-level `<sl-menu-item>` elements, inserted before the sentinel
  - Remaining items → placed inside a Shoelace submenu (see below)
- Stores all created items in `this.#menuTagItems` for removal next call

This requires NO changes to `XmlEditorContextMenu` or `XmlEditorPlugin`. The sentinel's `parentElement` is the `<sl-menu>`, accessible from `this.#menuSentinel.parentElement`.

---

## Data Model Changes

### `AnnotationTagDef` — new fields

```python
class AnnotationTagDef(BaseModel):
    tag: str
    label: str
    labelMap: dict[str, str] | None = None
    color: str
    attributes: list[AnnotationTagAttribute] = []
    # NEW:
    description: str | None = Field(None, description="Tooltip text for the context menu item")
    priority: int = Field(100, description="Sort order; lower = shown first in the menu")
    defaultAttributes: dict[str, str] | None = Field(
        None,
        description="Attribute key/value pairs baked into the opening tag when wrapping a selection"
    )
```

### `ExtractorInfo` — changed field `annotationTags`

**Before:** `annotationTags: List[AnnotationTagDef] = Field(default_factory=list)`

**After:** `annotationTags: Dict[str, List[AnnotationTagDef]] = Field(default_factory=dict)`

This is safe: the field currently defaults to `[]`, which becomes `{}`. No extractor populates it yet.

Rationale: The grobid extractor supports 12+ variants. Different variants have completely different tag sets. A flat list cannot distinguish between them. A dict keyed by `variant_id` lets the frontend do a direct lookup.

### `ExtractorInfo` — new field `annotationTagsCutoff`

```python
annotationTagsCutoff: Dict[str, int] = Field(
    default_factory=dict,
    description="Per-variant count of top-level menu items; tags beyond this go in 'More...' submenu"
)
```

Example: `{"grobid.training.references": 6, "grobid.training.segmentation": 6}` means the 6 highest-priority tags for each variant appear at the top level; the rest go in the submenu. If a variant is absent from this dict, all tags are shown at the top level.

---

## Tag Wrapping With Default Attributes

`#wrapSelectionWith(def)` in `xml-annotation.js` currently generates `<${def.tag}>${selectedText}</${def.tag}>`. Change to:

```js
const attrStr = def.defaultAttributes
  ? ' ' + Object.entries(def.defaultAttributes).map(([k, v]) => `${k}="${v}"`).join(' ')
  : ''
const wrapped = `<${def.tag}${attrStr}>${selectedText}</${def.tag}>`
```

This enables tags like `<div type="acknowledgement">` to wrap correctly. Without this, all `div` entries would produce identical bare `<div>` elements.

---

## Frontend Changes Summary

### Files to modify

- `app/src/plugins/xml-annotation.js` — primary file

### JSDoc typedef update

```js
/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null,
 *   color: string, attributes: Array<{name:string, values?: string[]|null}>,
 *   description?: string|null, priority?: number,
 *   defaultAttributes?: Record<string,string>|null }} AnnotationTagDef
 */
```

### New plugin fields

```js
/** @type {HTMLElement|null} */
#menuSentinel = null;

/** @type {number|null} */
#topLevelCount = null;
```

### Updated `#contextMenuItems()` — remove tag item loop

The method no longer iterates `#tagDefs`. It returns:

```js
[
  { element: divider, onBeforeShow: () => { divider.hidden = !this.#annotationMode } },
  { element: removeItem, onBeforeShow: () => { /* existing logic */ } },
  { element: sentinel, onBeforeShow: () => this.#rebuildTagMenuItems() }
]
```

Where `sentinel` is a hidden `<sl-divider>` stored in `this.#menuSentinel`.

### New `#rebuildTagMenuItems()`

```js
#rebuildTagMenuItems() {
  const menu = this.#menuSentinel?.parentElement
  if (!menu) return
  for (const item of this.#menuTagItems) item.remove()
  this.#menuTagItems = []
  if (!this.#annotationMode || this.#tagDefs.length === 0) return
  const sorted = [...this.#tagDefs].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
  const cutoff = this.#topLevelCount
  const topDefs = cutoff != null ? sorted.slice(0, cutoff) : sorted
  const moreDefs = cutoff != null ? sorted.slice(cutoff) : []
  const view = this.#xmlEditor.getView?.()
  const { from, to } = view?.state.selection.main ?? { from: 0, to: 0 }
  const hasSelection = from !== to && !!this.#xmlEditor.isSynced?.()
  for (const def of topDefs) {
    const item = this.#createTagItem(def, hasSelection)
    menu.insertBefore(item, this.#menuSentinel)
    this.#menuTagItems.push(item)
  }
  if (moreDefs.length > 0) {
    const submenu = this.#createTagSubmenu(moreDefs, hasSelection)
    menu.insertBefore(submenu, this.#menuSentinel)
    this.#menuTagItems.push(submenu)
  }
}
```

### New `#createTagItem(def, hasSelection)`

```js
#createTagItem(def, hasSelection) {
  const item = document.createElement('sl-menu-item')
  item.textContent = def.label.replace(/\{@[^}]+\}/g, '…')
  item.dataset.tag = def.tag
  item.disabled = !hasSelection
  if (def.description) item.title = def.description
  item.addEventListener('click', () => this.#wrapSelectionWith(def))
  return item
}
```

Note: `item.title` is the native HTML tooltip attribute. It works on Shoelace menu items. A Shoelace `<sl-tooltip>` wrapper is a future enhancement (TODO).

### New `#createTagSubmenu(defs, hasSelection)`

Shoelace submenus use `slot="submenu"` inside an `<sl-menu-item>`:

```js
#createTagSubmenu(defs, hasSelection) {
  const wrapper = document.createElement('sl-menu-item')
  wrapper.textContent = 'More…'
  const inner = document.createElement('sl-menu')
  inner.slot = 'submenu'
  for (const def of defs) inner.appendChild(this.#createTagItem(def, hasSelection))
  wrapper.appendChild(inner)
  return wrapper
}
```

### Updated `#updateTagDefs(state)` — fix field name and dict access

Current code (broken):

```js
const tags = /** @type {any} */ (ext).annotation_tags  // WRONG: snake_case doesn't match JSON
if (Array.isArray(tags)) newDefs.push(...tags)
```

Fixed:

```js
const variantTags = /** @type {any} */ (ext).annotationTags?.[variant]
if (Array.isArray(variantTags)) newDefs.push(...variantTags)
const cutoff = /** @type {any} */ (ext).annotationTagsCutoff?.[variant]
if (cutoff != null) this.#topLevelCount = cutoff
```

Also reset `this.#topLevelCount = null` at the start of `#updateTagDefs` before iterating extractors.

### Switch visibility

Change `disabled` to `hidden` so the statusbar is not cluttered when annotation mode is unavailable:

```js
// In install():
this.#xmlEditor.addStatusbarWidget(this.#switch, 'left', 3)  // was 90

// In #updateTagDefs():
this.#switch.hidden = !hasTagDefs   // was: this.#switch.disabled = !hasTagDefs
```

---

## Backend Changes

### `fastapi_app/lib/models/models_extraction.py`

Three changes:

1. Add fields to `AnnotationTagDef` (see Data Model section above)
2. Change `annotationTags` field type from `List[AnnotationTagDef]` to `Dict[str, List[AnnotationTagDef]]`
3. Add `annotationTagsCutoff: Dict[str, int]` field to `ExtractorInfo`

### `fastapi_app/plugins/grobid/config.py`

Add at the bottom of the config constants:

```python
ANNOTATION_TAGS_CUTOFF: dict[str, int] = {
    "grobid.training.segmentation": 6,
    "grobid.training.references.referenceSegmenter": 3,
    "grobid.training.references": 6,
}

ANNOTATION_TAGS: dict[str, list[dict]] = {
    "grobid.training.segmentation": [
        {"tag": "body", "label": "body", "color": "#89dceb", "priority": 1, "defaultAttributes": None, "description": "The main body of the document", "attributes": []},
        {"tag": "listBibl", "label": "listBibl", "color": "#f38ba8", "priority": 2, "defaultAttributes": None, "description": "Bibliographical section", "attributes": []},
        {"tag": "front", "label": "front", "color": "#89b4fa", "priority": 3, "defaultAttributes": None, "description": "Document header / front matter", "attributes": []},
        {"tag": "titlePage", "label": "titlePage", "color": "#cba6f7", "priority": 4, "defaultAttributes": None, "description": "Cover page", "attributes": []},
        {"tag": "note", "label": "note[footnote]", "color": "#94e2d5", "priority": 5, "defaultAttributes": {"place": "footnote"}, "description": "Page footer or numbered footnote", "attributes": []},
        {"tag": "page", "label": "page", "color": "#f9e2af", "priority": 6, "defaultAttributes": None, "description": "Page number indicator", "attributes": []},
        {"tag": "div", "label": "acknowledgement", "color": "#a6e3a1", "priority": 7, "defaultAttributes": {"type": "acknowledgement"}, "description": "Acknowledgement statement in the annex", "attributes": []},
        {"tag": "div", "label": "toc", "color": "#f5c2e7", "priority": 8, "defaultAttributes": {"type": "toc"}, "description": "Table of contents", "attributes": []},
        {"tag": "note", "label": "note[headnote]", "color": "#74c7ec", "priority": 9, "defaultAttributes": {"place": "headnote"}, "description": "Page header / running head", "attributes": []},
        {"tag": "div", "label": "annex", "color": "#585b70", "priority": 10, "defaultAttributes": {"type": "annex"}, "description": "Any other annex section", "attributes": []},
        {"tag": "div", "label": "funding", "color": "#f2cdcd", "priority": 11, "defaultAttributes": {"type": "funding"}, "description": "Funding information annex", "attributes": []},
        {"tag": "div", "label": "conflict", "color": "#eba0ac", "priority": 12, "defaultAttributes": {"type": "conflict"}, "description": "Conflict of interest statement", "attributes": []},
        {"tag": "div", "label": "contribution", "color": "#b4befe", "priority": 13, "defaultAttributes": {"type": "contribution"}, "description": "Author contribution statement", "attributes": []},
        {"tag": "div", "label": "availability", "color": "#45475a", "priority": 14, "defaultAttributes": {"type": "availability"}, "description": "Data/code availability statement", "attributes": []},
    ],
    "grobid.training.references.referenceSegmenter": [
        {"tag": "bibl", "label": "bibl", "color": "#89dceb", "priority": 1, "defaultAttributes": None, "description": "An individual bibliographic reference", "attributes": []},
        {"tag": "bibl", "label": "bibl[footnote]", "color": "#94e2d5", "priority": 2, "defaultAttributes": {"type": "footnote"}, "description": "A note or comment that is not a bibliographic reference", "attributes": []},
        {"tag": "label", "label": "label", "color": "#a6e3a1", "priority": 3, "defaultAttributes": None, "description": "Reference number or footnote marker (e.g. [1], ¹)", "attributes": []},
    ],
    "grobid.training.references": [
        {"tag": "author", "label": "author", "color": "#89b4fa", "priority": 1, "defaultAttributes": None, "description": "Complete sequence of author names", "attributes": []},
        {"tag": "title", "label": "title[a]", "color": "#a6e3a1", "priority": 2, "defaultAttributes": {"level": "a"}, "description": "Article or chapter title (analytics)", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "title", "label": "title[j]", "color": "#74c7ec", "priority": 3, "defaultAttributes": {"level": "j"}, "description": "Journal title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "date", "label": "date", "color": "#fab387", "priority": 4, "defaultAttributes": None, "description": "Publication date sequence", "attributes": []},
        {"tag": "biblScope", "label": "pages", "color": "#f9e2af", "priority": 5, "defaultAttributes": {"unit": "page"}, "description": "Full page range of the article", "attributes": []},
        {"tag": "title", "label": "title[m]", "color": "#94e2d5", "priority": 6, "defaultAttributes": {"level": "m"}, "description": "Monograph, proceedings, book, or thesis title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "publisher", "label": "publisher", "color": "#cba6f7", "priority": 7, "defaultAttributes": None, "description": "Publisher name; also used for corporate authors such as web pages", "attributes": []},
        {"tag": "biblScope", "label": "volume", "color": "#f5c2e7", "priority": 8, "defaultAttributes": {"unit": "volume"}, "description": "Volume number", "attributes": []},
        {"tag": "biblScope", "label": "issue", "color": "#eba0ac", "priority": 9, "defaultAttributes": {"unit": "issue"}, "description": "Issue / number", "attributes": []},
        {"tag": "orgName", "label": "orgName", "color": "#f38ba8", "priority": 10, "defaultAttributes": None, "description": "Institution for theses or technical reports", "attributes": []},
        {"tag": "pubPlace", "label": "pubPlace", "color": "#89dceb", "priority": 11, "defaultAttributes": None, "description": "Publication place or location of publishing institution", "attributes": []},
        {"tag": "editor", "label": "editor", "color": "#b4befe", "priority": 12, "defaultAttributes": None, "description": "Sequence of editor names", "attributes": []},
        {"tag": "ptr", "label": "URL", "color": "#74c7ec", "priority": 13, "defaultAttributes": {"type": "web"}, "description": "Web URL (exclude prefixes like 'URL:' and trailing periods)", "attributes": []},
        {"tag": "idno", "label": "idno", "color": "#45475a", "priority": 14, "defaultAttributes": None, "description": "Document identifier (DOI, arXiv, etc.)", "attributes": [{"name": "type", "values": ["DOI", "arXiv", "report"]}]},
        {"tag": "note", "label": "note", "color": "#9399b2", "priority": 15, "defaultAttributes": None, "description": "Any note not covered by another tag", "attributes": []},
        {"tag": "title", "label": "title[s]", "color": "#b4befe", "priority": 16, "defaultAttributes": {"level": "s"}, "description": "Series title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "orgName", "label": "collaboration", "color": "#f2cdcd", "priority": 17, "defaultAttributes": {"type": "collaboration"}, "description": "Project-based collaboration acting as an author group", "attributes": []},
        {"tag": "note", "label": "note[report]", "color": "#585b70", "priority": 18, "defaultAttributes": {"type": "report"}, "description": "Type of report or thesis (e.g. 'Ph.D. thesis', 'Technical Report')", "attributes": []},
    ],
}


def get_annotation_tags() -> dict[str, list[dict]]:
    """Return annotation tag definitions keyed by variant_id."""
    import copy
    return copy.deepcopy(ANNOTATION_TAGS)


def get_annotation_tags_cutoff() -> dict[str, int]:
    """Return per-variant top-level menu item counts."""
    return ANNOTATION_TAGS_CUTOFF.copy()
```

### `fastapi_app/plugins/grobid/extractor.py`

In the import block, add:

```python
from fastapi_app.plugins.grobid.config import (
    get_annotation_guides,
    get_annotation_tags,        # NEW
    get_annotation_tags_cutoff, # NEW
    get_form_options,
    ...
)
```

In `get_info()`:

```python
@classmethod
def get_info(cls) -> Dict[str, Any]:
    return {
        "id": "grobid",
        "name": "GROBID Extraction",
        "description": "Extract TEI from PDF using remote GROBID server (training data or full documents)",
        "input": ["pdf"],
        "output": ["tei-document"],
        "variants": get_supported_variants(),
        "options": get_form_options(),
        "navigation_xpath": get_navigation_xpath(),
        "annotationGuides": get_annotation_guides(),
        "annotationTags": get_annotation_tags(),         # NEW
        "annotationTagsCutoff": get_annotation_tags_cutoff(),  # NEW
    }
```

---

## Edge Cases

| Situation | Behavior |
| --- | --- |
| Variant has no annotation tags | Switch is `hidden`; no tag items in context menu |
| `topLevelCount` ≥ total tags for variant | All tags shown at top level; no "More…" item |
| `topLevelCount` is null (variant absent from cutoff dict) | All tags at top level |
| Annotation mode OFF when menu opens | `#rebuildTagMenuItems()` returns after clearing old items |
| Variant changes while annotation mode is ON | `#updateTagDefs()` updates `#tagDefs` + `#topLevelCount`; next menu open rebuilds items |
| `description` is None / null | `item.title` not set; no tooltip shown |
| `defaultAttributes` is None | Tag wrapped as bare element `<tag>…</tag>` |
| Same tag appears multiple times (e.g. `title` with different levels) | Each entry is a separate `AnnotationTagDef` with its own `defaultAttributes`; they sort independently by priority |

---

## File Change Checklist

```text
fastapi_app/lib/models/models_extraction.py
  - Add description, priority, defaultAttributes to AnnotationTagDef
  - Change annotationTags: List → Dict[str, List]
  - Add annotationTagsCutoff: Dict[str, int] to ExtractorInfo

fastapi_app/plugins/grobid/config.py
  - Add ANNOTATION_TAGS dict (3 variants, full tag list)
  - Add ANNOTATION_TAGS_CUTOFF dict
  - Add get_annotation_tags() function
  - Add get_annotation_tags_cutoff() function

fastapi_app/plugins/grobid/extractor.py
  - Import get_annotation_tags, get_annotation_tags_cutoff
  - Add annotationTags and annotationTagsCutoff to get_info() return dict

app/src/plugins/xml-annotation.js
  - Update AnnotationTagDef typedef (add description, priority, defaultAttributes)
  - Add #menuSentinel and #topLevelCount fields
  - Update #contextMenuItems(): remove tag item loop; add sentinel with onBeforeShow
  - Add #rebuildTagMenuItems()
  - Add #createTagItem(def, hasSelection)
  - Add #createTagSubmenu(defs, hasSelection)
  - Fix #updateTagDefs(): annotation_tags → annotationTags?.[variant], dict access, reset #topLevelCount
  - Update #wrapSelectionWith(): include defaultAttributes in generated opening tag
  - Change switch: disabled → hidden, priority 90 → 3
```

---

## Out of Scope

- Shoelace `sl-tooltip` wrapper on menu items (native `title` attribute is sufficient for now)
- Per-user priority customisation (priorities are defined in backend config)
- Live reload of tag definitions without page refresh
- The `attributes` field on tag defs (drives the popup) — already implemented in the parent spec; this spec only adds the tag data, not new popup logic

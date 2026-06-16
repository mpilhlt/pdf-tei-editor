# XML Annotation Mode — Design Spec

**Date:** 2026-06-16
**Status:** Approved

## Overview

A new `xml-annotation` plugin adds a visual annotation mode to the XML editor. In annotation mode the raw XML markup is hidden and replaced by coloured inline markers; users annotate text by selecting it and picking a tag from the context menu. Switching between XML and annotation view is controlled by a toggle in the editor statusbar.

---

## Architecture

### New plugin

**File:** `app/src/plugins/xml-annotation.js`

**Dependencies:** `xmleditor`, `extraction`, `logger`

No changes to plugin registration order are required — the `deps` array ensures correct startup sequencing.

### Supporting modules

```text
app/src/modules/codemirror/
  xml-annotation-decorations.js   — CM StateField + DecorationSet + badge widgets
  xml-annotation-popup.js         — attribute-editing popup DOM
app/src/templates/
  xml-annotation-statusbar.html   — footer switch widget
```

### Extension mechanism

The annotation plugin uses **Approach B — `createExtensionSlot()`**: a new method on `XMLEditor` that creates a named CodeMirror `Compartment` slot and returns a `reconfigure()` handle. This is the only change required to the existing XMLEditor infrastructure.

No new extension point is needed. The annotation plugin accesses XMLEditor via `getDependency('xmleditor')` and calls `createExtensionSlot()` during its own `install()`.

---

## XMLEditor Changes

### `XMLEditor` class (`app/src/modules/xmleditor.js`)

One new public method (no new fields needed):

```js
createExtensionSlot(initial = []) {
  const compartment = new Compartment()
  // EditorView is created in the XMLEditor constructor, so it always exists
  // by the time any dependent plugin's install() runs. StateEffect.appendConfig
  // is the CM6 mechanism for adding extensions to a live EditorState.
  this.#view.dispatch({
    effects: StateEffect.appendConfig.of(compartment.of(initial))
  })
  return {
    reconfigure: (ext) => this.#view.dispatch({ effects: compartment.reconfigure(ext) })
  }
}
```

`StateEffect` is already imported from `@codemirror/state`. No changes to `EditorState.create` are needed. The `EditorView` is always live when `createExtensionSlot()` is called because `XMLEditor` creates it in its constructor — before the plugin framework calls any `install()` method.

### `XmlEditorPlugin` (`app/src/plugins/xmleditor.js`)

`createExtensionSlot` is added to the `pluginMethods` set in `getApi()` so it is accessible via `getDependency('xmleditor').createExtensionSlot(...)`.

---

## Variant Config Schema

Annotation tag definitions are returned by the backend variant plugin as part of the existing extractor metadata fetched by the `extraction` plugin. A new `annotationTags` key is added to the extractor info object alongside the existing `annotationGuides`.

### Example

```json
{
  "variant_id": "tei-references",
  "annotationTags": [
    {
      "tag": "bibl",
      "label": "BIBL",
      "color": "#89dceb",
      "attributes": [
        { "name": "type", "values": ["primary", "secondary"] }
      ]
    },
    {
      "tag": "title",
      "label": "TITLE[{@level}]",
      "labelMap": { "level=m": "TITLE[M]", "level=a": "TITLE[A]", "level=j": "TITLE[J]" },
      "color": "#a6e3a1",
      "attributes": [
        { "name": "level", "values": ["m", "a", "j", "s"] }
      ]
    },
    {
      "tag": "author",
      "label": "AUTHOR",
      "color": "#89b4fa",
      "attributes": []
    },
    {
      "tag": "date",
      "label": "DATE[{@when}]",
      "color": "#fab387",
      "attributes": [
        { "name": "when" }
      ]
    }
  ]
}
```

### Label resolution

Given an element, the resolved badge label is determined as follows:

1. Check all `key=value` entries in `labelMap` against the element's attributes. First match wins — use the mapped label.
2. If no `labelMap` match, interpolate the `label` template: replace `{@attrName}` with the attribute value. If the attribute is absent, omit the `{@attrName}` placeholder including any surrounding brackets (e.g. `TITLE[{@level}]` with no `level` attribute → `TITLE`).
3. If `label` contains no `{@...}` template tokens, use it as-is.

### `attributes` array

Drives the properties popup:

- `name` — XML attribute name
- `values` (optional) — if present the popup shows a `<sl-select>`; if absent a free-text `<sl-input>`

### Python models (backend)

Added to the extractor base class:

```python
class AnnotationTagAttribute(BaseModel):
    name: str
    values: list[str] | None = None

class AnnotationTagDef(BaseModel):
    tag: str
    label: str
    labelMap: dict[str, str] | None = None
    color: str
    attributes: list[AnnotationTagAttribute] = []
```

`ExtractorInfo` gains `annotation_tags: list[AnnotationTagDef] = []`.

---

## CodeMirror Decoration Layer

**File:** `app/src/modules/codemirror/xml-annotation-decorations.js`

### Design

A **StateField** holds a `DecorationSet` and recomputes it from the Lezer syntax tree whenever the document changes.

| Syntax node | Decoration |
| --- | --- |
| `OpenTag` of annotation element | `Decoration.replace` → badge widget |
| `CloseTag` of annotation element | `Decoration.replace` → zero-width invisible widget |
| Outer annotation element content | `Decoration.mark` with class `ann-outer` and `--ann-color` CSS var → background tint (C2 style) |
| Inner (nested) annotation element content | `Decoration.mark` with class `ann-inner` → coloured underline, no tint |
| Structural tags (`<p>`, `<lb/>`, etc.) | Left as-is. **TODO:** replace with icons in a future iteration. |

Nesting depth is tracked during tree traversal: depth ≥ 2 receives the `ann-inner` mark class.

### Badge widget

```html
<span class="ann-badge" style="--ann-color: #89dceb" data-tag="bibl">BIBL</span>
```

Clicking a badge dispatches a custom DOM event `ann-badge-click` with `{ tag, from, to, element }`, caught by the popup manager. `element` is the **XML DOM element** (`Element`) corresponding to the annotation — obtained via `xmlEditorApi.getDomNodeAt(from)` at event-dispatch time.

### Factory function

The StateField is exported as a factory so the annotation plugin passes current tag definitions at creation time:

```js
export function createAnnotationField(tagDefs) {
  return StateField.define({
    create: (state) => buildDecorations(state, tagDefs),
    update: (decs, tr) => tr.docChanged ? buildDecorations(tr.state, tagDefs) : decs,
    provide: f => EditorView.decorations.from(f)
  })
}
```

### Slot usage

```js
// During install():
this.#slot = xmlEditorApi.createExtensionSlot([])

// Toggle ON:
this.#slot.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme])

// Toggle OFF:
this.#slot.reconfigure([])
```

---

## Annotation Mode Toggle

### UI

The annotation plugin adds a `StatusSwitch` to the xmleditor statusbar via `xmlEditorApi.addStatusbarWidget()`. Toggle state is persisted via `this.uiStorage.bind(switchEl, 'annotationMode', false)`.

The switch is **disabled** (with a tooltip "No annotation tags defined for this variant") when the current variant provides no `annotationTags`.

### Toggle ON sequence

1. Verify `xmlEditorApi.getXmlTree()` is synced — abort with `notify` warning if not
2. Locate the `<text>` element in the XML DOM — abort with `notify` warning if absent
3. `this.#slot.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme])`
4. `xmlEditorApi.setReadOnlyContext('annotation-mode', true)`
5. Hide the xmleditor headerbar (`ui.xmlEditor.headerbar.hidden = true`)
6. Scroll CM view to the `<text>` element start position

### Toggle OFF sequence

1. `this.#slot.reconfigure([])`
2. `xmlEditorApi.setReadOnlyContext('annotation-mode', false)`
3. Restore headerbar (`ui.xmlEditor.headerbar.hidden = false`)

---

## Context Menu Integration

### Annotation items

The annotation plugin implements `ep.xmlEditor.contextMenuItems` and returns:

- One `<sl-divider>` (hidden when not in annotation mode)
- One `<sl-menu-item>` per tag definition (hidden when not in annotation mode)

Items are **top-level** — no submenu. Visibility (`element.hidden`) and disabled state are managed in the `onBeforeShow` callback registered via `addItem(..., { onBeforeShow })`:

- Hidden when annotation mode is OFF
- Disabled when no text is selected or the XML tree is not synced

### Wrapping a selection

On tag item click:

1. Get CM selection range `{ from, to }`
2. Find the deepest common ancestor of the text nodes at those positions via `getDomNodeAt(from)` and `getDomNodeAt(to)`
3. Build replacement string: `<tagName>selectedText</tagName>`
4. Dispatch a CM `changes` transaction replacing `[from, to]` with the wrapped XML
5. Call `xmlEditorApi.updateEditorFromNode(commonAncestor)` to re-sync the DOM

### Removing an annotation

A "Remove annotation" `<sl-menu-item>` is added (also top-level, hidden in XML mode). In `onBeforeShow`: enabled only when the click position lands inside a known annotation element (checked via `getDomNodeAt(clickPos)` + tag name lookup against `#tagDefs`). On click: unwraps the element and re-syncs.

---

## Properties Popup

**File:** `app/src/modules/codemirror/xml-annotation-popup.js`

Triggered by the `ann-badge-click` DOM event.

### Structure

A small absolutely-positioned `<div>` (pattern matches `XmlEditorContextMenu`):

- **Title:** resolved badge label (e.g. `TITLE[M]`)
- **Attribute rows:** one row per entry in `AnnotationTagDef.attributes`
  - `values` present → `<sl-select>` pre-filled with current attribute value
  - `values` absent → `<sl-input>` free text pre-filled with current attribute value
- **"Remove annotation" link** at the bottom

### Behaviour

- **Attribute change:** immediately calls `element.setAttribute(name, value)` on the XML DOM node, then `xmlEditorApi.updateEditorFromNode(element.parentNode)` to re-sync and rebuild decorations
- **Remove:** unwraps the element, re-syncs
- **Dismiss:** outside click or Escape (same pattern as context menu)

---

## State Management & Data Flow

### App state

No new keys in `ApplicationState`. Annotation mode is a UI preference persisted via `uiStorage`.

### Tag definitions lifecycle

```
onStateUpdate (variant or extractor change)
  → fetch tag defs via extraction.extractorInfo() or client.getExtractorList()
  → store in this.#tagDefs
  → if annotation mode ON: this.#slot.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme])
  → if new variant has no annotationTags and mode is ON: toggle OFF, disable switch
```

### Document load lifecycle

On `XMLEditor.EVENT_EDITOR_AFTER_LOAD`:
- If annotation mode is ON: rebuild decorations, scroll to `<text>` element start
- If new document's variant has no `annotationTags`: toggle OFF

On document cleared (`state.xml` → null): toggle OFF.

---

## Edge Cases

| Situation | Behaviour |
| --- | --- |
| XML not well-formed when toggling ON | `notify` warning, abort toggle, switch stays OFF |
| No `<text>` element found | `notify` warning, abort toggle, switch stays OFF |
| Variant has no `annotationTags` | Switch disabled with tooltip |
| New document loaded while annotation mode is ON | Rebuild decorations from new content on `EVENT_EDITOR_AFTER_LOAD`; scroll to new `<text>` start. Toggle OFF if new variant has no `annotationTags` |
| Document already read-only (gold file, etc.) | Annotation mode activates normally; wrapping/unwrapping is blocked by existing read-only guards |
| Unsaved draft when toggling | No special handling — mode operates on current CM content regardless of save state |

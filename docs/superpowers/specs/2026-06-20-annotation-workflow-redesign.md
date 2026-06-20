# Annotation Workflow Redesign

**Date:** 2026-06-20
**Status:** Approved

## Goal

Replace the right-click context menu as the primary annotation entry point with a mouseup-triggered popup, and add retagging to the existing badge-click popup. Remove all annotation contributions from the context menu.

## Approach

Extend `XmlAnnotationPopup` to handle two show modes (wrap-on-select, retag-on-badge-click), hook `mouseup` via `EditorView.domEventHandlers` inside the CM compartment slot, and strip all context menu plumbing from `XmlAnnotationPlugin`.

## Section 1 — Trigger & Lifecycle

All context menu contributions are removed from `XmlAnnotationPlugin`:

- Remove `static extensionPoints = [ep.xmlEditor.contextMenuItems]`
- Remove `[ep.xmlEditor.contextMenuItems]()` handler
- Remove `#contextMenuItems()`, `#rebuildPalette()`, `#removeAnnotationAtClick()`, `#setContextMenuItemsVisible()`
- Remove fields `#menuDivider`, `#menuRemoveItem`, `#paletteDiv`
- Remove `ep` import (no longer used)
- Remove all `#setContextMenuItemsVisible(true/false)` call sites

A `mouseup` handler is added via `EditorView.domEventHandlers` inside the slot extension list. Every call site that currently calls `this.#slot?.reconfigure([createAnnotationField(...), annotationTheme, this.#navField])` becomes:

```js
this.#slot?.reconfigure([
  createAnnotationField(this.#tagDefs),
  annotationTheme,
  this.#navField,
  EditorView.domEventHandlers({ mouseup: (e, view) => this.#onEditorMouseUp(e, view) })
])
```

This covers `#enableAnnotationMode()`, `#onDocumentLoaded()`, and `#updateTagDefs()`. Because the handler is part of the slot, it is automatically removed when the slot is reconfigured to `[]` on mode exit — no manual cleanup needed.

`#onEditorMouseUp(e, view)` logic:

1. Return early if `!this.#annotationMode`
2. Return early if `e.target` is or is inside `.ann-badge` (badge click has its own path)
3. Get `{ from, to }` from `view.state.selection.main`; return early if `from === to`
4. Call `this.#popup.showForSelection({ clientX: e.clientX, clientY: e.clientY }, from, to)`
5. Return `false` (do not prevent default)

After popup construction in `install()`, call `this.#popup.setWrapCallback(def => this.#wrapSelectionWith(def))` so the popup can delegate wrap operations back to the plugin's existing method.

## Section 2 — `XmlAnnotationPopup` Extensions

### New private helper: `#renderPalette(container, currentTag, onChipClick)`

Renders one chip per tag definition, sorted by priority. The chip whose `tag === currentTag` is rendered at opacity 0.4 and is not interactive (cursor: default, no click listener). All other chips are fully active. On click, calls `onChipClick(def)`.

Chip styling matches the existing context menu palette (monospace, 9px, uppercase, color badge). Label uses `def.label.replace(/\{@[^}]+\}/g, '…')`.

### New public method: `setWrapCallback(fn)`

Stores `fn` (signature: `(def: AnnotationTagDef) => void`) for use by `showForSelection`.

### New public method: `showForSelection(coords, from, to)`

1. Clears and shows the overlay
2. Renders a header div: "Annotate as…" (same title style as `#show`)
3. Calls `#renderPalette(overlay, null, def => { this.#hide(); this.#wrapCallback?.(def) })`
4. Positions overlay near `coords` (same clamping logic as `#show`)

### Extended `#show(coords, def, element)`

After the existing remove link, append:

1. A `<sl-divider>` for visual separation
2. A label div: "Change to…" (same label style as attribute section header)
3. `#renderPalette(overlay, def.tag, async newDef => { await this.#retag(element, newDef); this.#hide() })`

### New private method: `#retag(element, newDef)`

```
1. Create newEl = document.createElementNS(element.namespaceURI, newDef.tag)
2. Copy all attributes from element to newEl
3. If newDef.defaultAttributes: overwrite those keys on newEl
4. Move all children from element to newEl
5. element.parentNode.replaceChild(newEl, element)
6. await this.#editor.updateEditorFromNode(newEl.parentNode)
```

If the new tag is the same as the current tag, treat as no-op (the current chip is disabled so this should not occur, but guard defensively).

### Dismiss behaviour

Unchanged: click-outside and Escape key close the popup in both modes.

## Section 3 — Docs Update

File: `docs/user-manual/editing-workflow.md`

- **Line ~63**: Remove the sentence "In annotation mode the context menu additionally shows the annotation chip palette and a 'Remove annotation' item — see [Visual Annotation Mode](#visual-annotation-mode)."
- **Annotating text subsection**: Replace "Right-click to open the context menu. A chip palette appears at the top…" with: "Release the mouse after selecting text. A popup appears near the cursor showing the available annotation chips — click one to wrap the selection."
- **Editing annotation attributes / Changing a tag**: Add a new short paragraph after the badge-click description: "The popup also shows a 'Change to…' palette at the bottom. Click any chip to retag the element to a different annotation type."
- **Removing an annotation subsection**: Remove the "Via context menu" bullet. Only the popup path remains.

## File Change Summary

| File | Change |
| --- | --- |
| `app/src/plugins/xml-annotation.js` | Remove context menu plumbing; add `#onEditorMouseUp`; include dom event handler in all `reconfigure()` calls; call `setWrapCallback` after popup construction |
| `app/src/modules/codemirror/xml-annotation-popup.js` | Add `setWrapCallback`, `showForSelection`, `#renderPalette`, `#retag`; extend `#show` with "Change to…" palette section |
| `docs/user-manual/editing-workflow.md` | Update annotation workflow prose as above |

No new files. No changes to `xml-annotation-decorations.js` or any other module.

# Annotation Workflow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right-click context menu as the annotation entry point with a mouseup-triggered popup, and add retagging via the existing badge-click popup, removing all context menu contributions from the annotation plugin.

**Architecture:** Extend `XmlAnnotationPopup` with a shared `#renderPalette` helper used by both a new `showForSelection` method (mouseup path) and an extended `#show` method (badge-click path with added "Change to…" section). Wire a `mouseup` handler into the CM compartment slot via `EditorView.domEventHandlers` so it is automatically active only in annotation mode. Strip all context menu plumbing from `XmlAnnotationPlugin`.

**Tech Stack:** CodeMirror 6 (`@codemirror/view` `EditorView.domEventHandlers`), vanilla DOM, Shoelace components (`sl-divider`).

---

### Task 1: Extend popup typedef + add `#tagDefs` field + `#renderPalette`

**Files:**
- Modify: `app/src/modules/codemirror/xml-annotation-popup.js`

The popup currently stores only a `Map` of tag defs; we need the flat array for rendering the palette. We also need `priority`, `description`, and `defaultAttributes` in the typedef.

- [ ] **Step 1: Update the `AnnotationTagDef` typedef to include missing fields**

In `xml-annotation-popup.js`, replace:

```js
/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null, color: string,
 *   attributes?: Array<{ name: string, values?: string[]|null }>|null }} AnnotationTagDef
 */
```

with:

```js
/**
 * @typedef {{ tag: string, label: string, labelMap?: Record<string,string>|null, color: string,
 *   attributes?: Array<{ name: string, values?: string[]|null }>|null,
 *   description?: string|null, priority?: number,
 *   defaultAttributes?: Record<string,string>|null }} AnnotationTagDef
 */
```

- [ ] **Step 2: Add `#tagDefs` and `#wrapCallback` fields**

Replace:

```js
  /** @type {Map<string, AnnotationTagDef[]>} */
  #tagMap = new Map();
```

with:

```js
  /** @type {AnnotationTagDef[]} */
  #tagDefs = [];

  /** @type {Map<string, AnnotationTagDef[]>} */
  #tagMap = new Map();

  /** @type {((def: AnnotationTagDef) => void)|null} */
  #wrapCallback = null;
```

- [ ] **Step 3: Store `tagDefs` array in `#buildTagMap`**

Replace:

```js
  /** @param {AnnotationTagDef[]} tagDefs */
  #buildTagMap(tagDefs) {
    this.#tagMap = new Map();
```

with:

```js
  /** @param {AnnotationTagDef[]} tagDefs */
  #buildTagMap(tagDefs) {
    this.#tagDefs = tagDefs;
    this.#tagMap = new Map();
```

- [ ] **Step 4: Add `#renderPalette` method before `#hide()`**

Insert before the `#hide()` method:

```js
  /**
   * Renders one chip per tag definition into `container`.
   * The chip whose `tag === currentTag` is muted and non-interactive.
   * @param {HTMLElement} container
   * @param {string|null} currentTag
   * @param {(def: AnnotationTagDef) => void} onChipClick
   */
  #renderPalette(container, currentTag, onChipClick) {
    const sorted = [...this.#tagDefs].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' });
    for (const def of sorted) {
      const chip = document.createElement('span');
      chip.textContent = def.label.replace(/\{@[^}]+\}/g, '…');
      chip.title = def.description || def.label;
      const isCurrent = def.tag === currentTag;
      Object.assign(chip.style, {
        display: 'inline-block',
        background: def.color,
        color: '#1e1e2e',
        fontFamily: 'monospace',
        fontSize: '9px',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: '3px',
        padding: '2px 6px 3px',
        cursor: isCurrent ? 'default' : 'pointer',
        opacity: isCurrent ? '0.4' : '1',
        userSelect: 'none',
      });
      if (!isCurrent) chip.addEventListener('click', () => onChipClick(def));
      row.appendChild(chip);
    }
    container.appendChild(row);
  }
```

- [ ] **Step 5: Verify the file parses without errors**

Open the browser dev tools (or check for any import errors in the running app) and confirm no syntax errors were introduced.

- [ ] **Step 6: Commit**

```bash
git add app/src/modules/codemirror/xml-annotation-popup.js
git commit -m "feat(annotation): add #tagDefs storage and #renderPalette helper to popup"
```

---

### Task 2: Add `setWrapCallback` and `showForSelection` to popup

**Files:**
- Modify: `app/src/modules/codemirror/xml-annotation-popup.js`

- [ ] **Step 1: Add `setWrapCallback` and `showForSelection` public methods**

Insert both methods before `#buildTagMap` (i.e., after the comment `// ── Private ──`):

```js
  /**
   * Register the callback invoked when the user picks a chip in the selection popup.
   * Must be called once from the annotation plugin after `mount()`.
   * @param {(def: AnnotationTagDef) => void} fn
   */
  setWrapCallback(fn) {
    this.#wrapCallback = fn;
  }

  /**
   * Show the "Annotate as…" palette popup at the given screen coordinates.
   * Called by the annotation plugin's mouseup handler when annotation mode is active
   * and the user has a non-empty CM selection.
   * @param {{ clientX: number, clientY: number }} coords
   * @param {number} _from  CM document position of selection start (reserved for future use)
   * @param {number} _to    CM document position of selection end
   */
  showForSelection(coords, _from, _to) {
    if (!this.#overlay) return;
    this.#overlay.innerHTML = '';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold; margin-bottom:10px; font-size:11px; letter-spacing:.05em;';
    title.textContent = 'Annotate as…';
    this.#overlay.appendChild(title);

    this.#renderPalette(this.#overlay, null, (def) => {
      this.#hide();
      this.#wrapCallback?.(def);
    });

    const x = coords.clientX;
    const y = coords.clientY;
    this.#overlay.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    this.#overlay.style.top  = `${Math.min(y + 12, window.innerHeight - 200)}px`;
    this.#overlay.style.display = '';
  }
```

- [ ] **Step 2: Verify no syntax errors**

Check the browser console for import/parse errors after saving.

- [ ] **Step 3: Commit**

```bash
git add app/src/modules/codemirror/xml-annotation-popup.js
git commit -m "feat(annotation): add setWrapCallback and showForSelection to popup"
```

---

### Task 3: Add `#retag` and extend `#show` with "Change to…" palette

**Files:**
- Modify: `app/src/modules/codemirror/xml-annotation-popup.js`

- [ ] **Step 1: Add `#retag` method before `#hide()`**

Insert before `#hide()`:

```js
  /**
   * Replaces `element` with a new element of `newDef.tag`, copying all existing
   * attributes then applying `newDef.defaultAttributes` on top.
   * @param {Element} element
   * @param {AnnotationTagDef} newDef
   */
  async #retag(element, newDef) {
    if (element.localName === newDef.tag) return;
    const parent = element.parentNode;
    if (!parent) return;
    const newEl = document.createElementNS(element.namespaceURI, newDef.tag);
    for (const attr of element.attributes) {
      newEl.setAttribute(attr.name, attr.value);
    }
    if (newDef.defaultAttributes) {
      for (const [k, v] of Object.entries(newDef.defaultAttributes)) {
        newEl.setAttribute(k, v);
      }
    }
    while (element.firstChild) newEl.appendChild(element.firstChild);
    parent.replaceChild(newEl, element);
    await this.#editor.updateEditorFromNode(parent);
  }
```

- [ ] **Step 2: Extend `#show` to append the "Change to…" section**

In `#show`, find the block that positions and reveals the overlay:

```js
    // Position near the badge
    const x = coords.clientX;
    const y = coords.clientY;
    this.#overlay.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    this.#overlay.style.top  = `${Math.min(y + 12, window.innerHeight - 200)}px`;
    this.#overlay.style.display = '';
```

Replace it with:

```js
    const changeDivider = document.createElement('sl-divider');
    changeDivider.style.cssText = 'margin: 8px 0;';
    this.#overlay.appendChild(changeDivider);

    const changeLabel = document.createElement('div');
    changeLabel.style.cssText = 'font-size:10px; color:#6c7086; margin-bottom:6px; text-transform:uppercase;';
    changeLabel.textContent = 'Change to';
    this.#overlay.appendChild(changeLabel);

    this.#renderPalette(this.#overlay, def.tag, async (newDef) => {
      this.#hide();
      await this.#retag(element, newDef);
    });

    // Position near the badge — extra bottom margin for the "Change to" palette section
    const x = coords.clientX;
    const y = coords.clientY;
    this.#overlay.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    this.#overlay.style.top  = `${Math.min(y + 12, window.innerHeight - 280)}px`;
    this.#overlay.style.display = '';
```

- [ ] **Step 3: Manual smoke-test (if the app is running)**

Enable annotation mode on a document that has annotation tags. Click a badge — the popup should now show attributes, merge controls, remove link, a divider, a "CHANGE TO" label, and colored chips. The chip for the current tag should appear faded and non-clickable. Clicking a different chip should retag the element and close the popup.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/codemirror/xml-annotation-popup.js
git commit -m "feat(annotation): add #retag and extend badge-click popup with Change-to palette"
```

---

### Task 4: Remove context menu plumbing from `XmlAnnotationPlugin`

**Files:**
- Modify: `app/src/plugins/xml-annotation.js`

- [ ] **Step 1: Remove the `ep` import**

Remove the line:

```js
import ep from '../extension-points.js'
```

- [ ] **Step 2: Remove `static extensionPoints` and its handler method**

Remove the entire block (including JSDoc):

```js
  static extensionPoints = [ep.xmlEditor.contextMenuItems];

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`.
   * Called by XmlEditorPlugin.start() to collect context menu contributions.
   * Delegates to {@link XmlAnnotationPlugin#contextMenuItems}.
   * @returns {Array<{element: HTMLElement, onBeforeShow?: () => void}>}
   */
  [ep.xmlEditor.contextMenuItems]() { return this.#contextMenuItems() }
```

- [ ] **Step 3: Remove three field declarations**

Remove:

```js
  /** @type {HTMLElement|null} */
  #menuDivider = null;

  /** @type {HTMLElement|null} */
  #menuRemoveItem = null;

  /** @type {HTMLElement|null} */
  #paletteDiv = null;
```

- [ ] **Step 4: Remove the `#contextMenuItems()` method and its section comment**

Remove the entire block from the comment to the closing brace:

```js
  // ── Context menu contribution ───────────────────────────────────────

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`.
   * Returns a section divider, a "Remove annotation" item, and a tag palette
   * div whose chips are rebuilt each time the menu opens via onBeforeShow.
   * @returns {Array<{element: HTMLElement, onBeforeShow?: () => void}>}
   */
  #contextMenuItems() {
    const divider = document.createElement('sl-divider')
    divider.hidden = true
    this.#menuDivider = divider

    const removeItem = document.createElement('sl-menu-item')
    removeItem.textContent = 'Remove annotation'
    removeItem.hidden = true
    removeItem.disabled = true
    this.#menuRemoveItem = removeItem
    removeItem.addEventListener('click', () => this.#removeAnnotationAtClick())

    const palette = document.createElement('div')
    palette.hidden = true
    Object.assign(palette.style, {
      display: 'flex', flexWrap: 'wrap', gap: '4px',
      padding: '4px 12px 8px', boxSizing: 'border-box', maxWidth: '260px'
    })
    this.#paletteDiv = palette

    return [
      {
        element: divider,
        prepend: true,
        onBeforeShow: () => { divider.hidden = !this.#annotationMode }
      },
      {
        element: removeItem,
        prepend: true,
        onBeforeShow: () => {
          removeItem.hidden = !this.#annotationMode
          if (!this.#annotationMode) return
          const view = this.#xmlEditor.getView?.()
          const synced = this.#xmlEditor.isSynced?.()
          if (!view || !synced) { removeItem.disabled = true; return }
          try {
            const el = /** @type {Element|null} */ (this.#xmlEditor.getDomNodeAt?.(view.state.selection.main.head))
            removeItem.disabled = !el || !this.#tagDefs.some(d => d.tag === el.localName)
          } catch { removeItem.disabled = true }
        }
      },
      {
        element: palette,
        prepend: true,
        onBeforeShow: () => this.#rebuildPalette()
      }
    ]
  }

  /** Rebuilds the tag chip palette each time the context menu opens. */
  #rebuildPalette() {
    const palette = this.#paletteDiv
    if (!palette) return
    palette.hidden = !this.#annotationMode
    palette.replaceChildren()
    if (!this.#annotationMode || this.#tagDefs.length === 0) return

    const view = this.#xmlEditor.getView?.()
    const { from, to } = view?.state.selection.main ?? { from: 0, to: 0 }
    const hasSelection = from !== to && !!this.#xmlEditor.isSynced?.()

    const sorted = [...this.#tagDefs].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    for (const def of sorted) {
      const chip = document.createElement('span')
      chip.textContent = def.label.replace(/\{@[^}]+\}/g, '…')
      chip.title = def.description || def.label
      chip.dataset.tag = def.tag
      Object.assign(chip.style, {
        display: 'inline-block',
        background: def.color,
        color: '#1e1e2e',
        fontFamily: 'monospace',
        fontSize: '9px',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: '3px',
        padding: '2px 6px 3px',
        cursor: hasSelection ? 'pointer' : 'not-allowed',
        opacity: hasSelection ? '1' : '0.35',
        userSelect: 'none',
      })
      if (hasSelection) {
        chip.addEventListener('click', () => this.#wrapSelectionWith(def))
      }
      palette.appendChild(chip)
    }
  }
```

- [ ] **Step 5: Remove `#setContextMenuItemsVisible` method**

Remove:

```js
  /** @param {boolean} visible */
  #setContextMenuItemsVisible(visible) {
    if (this.#menuDivider) this.#menuDivider.hidden = !visible
    if (this.#menuRemoveItem) this.#menuRemoveItem.hidden = !visible
    if (this.#paletteDiv) this.#paletteDiv.hidden = !visible
  }
```

- [ ] **Step 6: Remove `#removeAnnotationAtClick` method**

Remove:

```js
  /**
   * Removes the annotation element at the cursor position by unwrapping its children to the parent.
   */
  async #removeAnnotationAtClick() {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const pos = view.state.selection.main.head
    try {
      const node = this.#xmlEditor.getDomNodeAt?.(pos)
      if (!(node instanceof Element)) return
      if (!this.#tagDefs.some(d => d.tag === node.localName)) return
      const parent = node.parentNode
      if (!parent) return
      while (node.firstChild) parent.insertBefore(node.firstChild, node)
      parent.removeChild(node)
      await this.#xmlEditor.updateEditorFromNode?.(parent)
    } catch (err) {
      // Annotation removal can fail if the XML DOM is out of sync; log as warning since this
      // represents an unexpected state (unlike wrap-sync failures which are timing-related)
      this.#logger.warn('[xml-annotation] remove annotation failed: ' + String(err))
    }
  }
```

- [ ] **Step 7: Remove the two `#setContextMenuItemsVisible` call sites**

In `#enableAnnotationMode`, remove:

```js
    this.#setContextMenuItemsVisible(true)
```

In `#disableAnnotationMode`, remove:

```js
    this.#setContextMenuItemsVisible(false)
```

- [ ] **Step 8: Verify no remaining references to removed symbols**

```bash
grep -n "contextMenu\|menuDivider\|menuRemoveItem\|paletteDiv\|rebuildPalette\|removeAnnotationAtClick\|setContextMenuItemsVisible\|ep\." app/src/plugins/xml-annotation.js
```

Expected: no output (zero matches).

- [ ] **Step 9: Commit**

```bash
git add app/src/plugins/xml-annotation.js
git commit -m "refactor(annotation): remove all context menu contributions"
```

---

### Task 5: Add mouseup handler and wire everything in the plugin

**Files:**
- Modify: `app/src/plugins/xml-annotation.js`

- [ ] **Step 1: Add `EditorView` import**

Add to the existing `@codemirror/view`-adjacent imports (or as a new line):

```js
import { EditorView } from '@codemirror/view'
```

- [ ] **Step 2: Add `#onEditorMouseUp` method**

Add before `onStateUpdate`:

```js
  /**
   * Handles mouseup events on the CM editor content in annotation mode.
   * Shows the "Annotate as…" popup when a non-empty selection is present.
   * Skips if the event target is (or is inside) an annotation badge — badge clicks
   * are handled by the ann-badge-click path.
   * @param {MouseEvent} e
   * @param {import('@codemirror/view').EditorView} view
   * @returns {boolean}
   */
  #onEditorMouseUp(e, view) {
    if (!this.#annotationMode) return false
    if (e.target instanceof Element && e.target.closest('.ann-badge')) return false
    const { from, to } = view.state.selection.main
    if (from === to) return false
    this.#popup?.showForSelection({ clientX: e.clientX, clientY: e.clientY }, from, to)
    return false
  }
```

- [ ] **Step 3: Update all three `reconfigure()` call sites to include the dom event handler**

There are three places that call `this.#slot?.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme, this.#navField])`:

- `#enableAnnotationMode` (one call)
- `#onDocumentLoaded` (one call)
- `#updateTagDefs` (one call)

Replace each occurrence of:

```js
this.#slot?.reconfigure([createAnnotationField(this.#tagDefs), annotationTheme, this.#navField])
```

with:

```js
this.#slot?.reconfigure([
  createAnnotationField(this.#tagDefs),
  annotationTheme,
  this.#navField,
  EditorView.domEventHandlers({ mouseup: (e, view) => this.#onEditorMouseUp(e, view) })
])
```

- [ ] **Step 4: Call `setWrapCallback` after popup mount in `install()`**

In `install()`, find:

```js
      this.#popup = new XmlAnnotationPopup(this.#xmlEditor)
      this.#popup.mount(editorContainer, this.#tagDefs)
```

Replace with:

```js
      this.#popup = new XmlAnnotationPopup(this.#xmlEditor)
      this.#popup.mount(editorContainer, this.#tagDefs)
      this.#popup.setWrapCallback(def => this.#wrapSelectionWith(def))
```

- [ ] **Step 5: Verify no remaining references to removed symbols and no new errors**

```bash
grep -n "reconfigure" app/src/plugins/xml-annotation.js
```

Expected: three matches, all of the new multi-line form.

```bash
grep -n "domEventHandlers\|onEditorMouseUp\|setWrapCallback" app/src/plugins/xml-annotation.js
```

Expected: the new method definition and its three call sites.

- [ ] **Step 6: Manual smoke-test (if the app is running)**

1. Open a document in annotation mode.
2. Select a span of text and release the mouse — the "Annotate as…" popup should appear near the cursor.
3. Click a chip — the selection should be wrapped and the popup should close.
4. Click an existing badge — the attribute popup should appear with a "CHANGE TO" chip palette at the bottom.
5. Click a different chip in the "CHANGE TO" palette — the element's tag should change.
6. Right-click anywhere in the editor in annotation mode — the context menu should no longer show a chip palette or "Remove annotation" item.

- [ ] **Step 7: Commit**

```bash
git add app/src/plugins/xml-annotation.js
git commit -m "feat(annotation): wire mouseup popup and setWrapCallback in plugin"
```

---

### Task 6: Update user documentation

**Files:**
- Modify: `docs/user-manual/editing-workflow.md`

- [ ] **Step 1: Remove the context menu annotation note (line 63)**

Replace:

```
In annotation mode the context menu additionally shows the annotation chip palette and a "Remove annotation" item — see [Visual Annotation Mode](#visual-annotation-mode).
```

with nothing (delete the line, leaving only one blank line before the `---` separator).

- [ ] **Step 2: Update the "Wrapping a text span" workflow steps**

Replace:

```
### Wrapping a text span

1. Select the text you want to annotate by clicking and dragging.
2. Right-click to open the context menu. A chip palette appears at the top, showing one colored chip per available annotation tag.
3. Hover over a chip to see its description in a tooltip.
4. Click the chip to wrap the selection. The tag is inserted with any mandatory default attributes (e.g. `<note place="footnote">`) automatically.
```

with:

```
### Wrapping a text span

1. Select the text you want to annotate by clicking and dragging.
2. Release the mouse. A popup appears near the cursor showing one colored chip per available annotation tag.
3. Hover over a chip to see its description in a tooltip.
4. Click the chip to wrap the selection. The tag is inserted with any mandatory default attributes (e.g. `<note place="footnote">`) automatically.
```

- [ ] **Step 3: Add a "Changing a tag" subsection after "Editing annotation attributes"**

After:

```
Changes are applied to the underlying XML as you make them. Click outside the popup or press **Escape** to dismiss it.
```

Insert:

```

### Changing a tag

The attribute popup includes a **Change to** chip palette at the bottom. Click any chip to retag the annotated element to a different annotation type. The element's content is preserved; mandatory default attributes for the new tag type are applied automatically.
```

- [ ] **Step 4: Simplify the "Removing an annotation" section**

Replace:

```
### Removing an annotation

- **Via context menu:** Right-click anywhere inside the annotated span, then choose **Remove annotation**.
- **Via popup:** Click the badge to open the attribute popup, then click the **Remove annotation** link at the bottom.

Both methods unwrap the element and restore its text content.
```

with:

```
### Removing an annotation

Click the badge to open the attribute popup, then click the **Remove annotation** link at the bottom. The element is unwrapped and its text content is restored.
```

- [ ] **Step 5: Commit**

```bash
git add docs/user-manual/editing-workflow.md
git commit -m "docs: update annotation workflow for mouseup popup and retag palette"
```

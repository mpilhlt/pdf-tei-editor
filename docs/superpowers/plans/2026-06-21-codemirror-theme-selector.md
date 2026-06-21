# CodeMirror Theme Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a palette-icon dropdown button to the XML editor toolbar (far right) that lets users switch between four CodeMirror editor themes (default, dark, color-blind-friendly, high-contrast), with the active theme checkmarked and the preference persisted via `uiStorage`.

**Architecture:** A new `editor-themes.js` module defines four theme bundles as `{ id, label, extensions }` arrays ready for a CodeMirror `Compartment`. The `XMLEditor` module gains a `#themeCompartment` and a `setTheme()` method. The `xmleditor` plugin registers a new toolbar button template, builds the theme menu on install, and wires up selection persistence via `uiStorage`.

**Tech Stack:** CodeMirror 6 (`@codemirror/language` `HighlightStyle`, `@codemirror/view` `EditorView`), `@lezer/highlight` `tags`, Shoelace `sl-dropdown`/`sl-menu`/`sl-menu-item`, existing plugin infrastructure (`uiStorage`, `registerTemplate`, `createSingleFromTemplate`, `addToolbarWidget`).

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `app/src/modules/codemirror/editor-themes.js` | Four theme bundle definitions |
| Modify | `app/src/modules/xmleditor.js` | Add `#themeCompartment` + `setTheme()` |
| Create | `app/src/templates/xmleditor-theme-button.html` | Icon-only dropdown toolbar button template |
| Modify | `app/src/plugins/xmleditor.js` | Register template, wire menu, persist preference |
| Modify | `app/src/plugins/xmleditor.js` (typedef only) | Add `themeDropdown/Btn/Menu` to `xmlEditorToolbarPart` |

---

### Task 1: Create `editor-themes.js` module

**Files:**
- Create: `app/src/modules/codemirror/editor-themes.js`

- [ ] **Step 1: Create the file with all four theme bundles**

```javascript
/**
 * @import {Extension} from '@codemirror/state'
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * @typedef {object} EditorTheme
 * @property {string} id - Unique identifier used for persistence
 * @property {string} label - Display label shown in the theme menu
 * @property {Extension[]} extensions - CodeMirror extensions to load into the theme Compartment
 */

const defaultHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: "#0000c0", fontWeight: "bold" },
  { tag: tags.angleBracket, color: "#0000c0" },
  { tag: tags.attributeName, color: "#7d0000" },
  { tag: tags.attributeValue, color: "#036103" },
  { tag: tags.comment, color: "#808080", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#9b2d9b" },
  { tag: tags.operator, color: "#555" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: "#89b4fa", fontWeight: "bold" },
  { tag: tags.angleBracket, color: "#89b4fa" },
  { tag: tags.attributeName, color: "#f38ba8" },
  { tag: tags.attributeValue, color: "#a6e3a1" },
  { tag: tags.comment, color: "#6c7086", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#cba6f7" },
  { tag: tags.operator, color: "#a6adc8" },
]);

const colorBlindHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: "#648fff", fontWeight: "bold" },
  { tag: tags.angleBracket, color: "#648fff" },
  { tag: tags.attributeName, color: "#dc267f" },
  { tag: tags.attributeValue, color: "#009e73" },
  { tag: tags.comment, color: "#767676", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#785ef0" },
  { tag: tags.operator, color: "#555" },
]);

const highContrastHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: "#0000ff", fontWeight: "bold" },
  { tag: tags.angleBracket, color: "#0000ff" },
  { tag: tags.attributeName, color: "#cc0000" },
  { tag: tags.attributeValue, color: "#006600" },
  { tag: tags.comment, color: "#595959", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#7b00a3" },
  { tag: tags.operator, color: "#333" },
]);

const darkViewTheme = EditorView.theme({
  "&": { backgroundColor: "#1e1e2e", color: "#cdd6f4" },
  ".cm-content": { caretColor: "#cdd6f4" },
  ".cm-cursor": { borderLeftColor: "#cdd6f4" },
  ".cm-gutters": { backgroundColor: "#181825", color: "#6c7086", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "#1e1e2e" },
  ".cm-activeLine": { backgroundColor: "#2a2a3d" },
  ".cm-selectionBackground": { backgroundColor: "#45475a" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "#45475a" },
  ".cm-foldPlaceholder": { backgroundColor: "#313244", color: "#cdd6f4", border: "none" },
}, { dark: true });

const lightViewTheme = EditorView.theme({
  "&": { backgroundColor: "#ffffff", color: "#1e1e1e" },
  ".cm-gutters": { backgroundColor: "#f5f5f5", color: "#999", border: "none" },
});

/** @type {EditorTheme[]} */
export const THEMES = [
  {
    id: "default",
    label: "Default (light)",
    extensions: [lightViewTheme, syntaxHighlighting(defaultHighlight)],
  },
  {
    id: "dark",
    label: "Dark",
    extensions: [darkViewTheme, syntaxHighlighting(darkHighlight)],
  },
  {
    id: "colorBlind",
    label: "Color-blind friendly",
    extensions: [lightViewTheme, syntaxHighlighting(colorBlindHighlight)],
  },
  {
    id: "highContrast",
    label: "High contrast",
    extensions: [lightViewTheme, syntaxHighlighting(highContrastHighlight)],
  },
];

/**
 * Look up a theme bundle by id, falling back to default.
 * @param {string} id
 * @returns {EditorTheme}
 */
export function getTheme(id) {
  return THEMES.find(t => t.id === id) ?? THEMES[0];
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/modules/codemirror/editor-themes.js
git commit -m "feat(themes): add editor-themes module with four CodeMirror theme bundles"
```

---

### Task 2: Add `#themeCompartment` and `setTheme()` to `XMLEditor`

**Files:**
- Modify: `app/src/modules/xmleditor.js`

**Context:** `XMLEditor` already uses private `Compartment` fields (lines 157–167) and the `setLineWrapping` method (line 793) as the reference pattern. All compartments are initialised in the `extensions` array passed to `EditorState.create()` (lines 191–231). `@codemirror/language` is already imported on line 48. `EditorView` is already imported on line 46.

- [ ] **Step 1: Import `getTheme` and `EditorTheme` typedef at the top of the file**

After the existing local imports (around line 60), add:

```javascript
import { getTheme } from './codemirror/editor-themes.js';
/**
 * @import {EditorTheme} from './codemirror/editor-themes.js'
 */
```

- [ ] **Step 2: Add `#themeCompartment` to the compartment block (lines 157–167)**

Insert after `#xmlTagSyncCompartment`:

```javascript
  #themeCompartment = new Compartment()
```

- [ ] **Step 3: Replace the `syntaxHighlighting(defaultHighlightStyle, { fallback: true })` line in the extensions array (line 201) with the compartment initialisation**

Old line:
```javascript
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
```

New line:
```javascript
      this.#themeCompartment.of(getTheme('default').extensions),
```

Also remove `defaultHighlightStyle` from the `@codemirror/language` import on line 48 since it is no longer used directly (to keep imports clean):

Old:
```javascript
import { syntaxTree, syntaxParserRunning, indentUnit, foldInside, foldEffect, unfoldEffect, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language"
```

New:
```javascript
import { syntaxTree, syntaxParserRunning, indentUnit, foldInside, foldEffect, unfoldEffect, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, bracketMatching } from "@codemirror/language"
```

- [ ] **Step 4: Add the `setTheme()` public method immediately after `setLineWrapping()` (around line 805)**

```javascript
  /**
   * Replaces the active editor theme bundle.
   * @param {EditorTheme} theme
   */
  setTheme(theme) {
    this.#view.dispatch({
      effects: this.#themeCompartment.reconfigure(theme.extensions)
    });
  }
```

- [ ] **Step 5: Verify no import of `defaultHighlightStyle` remains and that `syntaxHighlighting` is still imported**

```bash
grep "defaultHighlightStyle\|syntaxHighlighting" app/src/modules/xmleditor.js
```

Expected output: one line containing `syntaxHighlighting` in the import, none with `defaultHighlightStyle`.

- [ ] **Step 6: Commit**

```bash
git add app/src/modules/xmleditor.js
git commit -m "feat(themes): add #themeCompartment and setTheme() to XMLEditor"
```

---

### Task 3: Create the theme button toolbar template

**Files:**
- Create: `app/src/templates/xmleditor-theme-button.html`

**Context:** Follows the exact same structure as `app/src/templates/xsl-viewer-button.html`. The `sl-tooltip` wraps `sl-dropdown`, which contains the icon-only trigger button (slot="trigger") and an empty `sl-menu` whose items are built programmatically. The `name` attributes are referenced in the plugin via `querySelector`.

- [ ] **Step 1: Create the template file**

```html
<sl-tooltip content="Editor theme">
  <sl-dropdown name="themeDropdown" placement="bottom-end">
    <sl-button name="themeBtn" variant="text" size="small" slot="trigger">
      <sl-icon name="palette"></sl-icon>
    </sl-button>
    <sl-menu name="themeMenu"></sl-menu>
  </sl-dropdown>
</sl-tooltip>
```

- [ ] **Step 2: Commit**

```bash
git add app/src/templates/xmleditor-theme-button.html
git commit -m "feat(themes): add xmleditor-theme-button toolbar template"
```

---

### Task 4: Wire the theme button into the XML editor plugin

**Files:**
- Modify: `app/src/plugins/xmleditor.js`

**Context:**
- `createSingleFromTemplate` is already imported from `'../modules/ui-system.js'` (line 30).
- `registerTemplate` is imported from the same module (line 30).
- The existing `xsl-viewer` plugin (lines 126–147) shows the exact pattern for adding a dropdown widget: `createSingleFromTemplate` → `addToolbarWidget(el, priority)` → `querySelector` for inner elements → z-index fix with `sl-show`/`sl-hide`.
- `uiStorage` is available on every `Plugin` subclass as `this.uiStorage`.
- `THEMES` and `getTheme` come from `'../modules/codemirror/editor-themes.js'`.
- Priority 1 (lower than download's 2) ensures the theme button is the rightmost toolbar item.

- [ ] **Step 1: Add `@import` for `EditorTheme` and import `THEMES`/`getTheme` near the top of `app/src/plugins/xmleditor.js`**

After the existing imports (around line 37), add:

```javascript
import { THEMES, getTheme } from '../modules/codemirror/editor-themes.js';
/**
 * @import {EditorTheme} from '../modules/codemirror/editor-themes.js'
 * @import {SlMenuItem} from '../ui.js'
 */
```

Note: `SlMenuItem` may already be imported — check line 11 first and skip if present.

- [ ] **Step 2: Register the theme button template at module level (after the other `registerTemplate` calls, around line 53)**

```javascript
await registerTemplate('xmleditor-theme-button', 'xmleditor-theme-button.html')
```

- [ ] **Step 3: Add private field declarations for theme UI elements in the `XmlEditorPlugin` class body, after the existing `#downloadBtn` field (around line 167)**

```javascript
  /** @type {import('../ui.js').SlDropdown|null} */
  #themeDropdown = null;
  /** @type {import('../ui.js').SlMenu|null} */
  #themeMenu = null;
```

- [ ] **Step 4: In the `install()` method, add theme button setup after the import/export buttons block (after the `importExportButtons.forEach` block, around line 311)**

```javascript
    // Create theme selector button and add to toolbar (priority 1 - far right)
    const themeButtonEl = createSingleFromTemplate('xmleditor-theme-button');
    this.#toolbar.add(themeButtonEl, 1);

    this.#themeDropdown = /** @type {import('../ui.js').SlDropdown} */ (themeButtonEl.querySelector('[name="themeDropdown"]'));
    this.#themeMenu = /** @type {import('../ui.js').SlMenu} */ (themeButtonEl.querySelector('[name="themeMenu"]'));

    // Build theme menu items
    const savedThemeId = this.uiStorage.get('editorTheme', 'default');
    for (const theme of THEMES) {
      const item = /** @type {import('../ui.js').SlMenuItem} */ (document.createElement('sl-menu-item'));
      item.textContent = theme.label;
      item.dataset.themeId = theme.id;
      item.type = 'checkbox';
      item.checked = theme.id === savedThemeId;
      this.#themeMenu.appendChild(item);
    }

    // Apply saved theme to the editor
    this.#xmlEditor.setTheme(getTheme(savedThemeId));

    // Theme selection handler
    this.#themeMenu.addEventListener('sl-select', (event) => {
      const item = /** @type {import('../ui.js').SlMenuItem} */ (event.detail.item);
      const themeId = item.dataset.themeId;
      if (!themeId) return;
      this.#xmlEditor.setTheme(getTheme(themeId));
      this.uiStorage.set('editorTheme', themeId);
      // Update checkmarks
      this.#themeMenu.querySelectorAll('sl-menu-item').forEach(el => {
        /** @type {import('../ui.js').SlMenuItem} */ (el).checked = el.dataset.themeId === themeId;
      });
    });

    // Fix z-index stacking context so the dropdown appears above the editor
    if (this.#themeDropdown) {
      this.#themeDropdown.addEventListener('sl-show', () => {
        this.#themeDropdown.closest('tool-bar')?.classList.add('dropdown-open');
      });
      this.#themeDropdown.addEventListener('sl-hide', () => {
        this.#themeDropdown.closest('tool-bar')?.classList.remove('dropdown-open');
      });
    }
```

- [ ] **Step 5: Add the typedef entries to `xmlEditorToolbarPart` (around line 70–87)**

In the `@typedef {object} xmlEditorToolbarPart` block, add these three lines before the closing `*/`:

```javascript
 * @property {import('./xsl-viewer.js').SlDropdown} themeDropdown - Editor theme picker dropdown
 * @property {import('../ui.js').SlButton} themeBtn - Editor theme picker trigger button
 * @property {import('../ui.js').SlMenu} themeMenu - Editor theme picker menu
```

(Use the same `SlDropdown`/`SlMenu` types already present in the file. The exact import path to use is whatever is already used for `xslViewerDropdown` in the same typedef — around line 82.)

- [ ] **Step 6: Verify the theme button appears and works**

Open the running app (do NOT restart it — the dev server auto-reloads). Open any XML file. Confirm:
1. A palette icon (`🎨`) appears as the rightmost toolbar button.
2. Clicking it shows a dropdown with four items.
3. The active theme has a checkmark.
4. Selecting "Dark" switches the editor to a dark background with light syntax colors.
5. Refreshing the page restores the last selected theme.

- [ ] **Step 7: Commit**

```bash
git add app/src/plugins/xmleditor.js
git commit -m "feat(themes): add editor theme selector dropdown to XML editor toolbar"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
| --- | --- |
| Four themes (default, dark, colorBlind, highContrast) | Task 1 |
| Editor background controlled by theme | Task 1 (`EditorView.theme`) |
| XML syntax color palette per theme | Task 1 (`HighlightStyle.define`) |
| CodeMirror Compartment for runtime swap | Task 2 |
| `setTheme()` public method on `XMLEditor` | Task 2 |
| Icon-only button in XML editor toolbar, right side | Task 3 + Task 4 |
| Dropdown with theme names | Task 4 |
| Active theme checkmarked | Task 4 |
| Preference persisted via `uiStorage` | Task 4 |
| Restored on page load | Task 4 |
| Typedef updated | Task 4 step 5 |

**Placeholder scan:** No TBDs, TODOs, or vague steps found.

**Type consistency:**
- `EditorTheme` defined in Task 1, imported in Tasks 2 and 4 using the same path.
- `getTheme(id)` returns `EditorTheme`, called in Task 2 and Task 4 with string literal or stored id — consistent.
- `#themeCompartment.reconfigure(theme.extensions)` — `theme.extensions` is `Extension[]`, which is what `Compartment.reconfigure` expects — consistent.
- `THEMES` iterated in Task 4 to build menu; `getTheme` used to look up by stored id — consistent with Task 1 export names.

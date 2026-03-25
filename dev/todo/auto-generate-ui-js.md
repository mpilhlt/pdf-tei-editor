# Auto-generate ui.js (Issue #338)

## Goal

Replace the manually-maintained sections of `app/src/ui.js` with auto-generation:
1. Shoelace component imports (scan HTML templates)
2. Shoelace component exports (same set)
3. `namedElementsTree` typedef and its `@import` declarations (scan plugins and templates)

Static infrastructure (non-derivable from HTML/JSDoc scanning) moves to `app/src/modules/ui.static.js`.

## Current State

`app/src/ui.js` has four manually-maintained sections:
- Lines 17–38: Shoelace `import` statements (22 entries)
- Lines 43–65: `@import` type declarations referencing plugin and template typedef files
- Lines 77–98: `namedElementsTree` typedef (top-level UI element tree)
- Lines 117–122: `export` statement (all Shoelace components)

`bin/generate-ui-types.js` already auto-generates `app/src/templates/*.types.js` files.

## Architecture

### New file: `app/src/modules/ui.static.js`

Contains everything that cannot be derived from static scanning:

```js
import { createNavigableElement, createHtmlElements, registerTemplate,
         createFromTemplate, createSingleFromTemplate } from './ui-system.js';
import { Spinner } from './spinner.js';
import './panels/index.js';

/** @template {Element} T @template {Record<string, any>} N @typedef {T & N} UIPart */

let ui = /** @type {namedElementsTree} */(/** @type {unknown} */(null));

function updateUi() {
  ui = /** @type {namedElementsTree} */(/** @type {unknown} */(createNavigableElement(document)));
}

updateUi();

export { updateUi, createHtmlElements, registerTemplate, createFromTemplate,
         createSingleFromTemplate, Spinner, ui as default };
```

All import paths relative to `app/src/modules/`.

### Generated file: `app/src/ui.js` (fully auto-generated)

```js
/**
 * @registerModule
 */
// AUTO-GENERATED — do not edit. Regenerate with: npm run build:ui

export { updateUi, createHtmlElements, registerTemplate,
         createFromTemplate, createSingleFromTemplate, Spinner } from './modules/ui.static.js';
export { default } from './modules/ui.static.js';

// ── @import type declarations (auto-discovered) ──────────────────────────────
/**
 * @import {toolbarPart} from './plugins/toolbar.js'
 * @import {infoDrawerPart} from './templates/info-drawer.types.js'
 * ... (all @import blocks, auto-discovered)
 */

// ── namedElementsTree typedef (auto-generated) ───────────────────────────────
/**
 * @typedef {object} namedElementsTree
 * @property {UIPart<ToolBar, toolbarPart>} toolbar
 * ... (all properties, auto-generated)
 */

// ── Shoelace imports (auto-generated from template scan) ─────────────────────
import SlButton from '@shoelace-style/shoelace/dist/components/button/button.js';
// ...

// ── Shoelace exports ─────────────────────────────────────────────────────────
export { SlButton, ... };

// @ts-ignore
window.ui = (await import('./modules/ui.static.js')).default;
```

## Auto-discovery Mechanism for `namedElementsTree`

### Source 1: `index.html` named elements

Scan `app/web/index.html` for named elements (`name` attribute). Map each to its TypeScript type using `TAG_TYPE_MAP`. These are base elements that plugins extend with typedefs.

### Source 2: Template `.types.js` files (simple template contributions)

For each `app/src/templates/*.types.js`, extract the root typedef name (e.g. `dialogPart` from `dialog.types.js`). Cross-reference with the template's root element `name` attribute (from the `.html` file) to determine the `namedElementsTree` property name. These cover elements added by plugins that use unmodified template types.

### Source 3: `@uiPart` annotation in plugin files

For plugins that contribute more complex UI elements (combining multiple template parts, or using custom element types like `ToolBar`), add a JSDoc annotation to the plugin file:

```js
/**
 * @uiPart toolbar {UIPart<ToolBar, toolbarPart>}
 * The main application toolbar element.
 */
```

```js
/**
 * @uiPart pdfViewer {UIPart<HTMLDivElement, pdfViewerPart>}
 * @uiPart xmlEditor {UIPart<HTMLDivElement, xmlEditorPart>}
 */
```

The generator scans all plugin files for `@uiPart` annotations. Each annotation provides:
- Element name (`toolbar`, `pdfViewer`, ...)
- Full JSDoc type expression (verbatim, used in `namedElementsTree`)
- Implicit: source file path (for the `@import` declaration)
- Optional: typedef name (extracted from the type expression, for the `@import` target)

`@uiPart` takes priority over Source 2 for the same element name.

### Typedef import resolution

For each discovered `@uiPart`, the generator determines the `@import` source:
- If the typedef is defined in the plugin file itself (grep for `@typedef {object} {typedefName}`) → import from plugin file
- If the typedef is in a `.types.js` file → import from template types file
- The `UIPart` generic and element class types (`ToolBar`, `SlDialog`, etc.) come from `ui.static.js` and Shoelace (no additional `@import` needed)

## Implementation Steps

### Step 1: Create `app/src/modules/ui.static.js`

Extract from current `ui.js`: non-Shoelace imports, `UIPart` typedef, `ui` variable, `updateUi()`, static exports. Adjust import paths (relative to `modules/` directory).

### Step 2: Add `@uiPart` annotations to plugin files

Plugins that contribute named elements to `namedElementsTree` that are NOT derivable from template root element names:

| Plugin file | Annotation needed |
|-------------|-------------------|
| `plugins/toolbar.js` | `@uiPart toolbar {UIPart<ToolBar, toolbarPart>}` |
| `plugins/pdfviewer.js` | `@uiPart pdfViewer {UIPart<HTMLDivElement, pdfViewerPart>}` |
| `plugins/xmleditor.js` | `@uiPart xmlEditor {UIPart<HTMLDivElement, xmlEditorPart>}` |
| `plugins/help.js` | `@uiPart helpIcon {HTMLDivElement}`, `@uiPart topicsContainer {HTMLDivElement}` (check with `HelpWidgetElements`) |
| `plugins/progress.js` | `@uiPart progressWidget {UIPart<HTMLDivElement, progressWidgetPart>}` |

Templates whose root element `name` matches the typedef name (auto-derivable via Source 2 — no annotation needed):

| Template | Root element name | Typedef | namedElementsTree property |
|----------|-------------------|---------|---------------------------|
| `dialog.html` | `dialog` | `dialogPart` | `dialog` |
| `info-drawer.html` | `infoDrawer` | `infoDrawerPart` | `infoDrawer` |
| `login-dialog.html` | `loginDialog` | `loginDialogPart` | `loginDialog` |
| `save-document-dialog.html` | `saveDocumentDialog` | `saveDocumentDialogPart` | `saveDocumentDialog` |
| `annotation-guide-drawer.html` | (check) | `annotationGuideDrawerPart` | `annotationGuideDrawer` |
| `file-selection-drawer.html` | (check) | `fileSelectionDrawerPart` | `fileDrawer` |
| `tei-revision-history-drawer.html` | (check) | `teiRevisionHistoryDrawerPart` | `teiRevisionHistoryDrawer` |
| `tei-wizard-dialog.html` | (check) | `teiWizardDialogPart` | `teiWizardDialog` |
| `backend-plugins-result-dialog.html` | (check) | `backendPluginsResultDialogPart` | `pluginResultDialog` |
| `user-profile-dialog.html` | (check) | `userProfileDialogPart` | `userProfileDialog` |
| `config-editor-dialog.html` | (check) | `configEditorDialogPart` | `configEditorDialog` |
| `prompt-editor.html` | (check) | `promptEditorPart` | `promptEditor` |
| `extraction-dialog.html` | (check) | `extractionDialogPart` | `extractionOptions` |
| `progress.html` | (check) | `progressPart` | — (covered by @uiPart) |

Note: some element names differ from template names (e.g., `pluginResultDialog` vs `backendPluginsResultDialog`). The generator uses the `name` attribute from the template HTML as ground truth. Verify all before implementing.

### Step 3: Extend `bin/generate-ui-types.js` → `bin/generate-ui.js`

The new script:
1. Runs existing template `.types.js` generation (unchanged)
2. Scans `app/src/templates/*.html` and `app/web/index.html` for `sl-*` tags → collects Shoelace components used
3. Scans `app/src/plugins/*.js` for `@uiPart` annotations
4. Builds `namedElementsTree` typedef:
   - Entries from `@uiPart` annotations (verbatim type expressions)
   - Entries from template root elements (derives type via `TAG_TYPE_MAP` and `{name}Part` convention)
5. Builds `@import` declarations for all referenced plugin/template typedefs
6. Writes `app/src/ui.js`

### Step 4: Update `bin/build.js`

Add a `ui` step: `node bin/generate-ui.js`. Register before `importmap`.

### Step 5: Update `package.json`

- Add `"build:ui": "node bin/generate-ui.js"` (replaces `build:ui-types` or keep both)
- `"build:ui-types"` can remain as an alias running the same script

### Step 6: Update importmap and other references

- Any file importing from `./ui.js` using types that now come from `./modules/ui.static.js` (specifically `UIPart`) needs its import path updated
- Verify that `import { UIPart } from './ui.js'` still works (it will, since `ui.js` re-exports from `ui.static.js`)

## Files Changed

| File | Change |
|------|--------|
| `app/src/ui.js` | Becomes fully auto-generated |
| `app/src/modules/ui.static.js` | New — contains extracted static/manual parts |
| `bin/generate-ui.js` | New — supersedes `generate-ui-types.js` |
| `bin/generate-ui-types.js` | Kept as thin wrapper or removed |
| `bin/build.js` | Add `ui` step |
| `package.json` | Add/update `build:ui` script |
| `app/src/plugins/toolbar.js` | Add `@uiPart` annotation |
| `app/src/plugins/pdfviewer.js` | Add `@uiPart` annotation |
| `app/src/plugins/xmleditor.js` | Add `@uiPart` annotation |
| `app/src/plugins/help.js` | Add `@uiPart` annotation |
| `app/src/plugins/progress.js` | Add `@uiPart` annotation |

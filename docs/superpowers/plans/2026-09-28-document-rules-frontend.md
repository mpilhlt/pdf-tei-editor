# Document Rules Registry — Frontend (Plan 5 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the frontend for the document rules registry, per [docs/superpowers/specs/2026-09-27-document-rules-registry-design.md](../specs/2026-09-27-document-rules-registry-design.md)'s "Frontend design" section: a dynamically-populated "Edit prompts/schemas" Tools-menu submenu (one entry per resource the open document references), a per-resource editor dialog (override row, note, New/Save/Delete/Reset, format-specific body), and a reviewer/admin-only "Refresh document rules" action. This is the last of 5 plans; Plans 1-4 already built and shipped the entire backend (`fastapi_app/lib/doc_rules/`, the `/api/v1/document-rules` router including `/refresh/{preview,execute}`) and the regenerated `app/src/modules/api-client-v1.js` client.

**Architecture:** One new, self-contained frontend plugin, `app/src/plugins/document-rules.js` (`DocumentRulesPlugin`), mirroring the existing `app/src/plugins/inference-settings.js` pattern almost exactly: a dynamically-rebuilt Tools-menu submenu (`sl-menu[slot="submenu"]` refreshed on the parent item's `mouseenter`, de-duplicated in-flight-fetch guard) plus a second plain Tools-menu item, both registered under a new `'document-rules'` category via the existing `ToolsPlugin.addMenuItems()`. Clicking a submenu entry opens one shared `sl-dialog` (new template `document-rules-editor-dialog.html`) whose body swaps between an Edit/Preview tab pair (`sl-tab-group`, `markdown-it` via the existing `createMarkdownRenderer()`) for markdown/text resources and a single read-only/editable CodeMirror `EditorView` (built from the same `@codemirror/*` primitives `app/src/modules/xmleditor.js` already uses, since no reusable standalone CodeMirror wrapper exists yet) for the one `xml`-format resource (the schema). No new dependencies. `sl-tab-group`/`sl-tab`/`sl-tab-panel` are added to the app's Shoelace import surface for the first time (Task 1).

**Tech Stack:** Vanilla JS class-based plugin (`Plugin` base class), Shoelace web components, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/lang-xml`, `@codemirror/commands`), `markdown-it` (via `app/src/modules/markdown-utils.js`), Node's built-in `node:test` for frontend unit tests, Playwright for E2E.

---

## Important context for every task below

- **Field/method naming convention — public-underscore, not true-private.** `app/src/plugins/inference-settings.js` is the established precedent for a dynamically-populated Tools-menu submenu, and it deliberately uses single-underscore-prefixed **public** fields/methods (`_providers`, `_submenu`, `_refresh()`, `_populateSubmenu()`, `_onSelect()`, …) rather than true `#private` ones, specifically so its own unit test file (`tests/unit/js/inference-settings.test.js`) can set/read/call them directly without going through the full plugin lifecycle. `DocumentRulesPlugin` MUST follow the same convention for every field/method the Task 7 unit tests need to touch. The only things that stay true `#private` are the dependency getters (`#client`, `#xmlEditor`, `#logger`) — exactly as in `inference-settings.js`, where `#client`/`#tools` are private but tests override `plugin.getDependency = (name) => {...}` instead of reaching into them.
- **`getDependency('client').apiClient` method names** (from the already-regenerated `app/src/modules/api-client-v1.js`, confirmed present at lines 1517-1615): `documentRulesList(body)`, `documentRulesQuery(body)`, `documentRulesOverrides(body)`, `documentRulesUpdateOverrides(overrideId, body)`, `documentRulesDeleteOverrides(overrideId)`, `documentRulesSelection(body)`, `documentRulesSelectionReset(body)`, `documentRulesRefreshPreview(body)`, `documentRulesRefreshExecute(body)`. Do not regenerate the client in this plan; it already matches Plans 1-4's backend.
- **Field-name gotcha in the request bodies** (verified against `fastapi_app/lib/models/models_document_rules.py`): `documentRulesList({ xml_string })` takes the **full XML content string** (same convention as `/validate`), but `documentRulesRefreshPreview({ xml })` / `documentRulesRefreshExecute({ xml })` take the document's **`stable_id`** (i.e. `state.xml` directly, never editor content) — the backend re-reads its own stored copy of the file for a refresh. Every other body field matches its name 1:1: `documentRulesQuery({ kind, url })`, `documentRulesOverrides({ kind, fragment_url, note, text })`, `documentRulesSelection({ kind, fragment_url, override_id })`, `documentRulesSelectionReset({ resources: [{kind, url}] })`.
- **Getting the current document's live XML text**: `this.getDependency('xmleditor').getView().state.doc.toString()` — this is what `app/src/plugins/tei-validation.js` (`#lintSource()`, calling `this.#client.validateXml(xml)`) already uses for the exact same "send the live, possibly-unsaved editor content to a backend discovery/validation endpoint" purpose that `documentRulesList()` now needs. Do NOT use `getXML()` (re-serializes the last-synced DOM, can silently normalize in-progress malformed edits) and do NOT use `state.xml` for this call (that's the stable_id, wrong type entirely — it's only correct for the two refresh endpoints, see above).
- **Reloading the editor after a refresh actually changes the file on disk**: `await this.getDependency('services').load({ xml: state.xml })` — `ServicesPlugin.load()` (`app/src/plugins/services.js:132`) always re-fetches `/api/files/{xml}` and reloads the editor regardless of whether `state.xml` itself changed (comment at services.js: "Always load XML content and update state"), and this exact call is already used elsewhere in the codebase (`document-actions.js`'s `deleteCurrentVersion()`/`deleteAllVersions()`) to bring the editor current after a server-side file mutation.
- **Role check**: no existing `userIsReviewerOrAdmin()` helper — use `userHasRole(user, ['reviewer', 'admin'])` from `app/src/modules/acl-utils.js` (array form is OR logic; also correctly grants access to a wildcard `'*'` role).
- **`.types.js` files are auto-generated — never hand-write them.** Every task below that creates or changes a `.html` template ends with `node scripts/build/generate-ui-types.js` (equivalently `npm run build:ui-types`). The plan states the exact expected generated content so you can verify the generator's output, but you must run the generator, not copy that content into a file by hand.
- **`app/CLAUDE.md` rules that apply throughout**: never use `querySelector`/`querySelectorAll` to reach UI elements (use the `ui` navigation object / the object returned by `this.createUi()`); every extension-point handler method needs the required JSDoc phrasing (not needed here — this plugin uses no `static extensionPoints`, only `install`/`start`/`on<Key>Change`, all auto-discovered); `static extensionPoints = [...]` needs a trailing semicolon (not applicable here, but keep in mind if a later plan adds one); templates are registered with `await registerTemplate(...)` at module level, elements created with `createSingleFromTemplate(...)` in `install()`/`start()`.

---

### Task 1: Add `sl-tab-group`/`sl-tab`/`sl-tab-panel` to the app's Shoelace surface

**Files:**
- Modify: `app/src/ui.js`
- Modify: `scripts/build/generate-ui-types.js`

No existing template in this codebase uses Shoelace tabs (confirmed: zero `sl-tab` hits under `app/src/templates/`), so neither the import surface nor the type generator recognizes the tag yet. Both need one entry each before Task 2's dialog template can use tabs with proper typing.

- [ ] **Step 1: Add the three tab components to the Shoelace import/export block in `app/src/ui.js`**

Find the existing Shoelace component import block (it currently ends with the imports feeding `SlSplitPanel, SlBadge` — confirmed present at `app/src/ui.js` lines 17-39). Add these three lines to that same block, keeping the existing one-import-per-component style used by every other entry there:

```js
import SlTabGroup from '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js'
import SlTab from '@shoelace-style/shoelace/dist/components/tab/tab.js'
import SlTabPanel from '@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js'
```

Add the same three names to the file's re-export list (wherever the existing `SlSplitPanel, SlBadge, ...` names are re-exported alongside the other Shoelace classes) so `import { SlTabGroup } from '../ui.js'` works the same way `import { SlDialog } from '../ui.js'` already does elsewhere in the app.

- [ ] **Step 2: Add the three tags to `TAG_TYPE_MAP` in the UI type generator**

In `scripts/build/generate-ui-types.js`, find `TAG_TYPE_MAP` (starts at line 19). Add these three entries, keeping the existing alphabetical-ish grouping style (after the `sl-split-panel` entry is a reasonable spot):

```js
  'sl-tab-group': 'SlTabGroup',
  'sl-tab': 'SlTab',
  'sl-tab-panel': 'SlTabPanel',
```

Without this, Task 2's dialog template would still generate valid types, just with the less-specific `HTMLElement` for tab elements instead of `SlTabGroup`/`SlTab`/`SlTabPanel`.

- [ ] **Step 3: Verify the app still boots with no console errors**

This step only changes an import surface and a codegen map; no runtime behavior changes yet. Run:

```bash
node -e "import('./app/src/ui.js').then(() => console.log('ui.js imports OK')).catch(e => { console.error(e); process.exit(1) })"
```

Expected: `ui.js imports OK` (this project's importmap makes `@shoelace-style/shoelace` resolve under Node the same way it does in the browser; if this fails, check the importmap entry for `tab-group`/`tab`/`tab-panel` exists under `app/web/importmap.json` the same way `split-panel`/`badge` already do — Shoelace ships these as standard components, so no importmap change should actually be needed).

- [ ] **Step 4: Commit**

```bash
git add app/src/ui.js scripts/build/generate-ui-types.js
git commit -m "feat(doc-rules): add sl-tab-group/sl-tab/sl-tab-panel to the UI surface"
```

---

### Task 2: Templates — menu items and the resource editor dialog

**Files:**
- Create: `app/src/templates/document-rules-menu-item.html`
- Create: `app/src/templates/document-rules-refresh-menu-item.html`
- Create: `app/src/templates/document-rules-editor-dialog.html`
- Generated (do not hand-write): `app/src/templates/document-rules-menu-item.types.js`, `app/src/templates/document-rules-editor-dialog.types.js`
- Modify: `app/src/ui.js`

- [ ] **Step 1: Create the "Edit prompts/schemas" submenu-parent template**

```html
<sl-menu-item name="documentRulesEditMenuItem">
  <sl-icon slot="prefix" name="pencil-square"></sl-icon>
  Edit prompts/schemas
  <sl-menu name="documentRulesEditSubmenu" slot="submenu"></sl-menu>
</sl-menu-item>
```

Save as `app/src/templates/document-rules-menu-item.html`.

- [ ] **Step 2: Create the "Refresh document rules" plain-item template**

```html
<sl-menu-item name="documentRulesRefreshMenuItem">
  <sl-icon slot="prefix" name="arrow-clockwise"></sl-icon>
  Refresh document rules
</sl-menu-item>
```

Save as `app/src/templates/document-rules-refresh-menu-item.html`. This one has no named descendants, so the generator will produce no `.types.js` file for it (same as `config-editor-menu-item.html`, which also has none) — type it as plain `HTMLElement` in the plugin.

- [ ] **Step 3: Create the resource editor dialog template**

```html
<sl-dialog name="documentRulesEditorDialog" label="Resource" style="--width: 70vw;">
  <div name="overrideRow" style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;"></div>

  <sl-input name="noteInput" placeholder="Note describing what this override changes" size="small" style="display: none; margin-bottom: 0.75rem;"></sl-input>

  <div name="textBody" style="display: none;">
    <sl-tab-group name="textTabs">
      <sl-tab slot="nav" panel="edit" name="editTab">Edit</sl-tab>
      <sl-tab slot="nav" panel="preview" name="previewTab">Preview</sl-tab>
      <sl-tab-panel name="editPanel" panel="edit">
        <sl-textarea name="textArea" rows="16" resize="vertical"></sl-textarea>
      </sl-tab-panel>
      <sl-tab-panel name="previewPanel" panel="preview">
        <div name="previewContent" class="markdown-body"></div>
      </sl-tab-panel>
    </sl-tab-group>
  </div>

  <div name="xmlBody" style="display: none;">
    <div name="xmlContainer" style="border: 1px solid var(--sl-color-neutral-300); height: 400px; overflow: auto;"></div>
  </div>

  <div slot="footer" style="display: flex; justify-content: flex-end; gap: 0.5rem; width: 100%;">
    <sl-button name="newOverrideBtn" size="small">New override</sl-button>
    <sl-button name="saveBtn" size="small" variant="primary" style="display: none;">Save</sl-button>
    <sl-button name="deleteBtn" size="small" variant="danger" style="display: none;">Delete override</sl-button>
    <sl-button name="resetBtn" size="small" style="display: none;">Reset to original</sl-button>
    <sl-button name="closeBtn" size="small">Close</sl-button>
  </div>
</sl-dialog>
```

Save as `app/src/templates/document-rules-editor-dialog.html`.

- [ ] **Step 4: Run the type generator**

```bash
node scripts/build/generate-ui-types.js
```

Expected output includes both new `.types.js` files. `document-rules-menu-item.types.js` should contain exactly:

```js
// AUTO-GENERATED from document-rules-menu-item.html — do not edit
// Regenerate with: npm run build:ui-types

/**
 * @typedef {object} documentRulesEditMenuItemPart
 * @property {import('../ui.js').SlMenu} documentRulesEditSubmenu
 */

export {}
```

`document-rules-editor-dialog.types.js` should contain (nested typedefs for `textBody`, `textTabs`, `editPanel`, `previewPanel`, `xmlBody`, matching how `overrideRow`/`newOverrideBtn`/etc. are flat because the wrapping footer `<div slot="footer">` is unnamed and the generator recurses straight through it, per `namedDescendants()`):

```js
// AUTO-GENERATED from document-rules-editor-dialog.html — do not edit
// Regenerate with: npm run build:ui-types

/**
 * @typedef {object} documentRulesEditorDialogPart
 * @property {HTMLDivElement} overrideRow
 * @property {import('../ui.js').SlInput} noteInput
 * @property {HTMLDivElement & textBodyPart} textBody
 * @property {HTMLDivElement & xmlBodyPart} xmlBody
 * @property {import('../ui.js').SlButton} newOverrideBtn
 * @property {import('../ui.js').SlButton} saveBtn
 * @property {import('../ui.js').SlButton} deleteBtn
 * @property {import('../ui.js').SlButton} resetBtn
 * @property {import('../ui.js').SlButton} closeBtn
 */

/**
 * @typedef {object} textBodyPart
 * @property {import('../ui.js').SlTabGroup & textTabsPart} textTabs
 */

/**
 * @typedef {object} textTabsPart
 * @property {import('../ui.js').SlTab} editTab
 * @property {import('../ui.js').SlTab} previewTab
 * @property {import('../ui.js').SlTabPanel & editPanelPart} editPanel
 * @property {import('../ui.js').SlTabPanel & previewPanelPart} previewPanel
 */

/**
 * @typedef {object} editPanelPart
 * @property {import('../ui.js').SlTextarea} textArea
 */

/**
 * @typedef {object} previewPanelPart
 * @property {HTMLDivElement} previewContent
 */

/**
 * @typedef {object} xmlBodyPart
 * @property {HTMLDivElement} xmlContainer
 */

export {}
```

If the generator's actual output differs in field order or exact wording, trust the generator's real output over this transcription (it is deterministic from the HTML) — but the *set* of properties and the nesting shape must match, since Task 3-6's plugin code addresses these exact paths (`dialogUi.textBody.textTabs.editPanel.textArea`, etc.).

- [ ] **Step 5: Register the dialog (a body-level element) in `app/src/ui.js`**

The two menu-item templates are never attached to `document.body` directly (they're inserted into the Tools dropdown's existing `sl-menu` at runtime by `ToolsPlugin.addMenuItems()`, the same way `config-editor.js`'s own menu item is — and that one has no `ui.js` entry either), so they need no `ui.js` change. The dialog *is* appended to `document.body` in Task 3's `install()`, so it needs the same treatment as `configEditorDialog`:

Add to the `@import` JSDoc block near the top of `app/src/ui.js` (alongside the existing `@import {configEditorDialogPart} from './plugins/config-editor.js'`-style lines):

```js
 * @import {documentRulesEditorDialogPart} from './templates/document-rules-editor-dialog.types.js'
```

Add to the `namedElementsTree` typedef (alongside the existing optional dialog properties like `configEditorDialog`, `pluginAdminDialog`):

```js
 * @property {UIPart<SlDialog, documentRulesEditorDialogPart>} [documentRulesEditorDialog] - Document rules resource editor dialog (added by document-rules plugin)
```

- [ ] **Step 6: Commit**

```bash
git add app/src/templates/document-rules-menu-item.html app/src/templates/document-rules-menu-item.types.js \
        app/src/templates/document-rules-refresh-menu-item.html \
        app/src/templates/document-rules-editor-dialog.html app/src/templates/document-rules-editor-dialog.types.js \
        app/src/ui.js
git commit -m "feat(doc-rules): add Tools-menu item and resource editor dialog templates"
```

---

### Task 3: Plugin skeleton — Tools-menu registration and the dynamic "Edit prompts/schemas" submenu

**Files:**
- Create: `app/src/plugins/document-rules.js`
- Modify: `app/src/plugin-registry.js`
- Modify: `app/src/plugins.js`

- [ ] **Step 1: Create the plugin file with the skeleton, menu registration, and resource discovery**

```js
/**
 * Document Rules Plugin
 *
 * Provides two Tools-menu entries under the "document-rules" category:
 * - "Edit prompts/schemas": a dynamically populated submenu, one entry per
 *   resource (editorialDecl/interpretation entries + the document's schema)
 *   the currently open document references (POST /document-rules/list).
 *   Clicking an entry opens a shared per-resource editor dialog for
 *   switching between the original and the user's own overrides.
 * - "Refresh document rules" (reviewer/admin only): regenerates both halves
 *   of what governs a document - the interpretation-ref entries and the
 *   schema PI - via a preview-then-confirm-then-execute flow against
 *   POST /document-rules/refresh/{preview,execute}.
 *
 * Mirrors app/src/plugins/inference-settings.js's dynamic-Tools-submenu
 * pattern closely, including its field-naming convention (single-underscore
 * public fields/methods, not true #private ones, so this plugin's own unit
 * tests can reach them directly - see that file's module doc-comment).
 *
 * See docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
 * ("Frontend design").
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlMenuItem, SlDialog } from '../ui.js'
 * @import { documentRulesEditMenuItemPart } from '../templates/document-rules-menu-item.types.js'
 * @import { documentRulesEditorDialogPart } from '../templates/document-rules-editor-dialog.types.js'
 * @import { ResourceDescriptorModel, OverrideModel } from '../modules/api-client-v1.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { userHasRole } from '../modules/acl-utils.js'

// Register templates at module level
await registerTemplate('document-rules-menu-item', 'document-rules-menu-item.html')
await registerTemplate('document-rules-refresh-menu-item', 'document-rules-refresh-menu-item.html')
await registerTemplate('document-rules-editor-dialog', 'document-rules-editor-dialog.html')

class DocumentRulesPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'document-rules', deps: ['client', 'tools', 'xmleditor', 'dialog', 'services', 'logger'] })
  }

  get #client() { return this.getDependency('client') }
  get #xmlEditor() { return this.getDependency('xmleditor') }
  get #logger() { return this.getDependency('logger') }

  /** @type {SlMenuItem & documentRulesEditMenuItemPart} */
  _editMenuItem = null

  /** @type {HTMLElement} */
  _refreshMenuItem = null

  /** @type {SlDialog & documentRulesEditorDialogPart} */
  _editorDialogUi = null

  /**
   * Last successful POST /document-rules/list result for the open document.
   * @type {Array<ResourceDescriptorModel>}
   */
  _resources = []

  /** @type {Promise<void>|null} */
  _refreshPromise = null

  /** @type {boolean} */
  _refreshQueued = false

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.#logger.debug('Installing plugin "document-rules"')

    const dialog = createSingleFromTemplate('document-rules-editor-dialog', document.body)
    this._editorDialogUi = this.createUi(dialog)
    this._editorDialogUi.closeBtn.addEventListener('click', () => this._editorDialogUi.hide())
  }

  async start() {
    this.#logger.debug('Starting plugin "document-rules"')

    this._editMenuItem = this.createUi(createSingleFromTemplate('document-rules-menu-item'))
    this._refreshMenuItem = createSingleFromTemplate('document-rules-refresh-menu-item')

    this._editMenuItem.addEventListener('mouseenter', () => this._refreshResources())
    this._refreshMenuItem.addEventListener('click', () => this._onRefreshDocumentRules())

    this.getDependency('tools').addMenuItems([this._editMenuItem, this._refreshMenuItem], 'document-rules')

    this._refreshMenuItem.style.display = userHasRole(this.state.user, ['reviewer', 'admin']) ? '' : 'none'
    this._refreshResources()
  }

  /** Rebuild resource discovery when the open document changes. */
  onXmlChange() {
    if (this._editorDialogUi.open) this._editorDialogUi.hide()
    this._refreshResources()
  }

  /**
   * Show/hide the reviewer/admin-gated "Refresh document rules" item.
   * @param {any} newUser
   */
  onUserChange(newUser) {
    this._refreshMenuItem.style.display = userHasRole(newUser, ['reviewer', 'admin']) ? '' : 'none'
  }

  /**
   * Re-fetch the open document's resource list, de-duplicating concurrent
   * calls the same way inference-settings.js's _refresh() does: a call that
   * arrives while a fetch is already in flight joins that promise instead of
   * starting a second one, but marks _refreshQueued so one trailing refresh
   * fires once the in-flight fetch settles.
   * @returns {Promise<void>}
   */
  async _refreshResources() {
    if (this._refreshPromise) {
      this._refreshQueued = true
      return this._refreshPromise
    }
    this._refreshPromise = this.#doRefreshResources()
    try {
      await this._refreshPromise
    } finally {
      this._refreshPromise = null
      if (this._refreshQueued) {
        this._refreshQueued = false
        this._refreshResources()
      }
    }
  }

  /**
   * Does the actual fetch/rebuild work for _refreshResources(). Hides the
   * parent item entirely when no document is open; shows it disabled when a
   * document is open but references no resources; shows it enabled with a
   * populated submenu otherwise.
   * @returns {Promise<void>}
   */
  async #doRefreshResources() {
    const state = this.state
    if (!state.xml) {
      this._resources = []
      this._editMenuItem.style.display = 'none'
      return
    }

    let xmlString = null
    try {
      const view = this.#xmlEditor.getView()
      xmlString = view ? view.state.doc.toString() : null
    } catch (error) {
      this.#logger.warn('document-rules: could not read editor content: ' + String(error))
    }

    if (!xmlString) {
      this._resources = []
      this._editMenuItem.style.display = 'none'
      return
    }

    try {
      const response = await this.#client.apiClient.documentRulesList({ xml_string: xmlString })
      this._resources = response.resources
    } catch (error) {
      this.#logger.warn('document-rules: could not list document resources: ' + String(error))
      this._resources = []
    }

    this._editMenuItem.style.display = ''
    this._editMenuItem.disabled = this._resources.length === 0
    this._populateSubmenu()
  }

  /** Rebuild the submenu's sl-menu-item children from `_resources`. */
  _populateSubmenu() {
    const submenu = this._editMenuItem.documentRulesEditSubmenu
    submenu.innerHTML = ''
    for (const resource of this._resources) {
      const item = document.createElement('sl-menu-item')
      item.textContent = resource.label
      item.dataset.kind = resource.kind
      item.dataset.url = resource.url
      item.addEventListener('click', () => this._openResourceEditor(resource))
      submenu.appendChild(item)
    }
  }
}

export default DocumentRulesPlugin
```

Note: `_onRefreshDocumentRules()` and `_openResourceEditor()` are called here but defined in Tasks 4 and 5 respectively — this task's own verification step only checks the menu/submenu wiring, not those two methods' bodies (they'll exist as stubs raising or no-ops until then; to keep this task's own tests green without forward-referencing later tasks' code, add temporary minimal stub methods now and let Tasks 4/5 replace them):

```js
  /** @param {ResourceDescriptorModel} _resource */
  async _openResourceEditor(_resource) { /* replaced in Task 5 */ }

  async _onRefreshDocumentRules() { /* replaced in Task 4 */ }
```

Add these two stub methods to the class body (anywhere after `_populateSubmenu`).

- [ ] **Step 2: Register the plugin in `app/src/plugin-registry.js`**

Add, alphabetically after the existing `DocumentActionsPlugin` line:

```js
export { default as DocumentRulesPlugin } from './plugins/document-rules.js';
```

- [ ] **Step 3: Register the plugin in `app/src/plugins.js`**

Add `DocumentRulesPlugin` to the destructured import list from `./plugin-registry.js` (alphabetically, after `DocumentActionsPlugin`), and add it to the `plugins` array right after `InferenceSettingsPlugin` (which is itself right after `ToolsPlugin` in that array):

```js
  ToolsPlugin,
  InferenceSettingsPlugin, // Tools menu — Inference section (default LLM model picker)
  DocumentRulesPlugin,     // Tools menu — Document rules section (edit prompts/schemas, refresh)
  TeiWizardPlugin,
```

- [ ] **Step 4: Manual smoke check**

Since `app/CLAUDE.md` forbids rebuilding/restarting the dev server for frontend changes (source files load directly), just confirm the app still boots: open the app in a browser (or ask the user to, if no instance is running) and check the browser console for import/registration errors. There should be no visible menu items yet with meaningful behavior beyond "Edit prompts/schemas" appearing under a new "Document Rules" Tools-menu section — hidden when no document is open, since `_editMenuItem.style.display` starts `'none'` until `_refreshResources()` resolves.

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/document-rules.js app/src/plugin-registry.js app/src/plugins.js
git commit -m "feat(doc-rules): add DocumentRulesPlugin with the dynamic edit-resources submenu"
```

---

### Task 4: "Refresh document rules" action

**Files:**
- Modify: `app/src/plugins/document-rules.js`

- [ ] **Step 1: Replace the Task 3 stub with the real preview→confirm→execute→reload flow**

Replace the `_onRefreshDocumentRules()` stub added in Task 3 with:

```js
  /**
   * Preview, confirm, then execute a "Refresh document rules" pass on the
   * open document, reloading the editor from the server afterwards if
   * anything actually changed (services.load() always re-fetches the file
   * regardless of whether state.xml itself changed - see this plan's
   * "Important context" section).
   * @returns {Promise<void>}
   */
  async _onRefreshDocumentRules() {
    const state = this.state
    if (!state.xml) {
      notify('No document is open.', 'warning', 'exclamation-triangle')
      return
    }

    const dialog = this.getDependency('dialog')

    let preview
    try {
      preview = await this.#client.apiClient.documentRulesRefreshPreview({ xml: state.xml })
    } catch (error) {
      notify(`Could not preview the refresh: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }

    if (!preview.available) {
      notify(preview.message, 'warning', 'exclamation-triangle')
      return
    }

    const confirmed = await dialog.confirm(preview.message, 'Refresh document rules?')
    if (!confirmed) return

    let outcome
    try {
      outcome = await this.#client.apiClient.documentRulesRefreshExecute({ xml: state.xml })
    } catch (error) {
      notify(`Could not refresh document rules: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }

    if (outcome.changed) {
      await this.getDependency('services').load({ xml: state.xml })
    }
    notify(outcome.message, outcome.changed ? 'success' : 'primary', 'check-circle')
  }
```

- [ ] **Step 2: Manual smoke check**

With a reviewer/admin account, open a document that has an `appInfo/application[@type="extractor"]` block (any real extracted document qualifies), click Tools → Document Rules → "Refresh document rules", confirm the dialog, and check the toast + that the editor content reloads if anything changed. With a non-reviewer/non-admin account, confirm the item is hidden entirely (per `onUserChange`/the initial `start()` visibility check).

- [ ] **Step 3: Commit**

```bash
git add app/src/plugins/document-rules.js
git commit -m "feat(doc-rules): wire the Refresh document rules preview/confirm/execute flow"
```

---

### Task 5: Resource editor dialog — override row, note, CRUD, markdown/text body

**Files:**
- Modify: `app/src/plugins/document-rules.js`

- [ ] **Step 1: Add the markdown renderer and per-resource dialog state**

Add this import:

```js
import { createMarkdownRenderer } from '../modules/markdown-utils.js'
```

Add these fields to the class body (alongside the Task 3 fields):

```js
  /** @type {ReturnType<typeof createMarkdownRenderer>} */
  _md = null

  /** Resource descriptor the dialog currently shows, or null if closed. @type {ResourceDescriptorModel|null} */
  _currentResource = null

  /** @type {Array<OverrideModel>} */
  _currentOverrides = []

  /** Selected override id, or null when "Original" is selected. @type {string|null} */
  _currentSelectedId = null

  /** @type {string} */
  _currentOriginalText = ''
```

In `install()`, right after `this._editorDialogUi = this.createUi(dialog)`, initialize the renderer and wire the preview-tab refresh and the four remaining footer buttons (`closeBtn` was already wired in Task 3):

```js
    this._md = createMarkdownRenderer()

    this._editorDialogUi.newOverrideBtn.addEventListener('click', () => this._onNewOverride())
    this._editorDialogUi.saveBtn.addEventListener('click', () => this._onSave())
    this._editorDialogUi.deleteBtn.addEventListener('click', () => this._onDelete())
    this._editorDialogUi.resetBtn.addEventListener('click', () => this._onReset())
    this._editorDialogUi.textBody.textTabs.addEventListener('sl-tab-show', (event) => {
      if (/** @type {CustomEvent} */(event).detail.name === 'preview') {
        const text = this._editorDialogUi.textBody.textTabs.editPanel.textArea.value
        this._editorDialogUi.textBody.textTabs.previewPanel.previewContent.innerHTML = this._md.render(text)
      }
    })
```

- [ ] **Step 2: Replace the Task 3 `_openResourceEditor` stub**

```js
  /**
   * Query one resource's original text, overrides, and current selection,
   * then render and show the editor dialog for it.
   * @param {ResourceDescriptorModel} resource
   * @returns {Promise<void>}
   */
  async _openResourceEditor(resource) {
    let response
    try {
      response = await this.#client.apiClient.documentRulesQuery({ kind: resource.kind, url: resource.url })
    } catch (error) {
      notify(`Could not load resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentResource = resource
    this._currentOverrides = response.overrides
    this._currentSelectedId = response.selected_override_id
    this._currentOriginalText = response.original_text
    this._renderEditorDialog()
    this._editorDialogUi.show()
  }
```

- [ ] **Step 3: Add the render/selection/CRUD methods**

```js
  /**
   * Read the text currently displayed in whichever body is active (the
   * source of truth for New override/Save, before it's persisted).
   * @returns {string}
   */
  _currentShownText() {
    if (this._currentResource.format === 'xml') {
      return this._currentXmlText()
    }
    return this._editorDialogUi.textBody.textTabs.editPanel.textArea.value
  }

  /** Full re-render of the dialog for `_currentResource`/`_currentOverrides`/`_currentSelectedId`. */
  _renderEditorDialog() {
    const resource = this._currentResource
    const dialogUi = this._editorDialogUi
    dialogUi.setAttribute('label', resource.label)
    this._renderOverrideRow()

    const selected = this._currentOverrides.find(o => o.id === this._currentSelectedId) ?? null
    dialogUi.noteInput.style.display = selected ? '' : 'none'
    dialogUi.noteInput.value = selected ? selected.note : ''

    const text = selected ? selected.text : this._currentOriginalText
    const readOnly = selected === null

    if (resource.format === 'xml') {
      dialogUi.textBody.style.display = 'none'
      dialogUi.xmlBody.style.display = ''
      this._setXmlContent(text, readOnly)
    } else {
      dialogUi.xmlBody.style.display = 'none'
      dialogUi.textBody.style.display = ''
      dialogUi.textBody.textTabs.editPanel.textArea.value = text
      dialogUi.textBody.textTabs.editPanel.textArea.readonly = readOnly
      dialogUi.textBody.textTabs.previewPanel.previewContent.innerHTML = this._md.render(text)
    }

    dialogUi.saveBtn.style.display = selected ? '' : 'none'
    dialogUi.deleteBtn.style.display = selected ? '' : 'none'
    dialogUi.resetBtn.style.display = selected ? '' : 'none'
  }

  /** Rebuild the "Original"/"Override N" button row. */
  _renderOverrideRow() {
    const row = this._editorDialogUi.overrideRow
    row.innerHTML = ''

    const originalBtn = document.createElement('sl-button')
    originalBtn.setAttribute('size', 'small')
    originalBtn.textContent = 'Original'
    originalBtn.variant = this._currentSelectedId === null ? 'primary' : 'default'
    originalBtn.addEventListener('click', () => this._selectOverride(null))
    row.appendChild(originalBtn)

    this._currentOverrides.forEach((override, index) => {
      const btn = document.createElement('sl-button')
      btn.setAttribute('size', 'small')
      btn.textContent = `Override ${index + 1}`
      btn.variant = this._currentSelectedId === override.id ? 'primary' : 'default'
      if (override.note) btn.title = override.note
      btn.addEventListener('click', () => this._selectOverride(override.id))
      row.appendChild(btn)
    })
  }

  /**
   * Select the original (null) or one override for `_currentResource`,
   * persisting the choice immediately - per the spec, clicking a row entry
   * "uses it immediately", it is not a staged/unsaved choice.
   * @param {string|null} overrideId
   * @returns {Promise<void>}
   */
  async _selectOverride(overrideId) {
    if (overrideId === this._currentSelectedId) return
    try {
      await this.#client.apiClient.documentRulesSelection({
        kind: this._currentResource.kind,
        fragment_url: this._currentResource.url,
        override_id: overrideId
      })
    } catch (error) {
      notify(`Could not change selection: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentSelectedId = overrideId
    this._renderEditorDialog()
  }

  /** Copy the currently shown text into a new override and select it. */
  async _onNewOverride() {
    const text = this._currentShownText()
    let override
    try {
      override = await this.#client.apiClient.documentRulesOverrides({
        kind: this._currentResource.kind,
        fragment_url: this._currentResource.url,
        note: '',
        text
      })
    } catch (error) {
      notify(`Could not create override: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentOverrides.push(override)
    await this._selectOverride(override.id)
  }

  /** Persist the currently selected override's note + shown text. */
  async _onSave() {
    if (this._currentSelectedId === null) return
    const note = this._editorDialogUi.noteInput.value
    const text = this._currentShownText()
    let updated
    try {
      updated = await this.#client.apiClient.documentRulesUpdateOverrides(this._currentSelectedId, { note, text })
    } catch (error) {
      notify(`Could not save override: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    const index = this._currentOverrides.findIndex(o => o.id === updated.id)
    if (index !== -1) this._currentOverrides[index] = updated
    notify('Override saved.', 'success', 'check-circle')
  }

  /** Delete the currently selected override (owner-only, enforced server-side). */
  async _onDelete() {
    if (this._currentSelectedId === null) return
    const confirmed = await this.getDependency('dialog').confirm('Delete this override? This cannot be undone.', 'Delete override')
    if (!confirmed) return
    const id = this._currentSelectedId
    try {
      await this.#client.apiClient.documentRulesDeleteOverrides(id)
    } catch (error) {
      notify(`Could not delete override: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentOverrides = this._currentOverrides.filter(o => o.id !== id)
    this._currentSelectedId = null
    this._renderEditorDialog()
  }

  /** Clear the selection for this resource (keeps all overrides). */
  async _onReset() {
    if (this._currentSelectedId === null) return
    try {
      await this.#client.apiClient.documentRulesSelection({
        kind: this._currentResource.kind,
        fragment_url: this._currentResource.url,
        override_id: null
      })
    } catch (error) {
      notify(`Could not reset selection: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentSelectedId = null
    this._renderEditorDialog()
  }
```

`_setXmlContent()` and `_currentXmlText()` are called above but defined in Task 6 — add temporary stubs now so this task's own tests can run in isolation for non-xml resources:

```js
  /** @param {string} _text @param {boolean} _readOnly */
  _setXmlContent(_text, _readOnly) { /* replaced in Task 6 */ }

  /** @returns {string} */
  _currentXmlText() { return '' /* replaced in Task 6 */ }
```

- [ ] **Step 2: Manual smoke check**

Open a document with at least one `editorialDecl/interpretation` entry, click Tools → Document Rules → "Edit prompts/schemas" → an entry, confirm the dialog opens showing "Original" selected and its text in the Edit tab; switch to Preview and confirm rendered markdown appears; click "New override", edit the text, click Save, confirm the button row now shows "Override 1" selected; click "Reset to original", confirm it reverts; click back to "Override 1", click "Delete override" and confirm the confirmation dialog + deletion + reversion to "Original".

- [ ] **Step 3: Commit**

```bash
git add app/src/plugins/document-rules.js
git commit -m "feat(doc-rules): add the resource editor dialog (override row, CRUD, markdown/text body)"
```

---

### Task 6: Resource editor dialog — CodeMirror XML body (schema resources)

**Files:**
- Modify: `app/src/plugins/document-rules.js`

- [ ] **Step 1: Add the CodeMirror imports**

```js
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { xml } from '@codemirror/lang-xml'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { getTheme } from '../modules/codemirror/editor-themes.js'
```

- [ ] **Step 2: Add the CodeMirror instance fields**

```js
  /** @type {EditorView} */
  _cmView = null

  /** @type {Compartment} */
  _cmReadOnlyCompartment = new Compartment()
```

- [ ] **Step 3: Create the CodeMirror view once, in `install()`**

Add this right after the `this._md = createMarkdownRenderer()` line added in Task 5:

```js
    this._cmView = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          xml(),
          getTheme('default').extensions,
          this._cmReadOnlyCompartment.of([EditorView.editable.of(false)])
        ]
      }),
      parent: this._editorDialogUi.xmlBody.xmlContainer
    })
```

This mirrors `app/src/modules/xmleditor.js`'s own read-only-compartment pattern (`setReadOnly()`, lines 452-464): a `Compartment` reconfigured via `dispatch({ effects: [...] })` toggles `EditorView.editable.of(...)`, rather than recreating the whole `EditorState`.

- [ ] **Step 4: Replace the Task 5 `_setXmlContent`/`_currentXmlText` stubs**

```js
  /**
   * Replace the CodeMirror doc's full content and toggle its read-only
   * compartment - same reconfigure-in-place pattern as
   * app/src/modules/xmleditor.js's setReadOnly().
   * @param {string} text
   * @param {boolean} readOnly
   */
  _setXmlContent(text, readOnly) {
    this._cmView.dispatch({
      changes: { from: 0, to: this._cmView.state.doc.length, insert: text },
      effects: this._cmReadOnlyCompartment.reconfigure([EditorView.editable.of(!readOnly)])
    })
  }

  /** @returns {string} */
  _currentXmlText() {
    return this._cmView.state.doc.toString()
  }
```

- [ ] **Step 5: Manual smoke check**

Open a document with a schema PI, click Tools → Document Rules → "Edit prompts/schemas" → "Schema (RelaxNG)", confirm a read-only CodeMirror view shows the schema's XML with "Original" selected; click "New override", confirm the CodeMirror view becomes editable; type a change, click Save, click "Reset to original", confirm it reverts to read-only original content.

- [ ] **Step 6: Commit**

```bash
git add app/src/plugins/document-rules.js
git commit -m "feat(doc-rules): add the CodeMirror XML body for schema resources"
```

---

### Task 7: Frontend unit tests

**Files:**
- Create: `tests/unit/js/document-rules.test.js`

Follow `tests/unit/js/inference-settings.test.js`'s conventions exactly: same jsdom bootstrap boilerplate, same `notify()` module-mock pattern, same `makePlugin()` helper shape, same `flushMicrotasks()` helper, same style of overriding `plugin.getDependency` per-test.

- [ ] **Step 1: Write the test file**

```js
#!/usr/bin/env node

/**
 * Unit tests for the document-rules plugin (Edit prompts/schemas submenu,
 * resource editor dialog, Refresh document rules action).
 * @testCovers app/src/plugins/document-rules.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;

global.localStorage = (() => {
  const store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); }
  };
})();

const notifyCalls = [];
mock.module('../../../app/src/modules/sl-utils.js', {
  namedExports: {
    notify: (...args) => { notifyCalls.push(args); }
  }
});

const { default: PluginManager } = await import('../../../app/src/modules/plugin-manager.js');
const { default: StateManager } = await import('../../../app/src/modules/state-manager.js');
const { Application } = await import('../../../app/src/modules/application.js');
const { default: DocumentRulesPlugin } = await import('../../../app/src/plugins/document-rules.js');

/** @returns {InstanceType<typeof DocumentRulesPlugin>} */
function makePlugin() {
  const app = new Application(new PluginManager(), new StateManager());
  const ctx = app.getPluginContext();
  const plugin = new DocumentRulesPlugin(ctx);
  Object.defineProperty(plugin, 'state', { get: () => ({ xml: 'stable123', user: { username: 'u', roles: ['user'] } }), configurable: true });
  return plugin;
}

/**
 * A minimal stand-in for `_editorDialogUi` mirroring the exact nested shape
 * document-rules-editor-dialog.html's typedef produces (see Task 2 of
 * docs/superpowers/plans/2026-09-28-document-rules-frontend.md), so dialog
 * logic can be tested without going through install()'s real template/DOM
 * pipeline.
 * @returns {any}
 */
function makeDialogUi() {
  const el = document.createElement('div');
  el.overrideRow = document.createElement('div');
  el.noteInput = Object.assign(document.createElement('sl-input'), { value: '' });
  const editPanel = { textArea: Object.assign(document.createElement('sl-textarea'), { value: '', readonly: false }) };
  const previewPanel = { previewContent: document.createElement('div') };
  const textTabs = Object.assign(document.createElement('sl-tab-group'), { editPanel, previewPanel });
  el.textBody = Object.assign(document.createElement('div'), { textTabs });
  el.xmlBody = Object.assign(document.createElement('div'), { xmlContainer: document.createElement('div') });
  el.newOverrideBtn = document.createElement('sl-button');
  el.saveBtn = document.createElement('sl-button');
  el.deleteBtn = document.createElement('sl-button');
  el.resetBtn = document.createElement('sl-button');
  el.closeBtn = document.createElement('sl-button');
  el.open = false;
  return el;
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => { global.localStorage.clear(); notifyCalls.length = 0; });

describe('DocumentRulesPlugin construction', () => {
  it('has the expected name and dependencies', () => {
    const plugin = makePlugin();
    assert.strictEqual(plugin.name, 'document-rules');
    assert.deepStrictEqual(plugin.deps, ['client', 'tools', 'xmleditor', 'dialog', 'services', 'logger']);
  });
});

describe('DocumentRulesPlugin._populateSubmenu', () => {
  it('renders one sl-menu-item per resource, with kind/url dataset attributes', () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin._resources = [
      { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'Data correction', format: 'markdown' },
      { kind: 'schema', url: 'https://example.com/s.rng', key: 's', label: 'Schema (RelaxNG)', format: 'xml' },
    ];
    plugin._populateSubmenu();
    const items = [...plugin._editMenuItem.documentRulesEditSubmenu.children];
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].textContent, 'Data correction');
    assert.strictEqual(items[0].dataset.kind, 'interpretation-ref');
    assert.strictEqual(items[1].textContent, 'Schema (RelaxNG)');
  });

  it('clears previous contents on repeated calls', () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin._resources = [{ kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' }];
    plugin._populateSubmenu();
    plugin._populateSubmenu();
    assert.strictEqual(plugin._editMenuItem.documentRulesEditSubmenu.children.length, 1);
  });

  it('clicking an item opens the resource editor for it', () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { documentRulesEditSubmenu: document.createElement('sl-menu') };
    const resource = { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' };
    plugin._resources = [resource];
    let opened;
    plugin._openResourceEditor = (r) => { opened = r; };
    plugin._populateSubmenu();
    plugin._editMenuItem.documentRulesEditSubmenu.querySelector('sl-menu-item').dispatchEvent(new dom.window.Event('click'));
    assert.deepStrictEqual(opened, resource);
  });
});

describe('DocumentRulesPlugin._selectOverride', () => {
  it('persists the selection and re-renders showing the override text', async () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [{ id: 'ov1', note: 'my note', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = null;
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesSelection: async (body) => { calls.push(body); } } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin._selectOverride('ov1');

    assert.deepStrictEqual(calls, [{ kind: 'interpretation-ref', fragment_url: 'https://example.com/a.md', override_id: 'ov1' }]);
    assert.strictEqual(plugin._currentSelectedId, 'ov1');
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value, 'override text');
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.readonly, false);
  });

  it('is a no-op when the target is already selected', async () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = { kind: 'schema', url: 'u', key: 'u', label: 'S', format: 'xml' };
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    let called = false;
    plugin.getDependency = () => { called = true; return { apiClient: {} }; };
    await plugin._selectOverride(null);
    assert.strictEqual(called, false);
  });

  it('selecting the original makes the text read-only', async () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin.getDependency = () => ({ apiClient: { documentRulesSelection: async () => {} } });

    await plugin._selectOverride(null);

    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value, 'original text');
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.readonly, true);
    assert.strictEqual(plugin._editorDialogUi.saveBtn.style.display, 'none');
    assert.strictEqual(plugin._editorDialogUi.noteInput.style.display, 'none');
  });
});

describe('DocumentRulesPlugin format-based body swap', () => {
  it('shows the text body and hides the xml body for a markdown resource', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.textBody.style.display, '');
    assert.strictEqual(plugin._editorDialogUi.xmlBody.style.display, 'none');
  });

  it('shows the xml body and hides the text body for a schema resource', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    let setContentArgs;
    plugin._setXmlContent = (...args) => { setContentArgs = args; };
    plugin._currentResource = { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' };
    plugin._currentOriginalText = '<grammar/>';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.textBody.style.display, 'none');
    assert.strictEqual(plugin._editorDialogUi.xmlBody.style.display, '');
    assert.deepStrictEqual(setContentArgs, ['<grammar/>', true]);
  });

  it('renders a markdown preview of the current text on the preview tab', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = '# Heading';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._md = { render: (text) => `<h1>${text.replace('# ', '')}</h1>` };
    plugin._renderEditorDialog();
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.previewPanel.previewContent.innerHTML, '<h1>Heading</h1>');
  });
});

describe('DocumentRulesPlugin._onNewOverride/_onSave/_onDelete/_onReset', () => {
  function setup() {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._currentResource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original text';
    plugin._currentOverrides = [];
    plugin._currentSelectedId = null;
    plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value = 'original text';
    return plugin;
  }

  it('_onNewOverride creates an override from the shown text and selects it', async () => {
    const plugin = setup();
    const created = { id: 'ov1', note: '', text: 'original text', format: 'markdown', created_at: '', updated_at: '' };
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesOverrides: async (body) => { calls.push(body); return created; },
        documentRulesSelection: async () => {},
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onNewOverride();
    assert.deepStrictEqual(calls, [{ kind: 'interpretation-ref', fragment_url: 'https://example.com/a.md', note: '', text: 'original text' }]);
    assert.strictEqual(plugin._currentSelectedId, 'ov1');
    assert.deepStrictEqual(plugin._currentOverrides, [created]);
  });

  it('_onSave persists the note and shown text for the selected override', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: 'old note', text: 'old text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin._editorDialogUi.noteInput.value = 'new note';
    plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.value = 'new text';
    const updated = { id: 'ov1', note: 'new note', text: 'new text', format: 'markdown', created_at: '', updated_at: '' };
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesUpdateOverrides: async (id, body) => { calls.push([id, body]); return updated; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onSave();
    assert.deepStrictEqual(calls, [['ov1', { note: 'new note', text: 'new text' }]]);
    assert.deepStrictEqual(plugin._currentOverrides[0], updated);
  });

  it('_onSave is a no-op when Original is selected', async () => {
    const plugin = setup();
    let called = false;
    plugin.getDependency = () => { called = true; return { apiClient: {} }; };
    await plugin._onSave();
    assert.strictEqual(called, false);
  });

  it('_onDelete removes the override and reverts to Original after confirmation', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let deletedId;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'client') return { apiClient: { documentRulesDeleteOverrides: async (id) => { deletedId = id; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onDelete();
    assert.strictEqual(deletedId, 'ov1');
    assert.strictEqual(plugin._currentSelectedId, null);
    assert.deepStrictEqual(plugin._currentOverrides, []);
  });

  it('_onDelete does nothing when the confirmation is declined', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    let deleteCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => false };
      if (name === 'client') return { apiClient: { documentRulesDeleteOverrides: async () => { deleteCalled = true; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onDelete();
    assert.strictEqual(deleteCalled, false);
    assert.strictEqual(plugin._currentSelectedId, 'ov1');
  });

  it('_onReset clears the selection but keeps the overrides', async () => {
    const plugin = setup();
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'x', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesSelection: async (body) => { calls.push(body); } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onReset();
    assert.deepStrictEqual(calls, [{ kind: 'interpretation-ref', fragment_url: 'https://example.com/a.md', override_id: null }]);
    assert.strictEqual(plugin._currentSelectedId, null);
    assert.deepStrictEqual(plugin._currentOverrides.length, 1, 'override itself must not be deleted');
  });
});

describe('DocumentRulesPlugin.onUserChange / role gating', () => {
  it('hides the refresh menu item for a user without reviewer/admin role', () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin.onUserChange({ roles: ['user'] });
    assert.strictEqual(plugin._refreshMenuItem.style.display, 'none');
  });

  it('shows the refresh menu item for a reviewer', () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin.onUserChange({ roles: ['reviewer'] });
    assert.strictEqual(plugin._refreshMenuItem.style.display, '');
  });

  it('shows the refresh menu item for an admin', () => {
    const plugin = makePlugin();
    plugin._refreshMenuItem = document.createElement('sl-menu-item');
    plugin.onUserChange({ roles: ['admin'] });
    assert.strictEqual(plugin._refreshMenuItem.style.display, '');
  });
});

describe('DocumentRulesPlugin._onRefreshDocumentRules', () => {
  it('does nothing (with a warning toast) when no document is open', async () => {
    const plugin = makePlugin();
    Object.defineProperty(plugin, 'state', { get: () => ({ xml: null }), configurable: true });
    let previewCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { documentRulesRefreshPreview: async () => { previewCalled = true; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(previewCalled, false);
    assert.match(notifyCalls[0][0], /No document is open/);
  });

  it('shows the preview message and does not execute when nothing is available to refresh', async () => {
    const plugin = makePlugin();
    let executeCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: false, changed: false, entry_count: 0, variant_id: null, message: 'No rule-refresh provider for this document.' }),
        documentRulesRefreshExecute: async () => { executeCalled = true; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(executeCalled, false);
    assert.match(notifyCalls[0][0], /No rule-refresh provider/);
  });

  it('does not execute when the user declines the confirmation', async () => {
    const plugin = makePlugin();
    let executeCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => false };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: true, changed: true, entry_count: 2, variant_id: 'v', message: 'Would regenerate 2 entries.' }),
        documentRulesRefreshExecute: async () => { executeCalled = true; },
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(executeCalled, false);
  });

  it('executes and reloads the editor when confirmed and something changed', async () => {
    const plugin = makePlugin();
    let reloadedWith;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'services') return { load: async (opts) => { reloadedWith = opts; } };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: true, changed: true, entry_count: 2, variant_id: 'v', message: 'Would regenerate 2 entries.' }),
        documentRulesRefreshExecute: async () => ({ available: true, changed: true, entry_count: 2, variant_id: 'v', message: 'Regenerated 2 entries.' }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.deepStrictEqual(reloadedWith, { xml: 'stable123' });
    assert.strictEqual(notifyCalls[0][0], 'Regenerated 2 entries.');
  });

  it('does not reload the editor when execute reports nothing changed', async () => {
    const plugin = makePlugin();
    let reloadCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'dialog') return { confirm: async () => true };
      if (name === 'services') return { load: async () => { reloadCalled = true; } };
      if (name === 'client') return { apiClient: {
        documentRulesRefreshPreview: async () => ({ available: true, changed: false, entry_count: 0, variant_id: 'v', message: 'Already up to date.' }),
        documentRulesRefreshExecute: async () => ({ available: true, changed: false, entry_count: 0, variant_id: 'v', message: 'Already up to date.' }),
      } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._onRefreshDocumentRules();
    assert.strictEqual(reloadCalled, false);
  });
});

describe('DocumentRulesPlugin._refreshResources', () => {
  it('hides the menu item when no document is open', async () => {
    const plugin = makePlugin();
    Object.defineProperty(plugin, 'state', { get: () => ({ xml: null }), configurable: true });
    plugin._editMenuItem = { style: {}, documentRulesEditSubmenu: document.createElement('sl-menu') };
    await plugin._refreshResources();
    assert.strictEqual(plugin._editMenuItem.style.display, 'none');
  });

  it('shows the menu item disabled when the document has no resources', async () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { style: {}, disabled: false, documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshResources();
    assert.strictEqual(plugin._editMenuItem.style.display, '');
    assert.strictEqual(plugin._editMenuItem.disabled, true);
  });

  it('shows the menu item enabled with a populated submenu when resources exist', async () => {
    const plugin = makePlugin();
    plugin._editMenuItem = { style: {}, disabled: true, documentRulesEditSubmenu: document.createElement('sl-menu') };
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { getView: () => ({ state: { doc: { toString: () => '<TEI/>' } } }) };
      if (name === 'client') return { apiClient: { documentRulesList: async () => ({ resources: [
        { kind: 'schema', url: 'u', key: 'u', label: 'Schema (RelaxNG)', format: 'xml' }
      ] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshResources();
    assert.strictEqual(plugin._editMenuItem.style.display, '');
    assert.strictEqual(plugin._editMenuItem.disabled, false);
    assert.strictEqual(plugin._editMenuItem.documentRulesEditSubmenu.children.length, 1);
  });
});
```

- [ ] **Step 2: Run the new tests**

```bash
node --test tests/unit/js/document-rules.test.js
```

Expected: all tests pass, 0 failures.

- [ ] **Step 3: Run the full JS unit suite to check for regressions**

```bash
npm run test:unit -- --grep document-rules
npm run test:unit
```

Expected: previous count plus this file's new tests, all green.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/js/document-rules.test.js
git commit -m "test(doc-rules): add frontend unit tests for DocumentRulesPlugin"
```

---

### Task 8: E2E test, fixture, full suite, UI screenshot check

**Files:**
- Create: `tests/e2e/fixtures/standard/files/tei/document-rules/document-rules-fixture.tei.xml`
- Create: `tests/e2e/tests/document-rules.spec.js`

- [ ] **Step 1: Create a fixture document with an `editorialDecl`, a schema PI, and extractor provenance**

This needs `appInfo/application[@type="extractor"]` (for "Refresh document rules" to resolve a provider), an `editorialDecl/interpretation` entry (for the submenu to show at least one interpretation-ref resource), and an `xml-model` RelaxNG PI (for the schema resource). Base it on the structure already documented in `docs/development/example.tei.xml` (from Plans 1-3) but trimmed to the minimum this test needs:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<?xml-model href="https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/main/schema/rng/tei-bib.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Document Rules E2E Fixture</title>
      </titleStmt>
      <publicationStmt>
        <p>Test fixture for the document rules registry E2E suite.</p>
      </publicationStmt>
      <sourceDesc>
        <p>Test fixture.</p>
      </sourceDesc>
    </fileDesc>
    <encodingDesc>
      <appInfo>
        <application type="extractor" ident="GROBID" version="1.0">
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
      <editorialDecl>
        <interpretation type="data-correction" n="Data correction">
          <p>
            <ref target="https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/main/fastapi_app/plugins/grobid/annotation_rules/data-correction.md">Data correction rules</ref>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
  <text>
    <body>
      <p>Fixture body.</p>
    </body>
  </text>
</TEI>
```

Save as `tests/e2e/fixtures/standard/files/tei/document-rules/document-rules-fixture.tei.xml`. Adjust the `ref/@target` in the `interpretation` element to an actual file that exists in this repo at that raw-GitHub URL's path (`fastapi_app/plugins/grobid/annotation_rules/data-correction.md`) — check that path exists in this codebase (`ls fastapi_app/plugins/grobid/annotation_rules/`) before finalizing the fixture, and if the actual shipped filename differs, use the real one so `resolve_original()` can fetch it during the test (it goes through `UrlCache`, which per Plan 1 seeds pinned URLs from the plugin's own shipped file, so this should resolve without a real network fetch in CI — verify this by re-reading `fastapi_app/lib/doc_rules/kinds.py`'s `InterpretationRefKind.resolve_original()` and confirming test-environment behavior before relying on it; if it does require actual network access in this test environment, use `docs/development/example.tei.xml`'s existing, already-verified-working `ref` URL instead, copying its exact value rather than inventing a new one).

- [ ] **Step 2: Write the E2E test**

```js
import { test, expect } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const FIXTURE_PATH = join(process.cwd(), 'tests/e2e/fixtures/standard/files/tei/document-rules/document-rules-fixture.tei.xml');

test.describe('Document rules — edit prompts/schemas and refresh', () => {
  test('opens the submenu, edits an interpretation-ref override, and a schema override', async ({ page }) => {
    await login(page, 'reviewer'); // reviewer account: sees both menu items

    const xml = readFileSync(FIXTURE_PATH, 'utf-8');
    const stableId = await page.evaluate(async (xmlContent) => {
      const result = await window.client.apiClient.uploadFile(new Blob([xmlContent], { type: 'application/xml' }), 'document-rules-fixture.tei.xml');
      return result.stable_id ?? result.doc_id;
    }, xml);
    expect(stableId).toBeTruthy();

    await page.evaluate((id) => window.app.dispatchStateChange({ xml: id }), stableId);
    await page.waitForSelector('.cm-editor');

    // Hover the "Edit prompts/schemas" parent item to trigger its submenu refresh.
    await page.hover('sl-menu-item:has-text("Edit prompts/schemas")');
    await page.waitForTimeout(500);
    const submenu = page.locator('sl-menu-item:has-text("Edit prompts/schemas") sl-menu[slot="submenu"]');
    await expect(submenu.locator('sl-menu-item')).toHaveCount(2); // one interpretation-ref + one schema

    // Open the interpretation-ref resource, create an override, verify it appears selected.
    await submenu.locator('sl-menu-item:has-text("Data correction")').click();
    const dialog = page.locator('sl-dialog[name="documentRulesEditorDialog"]');
    await expect(dialog).toHaveAttribute('open', '');
    await page.waitForTimeout(500);
    await dialog.locator('sl-button:has-text("New override")').click();
    await expect(dialog.locator('sl-button:has-text("Override 1")')).toHaveAttribute('variant', 'primary');
    await dialog.locator('sl-textarea[name="textArea"]').fill('Custom override text.');
    await dialog.locator('sl-button:has-text("Save")').click();
    await dialog.locator('sl-button:has-text("Reset to original")').click();
    await expect(dialog.locator('sl-button:has-text("Original")')).toHaveAttribute('variant', 'primary');
    await dialog.locator('sl-button[name="closeBtn"]').click();

    // Open the schema resource, confirm the CodeMirror body is read-only on "Original".
    await page.hover('sl-menu-item:has-text("Edit prompts/schemas")');
    await page.waitForTimeout(500);
    await submenu.locator('sl-menu-item:has-text("Schema")').click();
    await expect(dialog).toHaveAttribute('open', '');
    await page.waitForTimeout(500);
    await expect(dialog.locator('[name="xmlContainer"] .cm-content')).toHaveAttribute('contenteditable', 'false');
    await dialog.locator('sl-button[name="closeBtn"]').click();
  });

  test('refresh document rules preview/execute on a legacy-style fixture (appInfo but no editorialDecl)', async ({ page }) => {
    await login(page, 'reviewer');

    const legacyXml = readFileSync(FIXTURE_PATH, 'utf-8').replace(/<editorialDecl>[\s\S]*?<\/editorialDecl>/, '');
    const stableId = await page.evaluate(async (xmlContent) => {
      const result = await window.client.apiClient.uploadFile(new Blob([xmlContent], { type: 'application/xml' }), 'document-rules-legacy-fixture.tei.xml');
      return result.stable_id ?? result.doc_id;
    }, legacyXml);

    await page.evaluate((id) => window.app.dispatchStateChange({ xml: id }), stableId);
    await page.waitForSelector('.cm-editor');

    await page.click('sl-menu-item:has-text("Refresh document rules")');
    const confirmDialog = page.locator('sl-dialog[name="dialogTemplate"]'); // the generic dialog.js sl-dialog
    await page.waitForTimeout(500);
    await confirmDialog.locator('sl-button[name="confirmBtn"]').click();

    await expect(page.locator('sl-alert[variant="success"]')).toBeVisible();
  });
});
```

Adjust the generic-dialog selector (`sl-dialog[name="dialogTemplate"]`) if `app/src/templates/dialog.html`'s root `name` attribute differs — check that file directly before finalizing this test (`registerTemplate('dialog-template', 'dialog.html')` in `dialog.js` registers it under the template key `'dialog-template'`, but the `sl-dialog`'s own `name=` attribute inside that HTML file is what Playwright must match; read the file to get the exact value rather than guessing). Also verify `login(page, 'reviewer')` matches this test suite's actual helper signature (check `tests/e2e/helpers/auth.js` or equivalent for the real function name/signature before use — the codebase's actual login helper may take different arguments; adjust to match).

- [ ] **Step 2: Run the new E2E test in isolation**

```bash
node tests/e2e-runner.js tests/e2e/tests/document-rules.spec.js
```

Expected: both tests pass. Debug per `docs/code-assistant/testing-guide.md` if Shoelace shadow-DOM timing issues appear (the established fix is the `page.waitForTimeout(500)` calls already included above, per `tests/CLAUDE.md`'s documented rule).

- [ ] **Step 3: Run the full suite**

```bash
npm run test:unit
npm run test:e2e
```

Expected: all green, no regressions in any previously-passing test.

- [ ] **Step 4: UI screenshot check**

```bash
node scripts/dev/ui-screenshot.js --out /tmp/claude-501/document-rules-menu.png --click 'sl-menu-item:has-text("Edit prompts/schemas")'
```

View the resulting PNG with the Read tool and confirm the submenu renders as expected (visually check menu item labels, icons, and category grouping look right — this is a real screenshot of a real running instance, not a mock).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/fixtures/standard/files/tei/document-rules/document-rules-fixture.tei.xml tests/e2e/tests/document-rules.spec.js
git commit -m "test(doc-rules): add E2E coverage for the edit-resources submenu and refresh action"
```

---

## Post-plan: request a final whole-plan code review

Once all 8 tasks are committed, dispatch a final code-reviewer subagent (per `superpowers:requesting-code-review`) against the whole plan's diff (`BASE_SHA` = the commit before Task 1, `HEAD_SHA` = HEAD), asking it to specifically check:

1. **Field-naming consistency** — every field/method the Task 7 tests touch is public-underscore (`_name`), not true `#private`; only the three dependency getters (`#client`, `#xmlEditor`, `#logger`) are true-private, matching `inference-settings.js`'s established convention.
2. **The `xml_string` vs `xml` (stable_id) distinction** — `documentRulesList()` must never be called with a stable_id, and `documentRulesRefreshPreview()`/`documentRulesRefreshExecute()` must never be called with editor content — grep every call site in `document-rules.js` to confirm.
3. **No stray `querySelector`/`querySelectorAll`** anywhere in `document-rules.js` (per `app/CLAUDE.md`) — every element access should go through `this._editorDialogUi.*`/`this._editMenuItem.*` or a locally-created element reference.
4. **`.types.js` files match their `.html` source** — re-run `node scripts/build/generate-ui-types.js` and confirm `git diff` is empty (no drift between the committed generated files and what the generator currently produces from the committed templates).

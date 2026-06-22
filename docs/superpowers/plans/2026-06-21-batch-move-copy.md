# Batch Move/Copy (Issue #400) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add batch move/copy of selected documents from the Collection & Files Drawer, replacing the single-document toolbar button.

**Architecture:** `MoveFilesPlugin` is refactored from a toolbar-button plugin into a service plugin with a public `showBatchDialog()` method. `FileSelectionDrawerPlugin` gains per-document checkboxes (PDF items in the tree), a move/copy button in the footer, and calls the service to perform batch operations.

**Tech Stack:** Shoelace web components, vanilla JS, FastAPI backend (already updated — `xml_id` removed from move/copy endpoints in a prior commit).

---

## File Map

| File | Change |
| --- | --- |
| `app/src/templates/move-files-dialog.html` | Redesign: collection checkboxes grouped by project instead of dropdown |
| `app/src/templates/move-files-dialog.types.js` | Update typedef to match new HTML |
| `app/src/plugins/move-files.js` | Remove toolbar button; add `showBatchDialog()` public method |
| `app/src/templates/file-selection-drawer.html` | Add move/copy button in footer |
| `app/src/templates/file-selection-drawer.types.js` | Add `moveCopyButton` to `fileDrawerPart` |
| `app/src/plugins/file-selection-drawer.js` | Add document checkboxes, selection tracking, move/copy button wiring, batch execution |
| `tests/e2e/tests/file-drawer-batch-move.spec.js` | New E2E test |

**Dependency order:** Tasks 1–2 are independent. Task 3 (HTML/types) MUST be committed before Task 4 (JS) because the plugin code references `moveCopyButton` from the template.

---

## Task 1: Redesign move-files-dialog HTML and types

**Files:**
- Modify: `app/src/templates/move-files-dialog.html`
- Modify: `app/src/templates/move-files-dialog.types.js`

### Context

The current dialog has a `sl-select` dropdown, a `copyMode` checkbox, and a single submit button. Replace everything with a scrollable `<div name="collectionsList">` (populated dynamically) plus separate Move and Copy buttons.

- [ ] **Step 1: Replace move-files-dialog.html**

Full replacement:

```html
<sl-dialog name="moveFilesDialog" label="Move/Copy to Collection">
  <p>Select target collection(s) for the <span name="docCount">0</span> selected document(s).</p>
  <div name="collectionsList" style="max-height: 300px; overflow-y: auto; padding: 0.25rem 0;">
    <!-- Populated dynamically by MoveFilesPlugin.showBatchDialog() -->
  </div>
  <sl-button slot="footer" name="newCollectionBtn" variant="default" outline>
    <sl-icon name="plus-lg" slot="prefix"></sl-icon> New
  </sl-button>
  <sl-button slot="footer" name="cancel">Cancel</sl-button>
  <sl-button slot="footer" name="moveBtn" variant="primary" disabled>Move</sl-button>
  <sl-button slot="footer" name="copyBtn" variant="default" disabled>Copy</sl-button>
</sl-dialog>
```

- [ ] **Step 2: Update move-files-dialog.types.js**

Full replacement:

```js
// AUTO-GENERATED from move-files-dialog.html — do not edit
// Regenerate with: npm run build:ui-types

/**
 * @typedef {object} moveFilesDialogPart
 * @property {HTMLSpanElement} docCount
 * @property {HTMLDivElement} collectionsList
 * @property {import('../ui.js').SlButton} newCollectionBtn
 * @property {import('../ui.js').SlButton} cancel
 * @property {import('../ui.js').SlButton} moveBtn
 * @property {import('../ui.js').SlButton} copyBtn
 */

export {}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/templates/move-files-dialog.html app/src/templates/move-files-dialog.types.js
git commit -m "feat(move-files): redesign dialog with collection checkboxes"
```

---

## Task 2: Refactor MoveFilesPlugin as a service plugin

**Files:**
- Modify: `app/src/plugins/move-files.js`

### Context

Remove the toolbar button, `onStateUpdate`, and deps on `document-actions`/`file-selection`/`services`. Keep `client`, `logger`, `dialog`. Add public `showBatchDialog()` which populates the redesigned dialog and returns `{action, targetCollections}` or `null` on cancel.

The `newCollectionBtn` handler creates the collection via API and immediately adds a checkbox for it to the open dialog — no file-data reload needed here (the drawer does that after the operation).

- [ ] **Step 1: Replace move-files.js entirely**

```js
/**
 * Service plugin for moving/copying files between collections.
 * Exposes showBatchDialog() for use by FileSelectionDrawerPlugin.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { CollectionInfo, ProjectInfo } from '../state.js'
 * @import { moveFilesDialogPart } from '../templates/move-files-dialog.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { notify } from '../modules/sl-utils.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'

await registerTemplate('move-files-dialog', 'move-files-dialog.html')

class MoveFilesPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'move-files', deps: ['logger', 'dialog', 'client'] })
  }

  get #client() { return this.getDependency('client') }
  get #logger() { return this.getDependency('logger') }
  get #dialog() { return this.getDependency('dialog') }

  /** @type {import('../ui.js').SlDialog & moveFilesDialogPart} */
  #dialogUi = null

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.#logger.debug(`Installing plugin "move-files"`)

    const dialog = createSingleFromTemplate('move-files-dialog', document.body)
    this.#dialogUi = this.createUi(dialog)

    this.#dialogUi.newCollectionBtn.addEventListener('click', async () => {
      const newCollectionId = prompt("Enter new collection ID (Only letters, numbers, '-' and '_'):")
      if (!newCollectionId) return
      if (!/^[a-zA-Z0-9_-]+$/.test(newCollectionId)) {
        this.#dialog.error("Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed.")
        return
      }
      const newCollectionName = prompt("Enter collection display name (optional, leave blank to use ID):")
      if (newCollectionName === null) return
      try {
        await this.#client.createCollection(newCollectionId, newCollectionName || newCollectionId)
        this.#appendCollectionCheckbox(newCollectionId, newCollectionName || newCollectionId, true)
        notify(`Collection '${newCollectionName || newCollectionId}' created`, 'success', 'check-circle')
      } catch (error) {
        this.#dialog.error(`Error creating collection: ${String(error)}`)
      }
    })
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {boolean} [checked]
   */
  #appendCollectionCheckbox(id, name, checked = false) {
    const div = document.createElement('div')
    div.style.cssText = 'display: flex; align-items: center; padding: 0.25rem 0;'
    const checkbox = /** @type {import('../ui.js').SlCheckbox} */ (document.createElement('sl-checkbox'))
    checkbox.size = 'small'
    checkbox.textContent = name
    checkbox.checked = checked
    checkbox.dataset.collectionId = id
    checkbox.addEventListener('sl-change', () => this.#updateButtonStates())
    div.appendChild(checkbox)
    this.#dialogUi.collectionsList.appendChild(div)
    this.#updateButtonStates()
  }

  #updateButtonStates() {
    const checkboxes = /** @type {import('../ui.js').SlCheckbox[]} */ ([
      ...this.#dialogUi.collectionsList.querySelectorAll('sl-checkbox')
    ])
    const checkedCount = checkboxes.filter(cb => cb.checked).length
    this.#dialogUi.moveBtn.disabled = checkedCount !== 1
    this.#dialogUi.copyBtn.disabled = checkedCount === 0
  }

  /**
   * Opens a dialog to select target collection(s) for batch move/copy.
   * @param {{
   *   pdfIds: string[],
   *   collections: CollectionInfo[],
   *   projects: ProjectInfo[]
   * }} params
   * @returns {Promise<{action: 'move'|'copy', targetCollections: string[]}|null>}
   */
  async showBatchDialog({ pdfIds, collections, projects }) {
    const dlg = this.#dialogUi
    dlg.docCount.textContent = String(pdfIds.length)
    dlg.collectionsList.innerHTML = ''

    /** @param {CollectionInfo[]} cols */
    const appendGroup = (cols) => {
      for (const col of cols) {
        this.#appendCollectionCheckbox(col.id, col.name)
      }
    }

    const renderedIds = new Set()
    for (const project of (projects || [])) {
      const projectCols = /** @type {CollectionInfo[]} */ (
        (project.collections || []).map(id => collections.find(c => c.id === id)).filter(Boolean)
      )
      if (projectCols.length === 0) continue
      const heading = document.createElement('div')
      heading.style.cssText = 'font-weight: bold; padding: 0.5rem 0 0.15rem; font-size: 0.85em; text-transform: uppercase; color: var(--sl-color-neutral-500);'
      heading.textContent = project.name
      dlg.collectionsList.appendChild(heading)
      appendGroup(projectCols)
      projectCols.forEach(c => renderedIds.add(c.id))
    }

    const orphans = collections.filter(c => !renderedIds.has(c.id))
    if (orphans.length > 0) {
      if (renderedIds.size > 0) {
        const heading = document.createElement('div')
        heading.style.cssText = 'font-weight: bold; padding: 0.5rem 0 0.15rem; font-size: 0.85em; text-transform: uppercase; color: var(--sl-color-neutral-500);'
        heading.textContent = 'No project'
        dlg.collectionsList.appendChild(heading)
      }
      appendGroup(orphans)
    }

    if (collections.length === 0) {
      const msg = document.createElement('p')
      msg.style.color = 'var(--sl-color-neutral-500)'
      msg.textContent = 'No collections available. Click "New" to create one.'
      dlg.collectionsList.appendChild(msg)
    }

    this.#updateButtonStates()

    /** @type {'move'|'copy'|null} */
    let action = null
    try {
      dlg.show()
      action = await new Promise((resolve, reject) => {
        dlg.moveBtn.addEventListener('click', () => resolve('move'), { once: true })
        dlg.copyBtn.addEventListener('click', () => resolve('copy'), { once: true })
        dlg.cancel.addEventListener('click', reject, { once: true })
        dlg.addEventListener('sl-hide', e => e.preventDefault(), { once: true })
      })
    } catch {
      this.#logger.info("User cancelled batch move/copy dialog")
      return null
    } finally {
      dlg.hide()
    }

    const checkboxes = /** @type {import('../ui.js').SlCheckbox[]} */ ([
      ...dlg.collectionsList.querySelectorAll('sl-checkbox')
    ])
    const targetCollections = checkboxes
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.collectionId)
      .filter(/** @param {any} id */ id => Boolean(id))

    return { action, targetCollections }
  }
}

export default MoveFilesPlugin
export const plugin = MoveFilesPlugin
```

- [ ] **Step 2: Commit**

```bash
git add app/src/plugins/move-files.js
git commit -m "feat(move-files): refactor as service plugin with showBatchDialog()"
```

---

## Task 3: Add move/copy button to drawer HTML and update types

**Files:**
- Modify: `app/src/templates/file-selection-drawer.html`
- Modify: `app/src/templates/file-selection-drawer.types.js`

### Context

The button must exist in the HTML **before** the JS plugin code that references it (Task 4). Adding it here in its own commit ensures the template is up to date.

- [ ] **Step 1: Add move/copy button to `file-selection-drawer.html`**

In the footer, find the `<sl-tooltip content="Create new collection">` block. Add the move/copy button AFTER its closing `</sl-tooltip>`:

```html
      <sl-tooltip content="Move or copy selected documents to a collection">
        <sl-button name="moveCopyButton" variant="default" size="small" disabled style="display: none;">
          <sl-icon name="folder-symlink"></sl-icon>
        </sl-button>
      </sl-tooltip>
```

The `style="display: none;"` hides it until `#updateButtonVisibility()` reveals it for reviewer/admin roles.

- [ ] **Step 2: Update `file-selection-drawer.types.js`**

In the `fileDrawerPart` typedef, add after `newCollectionButton`:

```js
 * @property {import('../ui.js').SlButton} moveCopyButton
```

- [ ] **Step 3: Commit**

```bash
git add app/src/templates/file-selection-drawer.html app/src/templates/file-selection-drawer.types.js
git commit -m "feat(drawer): add move/copy button to footer template"
```

---

## Task 4: Add document checkboxes, selection tracking, and batch handler to the drawer plugin

**Files:**
- Modify: `app/src/plugins/file-selection-drawer.js`

### Context

This task makes all JS changes to `file-selection-drawer.js`. The HTML from Task 3 must already be committed.

**Key Shoelace facts:**
- Setting `checkbox.checked = value` programmatically does NOT fire `sl-change`. Update `#selectedDocuments` manually in those cases.
- `checkbox.indeterminate = true` makes the checkbox show as partially checked (Shoelace supports this property).
- `sl-tree` with `selection="leaf"` fires `sl-selection-change` on item clicks. Checkbox clicks are stopped from propagating (`e.stopPropagation()`) so they don't accidentally select the tree item.
- The FIRST `sl-checkbox` inside a `.collection-item` is the collection's own checkbox. `.pdf-item sl-checkbox` selects only the per-document checkboxes.

- [ ] **Step 1: Add `'move-files'` to the deps array**

In the constructor, change:
```js
    super(context, {
      name: 'file-selection-drawer',
      deps: ['logger', 'dialog', 'client', 'filedata']
    });
```
to:
```js
    super(context, {
      name: 'file-selection-drawer',
      deps: ['logger', 'dialog', 'client', 'filedata', 'move-files']
    });
```

- [ ] **Step 2: Add `#selectedDocuments` field**

Add after `/** @type {ExportFormatInfo[]} */ #availableExportFormats = [];`:
```js
  /** @type {Set<string>} PDF stable_ids checked for batch move/copy */
  #selectedDocuments = new Set();
```

- [ ] **Step 3: Add `#moveFiles` getter**

Add after `get #client() { return this.getDependency('client') }`:
```js
  get #moveFiles() { return this.getDependency('move-files') }
```

- [ ] **Step 4: Add event listener for move/copy button in `install()`**

After the `this.#drawerUi.newCollectionButton.addEventListener(...)` block in `install()`, add:
```js
    this.#drawerUi.moveCopyButton.addEventListener('click', async () => {
      if (this.state) {
        await this.#handleMoveCopy(this.state);
      }
    });
```

- [ ] **Step 5: Clear `#selectedDocuments` at the start of `#populateFileTree()`**

At the very top of `#populateFileTree(state)` (before `if (!state.fileData) return`), add:
```js
    this.#selectedDocuments.clear();
    this.#updateMoveCopyButtonState();
```

- [ ] **Step 6: Add document checkbox to each `pdfItem` in `#buildCollectionTreeItem()`**

Find these three lines (they appear once inside `#buildCollectionTreeItem`):
```js
      const displayLabel = file.source?.label || file.doc_metadata?.title || file.doc_id
      const icon = file.source?.file_type === 'pdf' ? 'file-pdf' : 'file-earmark-code'
      pdfItem.innerHTML = `<sl-icon name="${icon}"></sl-icon><span>${displayLabel}</span>`
```

Replace with:
```js
      const displayLabel = file.source?.label || file.doc_metadata?.title || file.doc_id
      const icon = file.source?.file_type === 'pdf' ? 'file-pdf' : 'file-earmark-code'
      const pdfId = file.source?.id || ''

      const docCheckbox = /** @type {import('../ui.js').SlCheckbox} */ (document.createElement('sl-checkbox'))
      docCheckbox.size = 'small'
      docCheckbox.checked = this.#selectedDocuments.has(pdfId)
      docCheckbox.addEventListener('click', e => e.stopPropagation())
      docCheckbox.addEventListener('sl-change', e => {
        e.stopPropagation()
        this.#onDocumentCheckboxChange(pdfId, docCheckbox.checked, collectionName)
      })
      const iconEl = document.createElement('sl-icon')
      iconEl.name = icon
      const labelEl = document.createElement('span')
      labelEl.textContent = displayLabel
      pdfItem.appendChild(docCheckbox)
      pdfItem.appendChild(iconEl)
      pdfItem.appendChild(labelEl)
```

- [ ] **Step 7: Update `#onCollectionCheckboxChange()` to sync document checkboxes**

The current method body is:
```js
  #onCollectionCheckboxChange(collectionName, checked) {
    if (checked) {
      this.#selectedCollections.add(collectionName);
    } else {
      this.#selectedCollections.delete(collectionName);
    }
    this.#updateExportButtonState();
  }
```

Replace with:
```js
  #onCollectionCheckboxChange(collectionName, checked) {
    if (checked) {
      this.#selectedCollections.add(collectionName);
    } else {
      this.#selectedCollections.delete(collectionName);
    }

    // Sync document checkboxes — programmatic, does NOT fire sl-change
    const collectionTreeItem = /** @type {HTMLElement|null} */ (
      this.#drawerUi.fileTree.querySelector(`.collection-item[data-collection="${collectionName}"]`)
    );
    if (collectionTreeItem) {
      const pdfItems = collectionTreeItem.querySelectorAll('.pdf-item');
      pdfItems.forEach(item => {
        const pdfCheckbox = /** @type {import('../ui.js').SlCheckbox} */ (item.querySelector('sl-checkbox'));
        const pdfId = /** @type {HTMLElement} */ (item).dataset.hash;
        if (pdfCheckbox && pdfId) {
          pdfCheckbox.checked = checked;
          if (checked) {
            this.#selectedDocuments.add(pdfId);
          } else {
            this.#selectedDocuments.delete(pdfId);
          }
        }
      });
    }

    this.#updateExportButtonState();
    this.#updateMoveCopyButtonState();
  }
```

- [ ] **Step 8: Add `#onDocumentCheckboxChange()` method**

Add this new method immediately after `#onCollectionCheckboxChange()`:
```js
  /**
   * @param {string} pdfId
   * @param {boolean} checked
   * @param {string} collectionName
   */
  #onDocumentCheckboxChange(pdfId, checked, collectionName) {
    if (checked) {
      this.#selectedDocuments.add(pdfId);
    } else {
      this.#selectedDocuments.delete(pdfId);
    }

    // Update collection checkbox state (checked / indeterminate / unchecked)
    const collectionTreeItem = /** @type {HTMLElement|null} */ (
      this.#drawerUi.fileTree.querySelector(`.collection-item[data-collection="${collectionName}"]`)
    );
    if (collectionTreeItem) {
      const pdfCheckboxes = /** @type {import('../ui.js').SlCheckbox[]} */ (
        [...collectionTreeItem.querySelectorAll('.pdf-item sl-checkbox')]
      );
      const checkedCount = pdfCheckboxes.filter(cb => cb.checked).length;
      const collectionCheckbox = /** @type {import('../ui.js').SlCheckbox} */ (
        collectionTreeItem.querySelector('sl-checkbox')
      );
      if (collectionCheckbox) {
        if (checkedCount === 0) {
          collectionCheckbox.indeterminate = false;
          collectionCheckbox.checked = false;
        } else if (checkedCount === pdfCheckboxes.length) {
          collectionCheckbox.indeterminate = false;
          collectionCheckbox.checked = true;
        } else {
          collectionCheckbox.indeterminate = true;
        }
      }
    }

    this.#updateMoveCopyButtonState();
  }
```

- [ ] **Step 9: Add `#updateMoveCopyButtonState()` method**

Add after `#updateExportButtonState()`:
```js
  #updateMoveCopyButtonState() {
    const moveCopyButton = this.#drawerUi.moveCopyButton;
    moveCopyButton.disabled = this.#selectedDocuments.size === 0;
  }
```

- [ ] **Step 10: Update `#updateButtonVisibility()` to show/hide the move/copy button**

In `#updateButtonVisibility(state)`, find the `if (hasReviewerRole)` block:
```js
    if (hasReviewerRole) {
      importButton.style.display = '';
      exportDropdown.style.display = '';
      newCollectionButton.style.display = '';
    } else {
      importButton.style.display = 'none';
      exportDropdown.style.display = 'none';
      newCollectionButton.style.display = 'none';
    }
```

Replace with:
```js
    const moveCopyButton = this.#drawerUi.moveCopyButton;
    if (hasReviewerRole) {
      importButton.style.display = '';
      exportDropdown.style.display = '';
      newCollectionButton.style.display = '';
      moveCopyButton.style.display = '';
    } else {
      importButton.style.display = 'none';
      exportDropdown.style.display = 'none';
      newCollectionButton.style.display = 'none';
      moveCopyButton.style.display = 'none';
    }
```

- [ ] **Step 11: Add `#handleMoveCopy()` method**

Add before the `#handleDelete()` method:
```js
  /**
   * @param {ApplicationState} state
   */
  async #handleMoveCopy(state) {
    const pdfIds = Array.from(this.#selectedDocuments);
    if (pdfIds.length === 0) return;

    const result = await this.#moveFiles.showBatchDialog({
      pdfIds,
      collections: state.collections || [],
      projects: state.projects || []
    });

    if (!result) return;

    const { action, targetCollections } = result;

    if (targetCollections.length === 0) {
      this.#dialog.error('No collection selected.');
      return;
    }

    const collectionNames = targetCollections
      .map(id => (state.collections || []).find(c => c.id === id)?.name || id)
      .join(', ');

    const confirmMsg = action === 'move'
      ? `Move ${pdfIds.length} document(s) to "${collectionNames}"?\n\nThis will remove them from their current collection(s).`
      : `Copy ${pdfIds.length} document(s) to "${collectionNames}"?`;

    if (!confirm(confirmMsg)) return;

    const moveCopyButton = this.#drawerUi.moveCopyButton;
    moveCopyButton.loading = true;
    moveCopyButton.disabled = true;

    let successCount = 0;
    const errors = [];

    for (const pdfId of pdfIds) {
      for (const collectionId of targetCollections) {
        try {
          if (action === 'move') {
            await this.#client.moveFiles(pdfId, collectionId);
          } else {
            await this.#client.copyFiles(pdfId, collectionId);
          }
          successCount++;
        } catch (error) {
          errors.push({ pdfId, collectionId, error: String(error) });
          this.#logger.error(`Failed to ${action} ${pdfId} to ${collectionId}: ${error}`);
        }
      }
    }

    moveCopyButton.loading = false;

    const verb = action === 'move' ? 'moved' : 'copied';
    if (errors.length === 0) {
      notify(`${successCount} document(s) ${verb} to "${collectionNames}"`, 'success', 'check-circle');
    } else if (successCount > 0) {
      notify(`${successCount} succeeded, ${errors.length} failed`, 'warning', 'exclamation-triangle');
    } else {
      notify(`Failed to ${action} all documents`, 'danger', 'exclamation-octagon');
    }

    this.#selectedDocuments.clear();
    await this.getDependency('filedata').reload({ refresh: true });
  }
```

- [ ] **Step 12: Commit**

```bash
git add app/src/plugins/file-selection-drawer.js
git commit -m "feat(drawer): add document checkboxes, selection tracking, and batch move/copy"
```

---

## Task 5: E2E test

**Files:**
- Create: `tests/e2e/tests/file-drawer-batch-move.spec.js`

### Context

The test runs against a live dev server. Test users: `testreviewer`/`reviewerpass` and `testadmin`/`adminpass`. Collections and files are assumed to exist (populated by the test environment). `confirm()` dialogs must be intercepted with `page.once('dialog', async d => d.accept())` registered BEFORE the action that triggers them. Always wait 200–500ms after Shoelace interactions. Buttons with `disabled` attribute can't be clicked — assert the attribute before trying.

- [ ] **Step 1: Create the test file**

```js
/**
 * Batch move/copy E2E tests.
 *
 * @testCovers app/src/plugins/file-selection-drawer.js
 * @testCovers app/src/plugins/move-files.js
 * @testCovers fastapi_app/routers/files_move.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'offsetParent is not set.*cannot scroll'
];

test.describe('Batch Move/Copy from File Drawer', () => {

  test('document checkboxes appear on PDF items and move/copy button is hidden by default', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await page.waitForTimeout(1000);

      await page.locator('sl-button[name="fileDrawerTrigger"]').click();
      await page.waitForTimeout(500);
      await expect(page.locator('sl-drawer[name="fileDrawer"]')).toHaveAttribute('open', '');

      const pdfItems = page.locator('.pdf-item');
      const count = await pdfItems.count();
      if (count > 0) {
        await expect(pdfItems.first().locator('sl-checkbox')).toBeVisible();
        const moveCopyButton = page.locator('sl-button[name="moveCopyButton"]');
        await expect(moveCopyButton).toBeVisible();
        await expect(moveCopyButton).toHaveAttribute('disabled', '');
      }

      await page.locator('sl-button[name="closeDrawer"]').click();
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('checking a document enables the move/copy button; unchecking disables it', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await page.waitForTimeout(1000);

      await page.locator('sl-button[name="fileDrawerTrigger"]').click();
      await page.waitForTimeout(500);

      const pdfItems = page.locator('.pdf-item');
      if (await pdfItems.count() === 0) {
        await page.locator('sl-button[name="closeDrawer"]').click();
        return;
      }

      const moveCopyButton = page.locator('sl-button[name="moveCopyButton"]');
      await expect(moveCopyButton).toHaveAttribute('disabled', '');

      await pdfItems.first().locator('sl-checkbox').click();
      await page.waitForTimeout(300);
      await expect(moveCopyButton).not.toHaveAttribute('disabled');

      await pdfItems.first().locator('sl-checkbox').click();
      await page.waitForTimeout(300);
      await expect(moveCopyButton).toHaveAttribute('disabled', '');

      await page.locator('sl-button[name="closeDrawer"]').click();
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('collection checkbox toggles all document checkboxes and updates move/copy button', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await page.waitForTimeout(1000);

      await page.locator('sl-button[name="fileDrawerTrigger"]').click();
      await page.waitForTimeout(500);

      const firstCollection = page.locator('.collection-item').first();
      if (await firstCollection.count() === 0) {
        await page.locator('sl-button[name="closeDrawer"]').click();
        return;
      }

      const pdfCheckboxes = firstCollection.locator('.pdf-item sl-checkbox');
      const pdfCount = await pdfCheckboxes.count();
      if (pdfCount === 0) {
        await page.locator('sl-button[name="closeDrawer"]').click();
        return;
      }

      // Check the collection checkbox (first sl-checkbox directly inside the collection item)
      const collectionCheckbox = firstCollection.locator('> sl-checkbox');
      await collectionCheckbox.click();
      await page.waitForTimeout(300);

      for (let i = 0; i < pdfCount; i++) {
        await expect(pdfCheckboxes.nth(i)).toHaveJSProperty('checked', true);
      }
      await expect(page.locator('sl-button[name="moveCopyButton"]')).not.toHaveAttribute('disabled');

      // Uncheck collection
      await collectionCheckbox.click();
      await page.waitForTimeout(300);
      for (let i = 0; i < pdfCount; i++) {
        await expect(pdfCheckboxes.nth(i)).toHaveJSProperty('checked', false);
      }
      await expect(page.locator('sl-button[name="moveCopyButton"]')).toHaveAttribute('disabled', '');

      await page.locator('sl-button[name="closeDrawer"]').click();
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('dialog enforces move-to-one constraint: Move disabled when >1 collections selected', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, 'testadmin', 'adminpass');
      await page.waitForTimeout(1000);

      await page.locator('sl-button[name="fileDrawerTrigger"]').click();
      await page.waitForTimeout(500);

      const pdfItems = page.locator('.pdf-item');
      if (await pdfItems.count() === 0) {
        await page.locator('sl-button[name="closeDrawer"]').click();
        return;
      }

      await pdfItems.first().locator('sl-checkbox').click();
      await page.waitForTimeout(300);
      await page.locator('sl-button[name="moveCopyButton"]').click();
      await page.waitForTimeout(500);

      const dialog = page.locator('sl-dialog[name="moveFilesDialog"]');
      await expect(dialog).toHaveAttribute('open', '');

      const moveBtn = dialog.locator('sl-button[name="moveBtn"]');
      const copyBtn = dialog.locator('sl-button[name="copyBtn"]');
      await expect(moveBtn).toHaveAttribute('disabled', '');
      await expect(copyBtn).toHaveAttribute('disabled', '');

      const dialogCheckboxes = dialog.locator('[name="collectionsList"] sl-checkbox');
      const colCount = await dialogCheckboxes.count();

      if (colCount >= 2) {
        await dialogCheckboxes.first().click();
        await page.waitForTimeout(200);
        await expect(moveBtn).not.toHaveAttribute('disabled');
        await expect(copyBtn).not.toHaveAttribute('disabled');

        await dialogCheckboxes.nth(1).click();
        await page.waitForTimeout(200);
        await expect(moveBtn).toHaveAttribute('disabled', '');  // >1 selected
        await expect(copyBtn).not.toHaveAttribute('disabled');

        await dialogCheckboxes.nth(1).click();
        await page.waitForTimeout(200);
        await expect(moveBtn).not.toHaveAttribute('disabled');  // back to 1
      } else if (colCount === 1) {
        await dialogCheckboxes.first().click();
        await page.waitForTimeout(200);
        await expect(moveBtn).not.toHaveAttribute('disabled');
      }

      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="cancel"]').click();
      await page.waitForTimeout(300);
      await page.locator('sl-button[name="closeDrawer"]').click();
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('moving a document shows success notification and reloads the drawer', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, 'testadmin', 'adminpass');
      await page.waitForTimeout(1000);

      await page.locator('sl-button[name="fileDrawerTrigger"]').click();
      await page.waitForTimeout(500);

      const pdfItems = page.locator('.pdf-item');
      if (await pdfItems.count() === 0) {
        await page.locator('sl-button[name="closeDrawer"]').click();
        return;
      }

      const firstPdfItem = pdfItems.first();
      const sourceCollection = await firstPdfItem.getAttribute('data-collection');

      await firstPdfItem.locator('sl-checkbox').click();
      await page.waitForTimeout(300);
      await page.locator('sl-button[name="moveCopyButton"]').click();
      await page.waitForTimeout(500);

      const dialog = page.locator('sl-dialog[name="moveFilesDialog"]');
      await expect(dialog).toHaveAttribute('open', '');

      const dialogCheckboxes = dialog.locator('[name="collectionsList"] sl-checkbox');
      let targetSelected = false;
      for (let i = 0; i < await dialogCheckboxes.count(); i++) {
        const id = await dialogCheckboxes.nth(i).getAttribute('data-collection-id');
        if (id && id !== sourceCollection) {
          await dialogCheckboxes.nth(i).click();
          await page.waitForTimeout(200);
          targetSelected = true;
          break;
        }
      }

      if (!targetSelected) {
        // Only one collection — can't move anywhere else
        await dialog.locator('sl-button[name="cancel"]').click();
        await page.locator('sl-button[name="closeDrawer"]').click();
        return;
      }

      // Accept the confirm() dialog
      page.once('dialog', async d => { await d.accept(); });

      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="moveBtn"]').click();
      await page.waitForTimeout(1500);

      await expect(page.locator('sl-alert[variant="success"]')).toBeVisible({ timeout: 5000 });

      await page.locator('sl-button[name="closeDrawer"]').click();
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

});
```

- [ ] **Step 2: Run the tests**

```bash
npm run test:e2e -- tests/e2e/tests/file-drawer-batch-move.spec.js
```

Expected: all 5 tests pass (or skip gracefully when test data is absent).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/tests/file-drawer-batch-move.spec.js
git commit -m "test(e2e): add batch move/copy drawer tests (closes #400)"
```

---

## Final verification checklist

Before declaring done:

- [ ] No `#moveBtn` field or `addButton()` call in `move-files.js`
- [ ] PDF items in the drawer tree each have a visible `sl-checkbox`
- [ ] Checking a collection checkbox checks all its PDF item checkboxes (and vice versa)
- [ ] Partially selecting docs within a collection shows collection checkbox as indeterminate
- [ ] Move/copy button invisible for annotator role, visible for reviewer/admin
- [ ] Move/copy button disabled when no docs checked, enabled when ≥1 checked
- [ ] Dialog opens with collections grouped by project headers
- [ ] Move button disabled when 0 or >1 collections checked; Copy button disabled only when 0
- [ ] "New" button in dialog creates a collection and adds a checkbox immediately
- [ ] Move: document disappears from source collection after drawer reloads
- [ ] Copy: document appears in both source and target after drawer reloads
- [ ] All 5 E2E tests pass

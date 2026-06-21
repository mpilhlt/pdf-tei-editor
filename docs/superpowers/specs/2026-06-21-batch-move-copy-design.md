# Batch Move/Copy — Issue #400

## Goal

Replace the single-document toolbar Move/Copy button with a batch operation driven from the
Collection & Files Drawer. Users select any number of documents via per-document checkboxes
in the file tree, then invoke a Move/Copy dialog that shows all accessible collections
grouped by project.

---

## Architecture

### 1. `move-files.js` (MoveFilesPlugin) — repurposed as a service plugin

**Remove:**
- `#moveBtn` field and all toolbar button creation
- Call to `this.#documentActions.addButton()`
- `onStateUpdate()` (no longer needed)
- `document-actions` dependency

**Add:**
- Public `async showBatchDialog({ documents, fileData, collections, projects })` method
  - `documents`: `Array<{pdfId: string, xmlId: string|null}>` — documents to act on
  - `fileData`: current state file data (for context)
  - `collections`: accessible collection objects
  - `projects`: project objects for grouping
- Method populates the redesigned dialog and resolves to
  `{ action: 'move'|'copy', targetCollections: string[] }` or `null` on cancel
- Move button disabled when 0 or >1 collections are checked in the dialog
- Copy button disabled when 0 collections are checked
- "New collection" button retained

**Keep:** dialog creation in `install()`, `#newCollectionBtn` handler, `#client` accessor.

### 2. `move-files-dialog.html` — redesigned

**Replace** the `sl-select` + `sl-checkbox[copyMode]` + single submit layout with:

```html
<sl-dialog name="moveFilesDialog" label="Move/Copy to Collection">
  <p>Select target collection(s) for the <span name="docCount">N</span> selected document(s).</p>
  <div name="collectionsList" style="max-height: 300px; overflow-y: auto;">
    <!-- Dynamically populated: project headers + per-collection sl-checkbox -->
  </div>
  <sl-button slot="footer" name="newCollectionBtn" variant="default" outline>
    <sl-icon name="plus-lg" slot="prefix"></sl-icon> New
  </sl-button>
  <sl-button slot="footer" name="cancel">Cancel</sl-button>
  <sl-button slot="footer" name="moveBtn" variant="primary" disabled>Move</sl-button>
  <sl-button slot="footer" name="copyBtn" variant="default" disabled>Copy</sl-button>
</sl-dialog>
```

The `collectionsList` container is populated dynamically:
- Project name as a bold heading (or "No project")
- `sl-checkbox` per collection beneath each heading
- Checking/unchecking a collection updates button enabled states

### 3. `file-selection-drawer.js` (FileSelectionDrawerPlugin) — extended

**New private state:**
```js
#selectedDocuments = new Set()  // PDF stable_ids
```

**In `#buildCollectionTreeItem()`:** after creating each `pdfItem`, insert a `sl-checkbox`
before the icon+label content. The checkbox's `sl-change` event calls
`#onDocumentCheckboxChange(pdfStableId, checked, collectionName)`.

**Collection ↔ document sync:**
- `#onCollectionCheckboxChange()` additionally checks/unchecks all `pdfItem` checkboxes
  in the collection subtree and updates `#selectedDocuments`.
- `#onDocumentCheckboxChange()` updates `#selectedDocuments`, then recalculates the
  parent collection checkbox state (checked / indeterminate / unchecked) and calls
  `#updateMoveCopyButtonState()`.

**New footer button:** `moveCopyButton` (icon-only, `folder-symlink`, enabled when
`#selectedDocuments.size > 0`).

**Move/copy execution:**
1. Build `documents` array: for each PDF stable_id in `#selectedDocuments`, find the
   gold-standard artifact (or first artifact) in `state.fileData` to obtain `xmlId`.
2. Call `this.getDependency('move-files').showBatchDialog({ documents, ... })`.
3. On non-null result, show a confirmation: e.g.
   "Move 3 documents to 'TargetCollection'? This cannot be undone." (Move)
   or "Copy 3 documents to 2 collections?" (Copy).
4. Show spinner; iterate documents, calling `client.apiClient.filesMove(...)` or
   `client.apiClient.filesCopy(...)` for each.
5. On completion, clear `#selectedDocuments`, call `getDependency('filedata').reload({ refresh: true })`,
   and show a success notification.
6. On error, report per-document failures without aborting remaining documents.

### 4. `file-selection-drawer.html` — extended

Add to the footer (alongside import/export/delete/new buttons):

```html
<sl-tooltip content="Move or copy selected documents to a collection">
  <sl-button name="moveCopyButton" variant="default" size="small" disabled>
    <sl-icon name="folder-symlink"></sl-icon>
  </sl-button>
</sl-tooltip>
```

### 5. Type files updated

- `move-files-dialog.types.js` — manual update to match redesigned HTML
- `file-selection-drawer.types.js` — add `moveCopyButton` to `fileDrawerPart`

### 6. `tests/e2e/tests/file-drawer-batch-move.spec.js` — new test

Covers:
1. Login as reviewer
2. Open the drawer; verify per-document checkboxes exist on PDF items
3. Check two documents
4. Click the Move/Copy button; verify dialog opens with collection checkboxes
5. Select one collection; verify Move button is enabled
6. Select a second collection; verify Move button is disabled, Copy still enabled
7. De-select to one collection; click Move; confirm dialog; verify success notification
8. Reload the drawer; verify moved documents appear in the target collection

---

## Constraints

- `#selectedDocuments` tracks PDF stable_ids only; collection checkboxes remain the
  source of truth for export/delete (no cross-contamination).
- The existing `#selectedCollections` set (export/delete) is not changed by document
  checkbox interactions.
- `MoveFilesPlugin` no longer has `onStateUpdate` — the drawer's `#updateMoveCopyButtonState`
  controls the button instead.
- `filesMove` / `filesCopy` API calls only require `pdf_id` and `destination_collection`.
  `xml_id` has been removed — operations always act on the PDF and all associated TEI files atomically.
- The `move-files` dependency is added to `FileSelectionDrawerPlugin`'s `deps` array
  only after verifying no circular dependency exists (move-files → services, file-selection,
  logger, dialog; none of these lead back to file-selection-drawer).
- `#isUpdatingTree` flag is not set when building/updating document checkboxes
  (document checkboxes are not `sl-tree-item` selection — they are separate widgets).
- `#selectedDocuments` is cleared at the start of `#populateFileTree()` (tree rebuild
  resets all checkboxes to unchecked, so the selection set must match).

---

## Files Changed

| File | Type |
| --- | --- |
| `app/src/plugins/move-files.js` | modify |
| `app/src/templates/move-files-dialog.html` | modify |
| `app/src/templates/move-files-dialog.types.js` | modify |
| `app/src/plugins/file-selection-drawer.js` | modify |
| `app/src/templates/file-selection-drawer.html` | modify |
| `app/src/templates/file-selection-drawer.types.js` | modify (if auto-generated; else update manually) |
| `tests/e2e/tests/file-drawer-batch-move.spec.js` | new |

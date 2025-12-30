# Refactor Document Actions to Separate Plugin

**Related:** Issue #131 (edit-file-metadata.md)

## Goal

Extract document action buttons (save revision, create new version, delete operations) from the `services` plugin into a dedicated `document-actions` plugin. This separation improves modularity and sets the stage for adding file metadata editing UI.

## Current State

Document actions are currently part of `app/src/plugins/services.js`:
- Button group created in `install()` at line 131-142
- Event handlers registered at lines 148-179
- State updates control button states at lines 186-232
- Dialog handling and operations: `saveRevision()`, `createNewVersion()`, `deleteCurrentVersion()`, `deleteAllVersions()`, `deleteAll()`

## Implementation Steps

### 1. Create New Plugin Structure

**File:** `app/src/plugins/document-actions.js`

- Create plugin with dependencies: `['file-selection', 'authentication', 'access-control']`
- Export API methods:
  - `saveRevision()`
  - `createNewVersion()`
  - `deleteCurrentVersion()`
  - `deleteAllVersions()`
  - `deleteAll()`
- Import dependencies from `../app.js`
- Register templates (already registered in services.js):
  - `document-action-buttons.html`
  - `new-version-dialog.html`
  - `save-revision-dialog.html`

### 2. Move UI Components

**From services.js lines 131-142, 148-179:**

- Move document action buttons creation to new plugin's `install()`
- Move event listeners for:
  - `saveRevision` button (line 153-155)
  - `deleteCurrentVersion` button (line 160-162)
  - `deleteAllVersions` button (line 163-165)
  - `deleteAll` button (line 166-168)
  - `createNewVersion` button (line 171-173)
- Keep `xmlEditor.on("editorReady")` handler in services.js (line 157) - services plugin owns xmlEditor lifecycle

### 3. Move State Management

**From services.js lines 186-232:**

- Move `onStateUpdate()` logic for document actions:
  - Offline state handling (lines 194-202)
  - Role-based access control (lines 204-216)
  - Delete button state logic (lines 208-221)
  - Save/version button state logic (lines 223-231)
- Keep TEI actions state updates in services.js

### 4. Move Operations and Dialogs

**From services.js:**

- Move functions:
  - `saveRevision()` (lines 787-860)
  - `createNewVersion()` (lines 866-958)
  - `deleteCurrentVersion()` (lines 481-536)
  - `deleteAllVersions()` (lines 542-620)
  - `deleteAll()` (lines 626-664)
  - `getIdFromUser()` (lines 770-781) - helper for user dialogs
- Move `addTeiHeaderInfo()` to new plugin (lines 997-1029) - used by save/version operations
- Import required utilities:
  - `tei_utils` methods
  - `getFileDataById()` from file-data-utils
  - `userHasRole()`, `isGoldFile()` from acl-utils
  - `prettyPrintXmlDom()` from tei-wizard plugin
  - `notify()` from sl-utils

### 5. Update services.js

**Remove from services.js:**

- Document action button creation and event handlers
- Document action state updates in `onStateUpdate()`
- All delete/save/version operations
- Template registrations for document actions (lines 114-116)
- Remove from API export (lines 34-46):
  - `deleteCurrentVersion`
  - `deleteAllVersions`
  - `deleteAll`
  - `addTeiHeaderInfo`
- Keep in services.js:
  - `load()`
  - `validateXml()`
  - `showMergeView()` / `removeMergeView()`
  - `searchNodeContentsInPdf()`
  - `downloadXml()` / `uploadXml()`
  - `inProgress()` for validation
  - TEI actions button group

### 6. Update UI Typedefs

**File:** `app/src/ui.js`

- Add import for document actions part typedef:
  ```javascript
  @import { documentActionsPart } from './plugins/document-actions.js'
  ```
- Document actions typedef already exists in services.js - move to new plugin

### 7. Update Plugin Registration

**File:** `app/src/app.js`

- Add to plugins array (line ~71-76):
  ```javascript
  import DocumentActionsPlugin from './plugins/document-actions.js'
  ```
- Register after file-selection, before services:
  ```javascript
  DocumentActionsPlugin,
  ServicesPlugin,
  ```

### 8. Update Dependencies

**services.js:**
- Add dependency: `deps: ['document-actions']` to access operations like `deleteCurrentVersion()` if needed
- Remove document action imports no longer needed

**document-actions.js:**
- Dependencies: `['file-selection', 'authentication', 'access-control']`
- Import from `../plugins.js`: `FiledataPlugin`

### 9. Update Tests

**Files to check:**
- `tests/e2e/document-actions.spec.js` - verify tests still pass
- `tests/api/v1/files_save.test.js` - uses revision save
- `tests/api/v1/files_delete.test.js` - uses delete operations

**Update test imports if needed:**
- Change from `services.deleteCurrentVersion()` to `documentActions.deleteCurrentVersion()`

### 10. Update edit-file-metadata.md

**File:** `dev/todo/edit-file-metadata.md`

Update implementation approach:
- Note that document actions are now in separate plugin
- File metadata editor dialog should be added to `document-actions` plugin
- Button to open metadata editor should be added to document actions button group

## Key Patterns

### Plugin Structure

```javascript
const plugin = {
  name: "document-actions",
  deps: ['file-selection', 'authentication', 'access-control'],
  install,
  onStateUpdate,
}

const api = {
  saveRevision,
  createNewVersion,
  deleteCurrentVersion,
  deleteAllVersions,
  deleteAll,
}

export { plugin, api }
export default plugin
```

### State Management

```javascript
async function onStateUpdate(changedKeys, state) {
  currentState = state;

  const da = ui.toolbar.documentActions;
  const isReviewer = userHasRole(state.user, ["admin", "reviewer"]);
  const isAnnotator = userHasRole(state.user, ["admin", "reviewer", "annotator"]);

  // Update button states based on user role and current state
}
```

## Files to Create/Modify

### Create:
- `app/src/plugins/document-actions.js`

### Modify:
- `app/src/plugins/services.js` - remove document actions
- `app/src/ui.js` - update typedef imports
- `app/src/app.js` - register new plugin
- `dev/todo/edit-file-metadata.md` - update implementation approach

### Verify:
- `tests/e2e/document-actions.spec.js`
- `tests/api/v1/files_save.test.js`
- `tests/api/v1/files_delete.test.js`

## Testing Strategy

1. Run E2E tests for document actions: `npm run test:e2e -- --grep "document-action"`
2. Run API tests for save operations: `npm run test:api -- --grep "files_save"`
3. Run API tests for delete operations: `npm run test:api -- --grep "files_delete"`
4. Manual testing:
   - Save revision dialog and operation
   - Create new version dialog and operation
   - Delete current version
   - Delete all versions
   - Delete all files
   - Role-based access control (test as annotator and reviewer)

## Implementation Complete

All planned changes have been implemented:

1. **New plugin created**: `app/src/plugins/document-actions.js` with all document action operations
2. **Templates**: All document action templates moved and edit-metadata-dialog.html added
3. **Services.js cleaned**: Removed all document action code, keeping only TEI services
4. **Plugin registration**: document-actions registered in plugins.js before services
5. **UI typedefs updated**: Moved to document-actions.js and imported in ui.js and toolbar.js
6. **Backend API**: New metadata update endpoint at `/api/v1/files/{stable_id}/metadata`
7. **Database method**: `update_file_metadata()` added to FileRepository
8. **API client regenerated**: `filesMetadata()` method available

The refactoring successfully separates document actions into a dedicated plugin while adding the file metadata editing feature from issue #131.

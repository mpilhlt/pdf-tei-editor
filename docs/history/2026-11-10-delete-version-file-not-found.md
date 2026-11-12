# Error after deleting a version: "File not found"

## Problem

Deleting the current version (and "delete with history", "delete all versions") showed an error dialog `ApiError: File not found: <id>`, with the id of the version just deleted.

## Cause

After the delete, `DocumentActionsPlugin` reloads the file data via `FileSelectionPlugin.reload()` and loads the first option of the xml selectbox. `FileSelectionPlugin.onStateUpdate()` repopulates the selectboxes in a `setTimeout` (to keep the state propagation window short), so when `reload()` returned, the selectbox still listed the deleted version. `ServicesPlugin.load()` then called `acquire_lock` for it, which returned 404.

Reproduced with an E2E test: the server's file list was already current, but the selectbox options were stale.

## Fix

`app/src/plugins/file-selection.js`:

- `reload()` now awaits the repopulation of the selectboxes after reloading the file data, so callers reading `getOptionValues()` afterwards see the current files.
- Populations are serialized by `#requestPopulate()`: a request during a running population makes it run once more with the then-current state, and the returned promise resolves after that run. Previously, a second request during a running population was dropped, which could also leave stale options.

## Test

`tests/e2e/tests/document-actions.spec.js` — "should load the next version without error after deleting the current version": creates a copy, deletes it, and checks that another version is loaded (`VERSION_DELETED` test log) and the deleted id is no longer an option. Fails without the fix.

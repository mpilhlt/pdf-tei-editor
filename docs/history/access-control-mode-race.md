# Access control: mode-loading race and owner fallback (#654)

Follow-up to #646 (PR #648) in `app/src/plugins/access-control.js`.

## Problems

1. **Mode not yet loaded.** `start()` fetches the access control mode asynchronously. A state update for a document that arrived before that fetch completed was evaluated with the default mode `role-based`, and the document was cached in `#xmlCache`. Owner-based or granular checks then never ran for that document during the session.
2. **Wrong field in granular mode.** `#updateDocumentPermissions()` fell back to `fileData?.created_by` for the owner. `getFileDataById()` returns `{ type, item, file }`, so the creator is at `fileData.item.created_by`. The fallback was always empty.

## Changes

- `onStateUpdate()` returns early, without caching the document, while `#accessControlConfig` is `null`.
- `start()` calls `onStateUpdate([])` after loading the mode if a document is loaded and not yet evaluated. `start()` always sets a config (falling back to `role-based` on error), so the deferred evaluation always runs.
- `#updateDocumentPermissions()` uses `fileData?.item?.created_by`.

## Tests

`tests/unit/js/access-control-reload.test.js` gained two cases: a state update before `start()` in owner-based mode (owner toast and read-only state appear once the mode is loaded), and a granular permission change with an unknown current owner (the request carries the artifact creator). Both fail without the fix.

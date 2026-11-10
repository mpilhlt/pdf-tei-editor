# Delete a version with its history

Delete menu entry **Delete current version with its history**: deletes the loaded version and walks up its `parent_stable_id` chain, deleting each ancestor until it reaches one that has another non-deleted descendant. That ancestor and everything above it are preserved. Gold standards are never deleted by this action.

## Backend

- `FileRepository.get_exclusive_history(stable_id)` returns the version followed by its exclusive ancestors, nearest first. The walk stops before an ancestor that is missing, deleted, a gold standard, or has another child.
- `POST /api/v1/files/delete_history` (`files_delete.py`), body `{file_id, dry_run}`, returns `{files, deleted}`:
  - 404 unknown file, 400 gold or non-TEI file, 409 the file itself is frozen (others descend from it).
  - Write access is checked for all files before any is deleted, so the deletion is not left half done on a 403.
  - Files are deleted leaf first. The SSE broadcast and `file.deleted` events are shared with `/files/delete` (`_soft_delete`, `_notify_deleted`).
- The chain is computed on the server because the client file list hides versions the user may not see; a hidden descendant must still protect its ancestors.

## Frontend

- `document-actions.js`: `deleteVersionHistory()` runs a dry run, lists the files in the confirmation, then deletes and loads the first remaining version.
- The entry is enabled for a non-gold, non-frozen, editable version whose parent is a listed non-gold version.
- `ApiClientV1.filesDeleteHistory()` with `DeleteHistoryRequest`/`DeleteHistoryResponse` typedefs.

## Tests

- `tests/unit/fastapi/test_exclusive_history.py`
- `tests/api/v1/files_delete_history.test.js`

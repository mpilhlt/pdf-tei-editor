# Rule drift check on document load

Requested by Christian (2026-11-12): the check whether the document rules are in sync with the guidelines ran only when the document rule editor was opened. It now also runs for every loaded document that the user can edit.

## Behavior

- 2 s after a newly loaded document's resources are listed (`DRIFT_CHECK_DELAY_MS`), for annotators, reviewers and admins, `document-rules.js` calls `refresh/preview`, which says whether "Refresh document rules" would change the document (e.g. a guide changed upstream since the rules were pinned).
- If so, a warning offers to refresh. Confirm runs the refresh directly and reloads the document (`_executeRefresh()`, shared with the "Refresh document rules" menu item). The user does not have to deal with the rule editor.
- Skipped for a read-only document (checked once it becomes editable), when the rule editor is opened first, and for a document whose warning was declined earlier in the page session.

## History

- Christian asked the same day that annotators can update the document rules too: the drift check, the "Refresh document rules" menu item and the `refresh/preview` and `refresh/execute` endpoints accept the annotator role (the server still requires edit access to the document). "Edit document rules" stays reviewer/admin-only.

- PR #761 first opened the rule editor on drift and ran "Update to upstream" or "Update from guide" there. Christian corrected this the same day: the check should only refresh the rules, without the editor. The follow-up fix replaced the check with the refresh preview.

## Tests

- `tests/e2e/tests/document-rules.spec.js`: "refreshes outdated document rules after loading, without the rule editor".

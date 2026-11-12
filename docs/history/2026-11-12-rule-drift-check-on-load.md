# Rule drift check on document load

Requested by Christian (2026-11-12): the check whether the document rules are in sync with the guidelines ran only when the document rule editor was opened. It now also runs for every loaded document that the user can edit.

## Behavior

- After the resources of a newly loaded document are listed (reviewers and admins only, as the "Document rules" menu), `document-rules.js` waits 2 s (`DRIFT_CHECK_DELAY_MS`) so that loading and editing are not delayed, then checks each interpretation-ref category: first `upstream-status` (`refs_behind` or overrides now in upstream), then `sync-status` of its human/machine pair (`machine_outdated`).
- The first category with drift gets a warning confirmation. Confirm opens the rule editor on it and runs "Update to upstream" (which asks about the machine rules afterwards, as before) or opens "Update from guide".
- Skipped for a read-only document (checked once it becomes editable), when the rule editor is opened first, and for a document whose warning was declined earlier in the page session.

## Tests

- `tests/e2e/tests/document-rules.spec.js`: the former "asks to update the machine rules after updating to a changed guide upstream" test now goes through the warning on load; a new test covers the machine-rules-outdated warning on load.

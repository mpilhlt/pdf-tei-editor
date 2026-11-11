# Dismiss and delete review and comment diagnostics

Requested 2026-11-11 as a follow-up to #736: "Dismiss" in the diagnostics drawer by a reviewer should remove all selected diagnostics, not only those with a fix.

Before, the drawer removed the selected diagnostics, but the unit-review and unit-comments plugins derive theirs from the stand-off data and merged them in again on the next refresh. Validation errors and LLM findings already stayed dismissed (their plugins listen with `addDismissListener()`).

## Implementation

- `unit-review.js`: `#onDismissed()` records the dismissed review diagnostics of reviewers (and admins) by unit fingerprint and message; `#updateDiagnostics()` skips them. The set is cleared when a document is loaded.
- `unit-comments.js`: the same for open comment threads, by message.
- Keying by message means an entry comes back when what it says changes (a new or changed mark, a reply), so new feedback is not hidden.
- Dismissing changes no marks or comments, and nothing is saved: the entries are hidden in the current session only. For annotators the entries come back, since they are the reviewers' feedback.

## Delete

Christian added (2026-11-11): since dismissed entries come back after a reload, reviewers need a **Delete** button that removes the diagnostics for good. The review process works by convention: reviewers may delete others' marks and comments, trusting that they do not use it to work around disagreements.

- `lint-utils.js` `addDeleteListener()` / `deleteDiagnostics()`: dismisses the diagnostics, then lets the owning plugins delete the data behind them.
- Diagnostics drawer: **Delete** button, shown to reviewers and admins, enabled in documents they can edit (`deleteChecked()`).
- `unit-review.js` `#onDeleted()`: removes the not-OK marks (current and `was-`, also on the fingerprint before an edit) of all reviewers, including the LLM Reviewer, from the units of the deleted entries. OK marks stay. The diagnostics carry `unitFingerprint` for this.
- `unit-comments.js` `#onDeleted()`: deletes the threads (with replies) of the deleted entries; the diagnostics carry `threadId`.
- Both write the document with history, so Ctrl+Z undoes a delete.

## Tests

- E2E `unit-review.spec.js`: a reviewer's dismissed review entries stay hidden after a refresh and come back with a changed comment; an annotator's come back.
- E2E `unit-review.spec.js`: a reviewer deleting review entries and a comment (marks and thread removed, disputed unit becomes OK); the Delete button is hidden for annotators.
- E2E `unit-review.spec.js`: a reviewer's dismissed comment entry stays hidden after an edit and comes back after a reply.

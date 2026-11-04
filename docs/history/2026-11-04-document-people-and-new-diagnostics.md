# Document people dialog and added diagnostics (#688, #689)

## #688: Scroll to and check added diagnostics

`app/src/plugins/diagnostics-drawer.js` remembers the keys (`diagnosticKey()`: source, severity, message, text) of the diagnostics listed since the document was loaded. On each refresh, the keys not seen before are the added diagnostics:

- The drawer body (the scroll container in the `sl-drawer` shadow DOM, below the sticky header) scrolls so that the added entries are visible, from the first one if they do not fit. The list is sorted by position, so added diagnostics are not necessarily at the end.
- If some added diagnostics have a fix (`replacement`, e.g. LLM review suggestions), the checks are replaced by these, so that they can be applied at once. Added diagnostics without a fix (validation errors, comments, disputed reviews) are never checked (Christian, 2026-11-04).
- A refresh after an edit adds its keys as known without scrolling or checking: editing the text under a diagnostic changes its key.
- Diagnostics that disappear and come back (validation runs replace the set and other sources re-merge theirs) stay known.

## #689: People of a document

- `app/src/modules/document-people.js` (node-testable): `readPeople()` reads `titleStmt/respStmt` persons, merging several `respStmt`s of one `xml:id`, and counts `teiHeader/revisionDesc/change[@who]` (edits) and unit comments by `@resp` (comments). `rolesForUser()` maps user roles to responsibilities (`Annotator` needs `annotator`, `Reviewer` needs `reviewer`, `Commenter` needs only `user`). `addPersonRole()` adds a `resp` to the person's `respStmt` or a new `respStmt` via `tei-utils.addRespStmt()`.
- `app/src/plugins/document-people.js`: toolbar button (`people` icon) in the header group after *Edit header metadata*, shown to all users with a document loaded. The "Add a person" section is shown to reviewers and admins and enabled while the document is editable; adding saves the document. Users come from `GET /api/v1/users` (authentication only).
- Direct messages: `POST /api/v1/messages/direct` (`stable_id`, `recipient`, `text` ≤ 500). Sender and recipient must be able to read the file. Stored as `message` rows with key `d:<doc_id>:<uuid>`, kind and reason `direct`, without occurrences, so re-indexing never touches them; `clear_index()` (rebuild) keeps them. The recipient is notified by SSE `messagesChanged`. The messages dialog shows them (`chat-dots` icon), filters them (`kind=direct`) and replies to them with a direct message to the sender.
- Fixed on the way: the `reply` icon of the messages dialog was not compiled into the icon set (404), since it is only set from JS; it is now listed in `messages-dialog.html`.

Not done: removing people or responsibilities from the dialog (edit the XML).

## Tests

- `tests/unit/js/document-people.test.js`, `tests/unit/fastapi/test_messages_indexer.py` (`TestDirectMessages`), `tests/api/v1/messages.test.js` (direct messages)
- E2E: `tests/e2e/tests/document-people.spec.js`, `tests/e2e/tests/diagnostics-drawer.spec.js` (#688 test)

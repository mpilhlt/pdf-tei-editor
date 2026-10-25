# Review request messages

Saving a revision whose status is `in-review` sends a message to all users with the `reviewer` role. Opening it loads the document with unit review mode on.

## Implementation

- `fastapi_app/lib/messages/indexer.py`: `_review_request(root)` walks `teiHeader/revisionDesc/change` backwards while `@status` is `in-review` and returns the first change of that run. Its `@when` is part of the key `q:{doc_id}:{variant}:{when}`, so further in-review revisions keep the same message, and a new review episode (status changed in between) gets a new key. Author is the change's `@who`, text its `desc`. Recipients are all users with the `reviewer` role except the author; access to the document is checked when listing, as for the other messages.
- When the last change is no longer `in-review`, the occurrence is kept as settled with the note `status-changed` (like `r:` keys).
- `UserInfo.roles` is filled from the user database in `default_index_context`.
- Message `kind` `review-request`, `reason` `reviewer`. The `review` kind filter includes `q:` keys.
- `app/src/plugins/messages.js`: own icon and colour, no reply button, opening enables review mode.

## Tests

- `tests/unit/fastapi/test_messages_indexer.py` (`TestReviewRequests`)
- `tests/api/v1/messages.test.js`: an annotator saves an in-review version, the reviewer receives the request, which settles after a status change.

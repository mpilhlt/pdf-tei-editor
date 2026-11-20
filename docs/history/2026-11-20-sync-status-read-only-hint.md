# Sync status line in read-only documents

The document rule editor's sync status line ("Machine rules outdated: the guide changed since the last sync") links to **Update from guide**, and "both changed" links to **Mark as in sync**. Both actions store an override in the document, so the links (and the **Update from guide** button) are hidden when the document is read-only. The line then gave no way to act on the warning.

Change: for a read-only document, the line says that the document is read-only and that a version the user can edit is needed to update the machine rules (or mark them as in sync). `SYNC_STATUS_READ_ONLY_HINT` in `app/src/plugins/document-rules.js`; unit tests in `tests/unit/js/document-rules.test.js`; user manual `docs/user-manual/unit-review.md`.

Not done: letting the update run without a writable document (generate the machine rules and propose them upstream directly, without an override in the document).

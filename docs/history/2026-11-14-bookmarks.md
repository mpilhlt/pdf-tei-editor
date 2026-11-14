# Bookmarks

Requested by Christian (2026-11-14): private bookmarks on sub-elements of `/TEI/text`, added from the XML editor's context menu with a small title prompt like the one of unit comments, listed under an entry in the user menu in a list styled like the messages; clicking a bookmark opens the document and selects the element.

## Design

- **Storage**: server-side, per user, in `data/db/bookmarks.db` (`fastapi_app/lib/bookmarks/store.py`), not in the TEI file. Bookmarks are private and must work in read-only documents, so writing them into the `standOff` (like comments) was not an option. Browser storage was rejected because bookmarks should follow the user across browsers.
- **Anchor**: the file's `stable_id`, the element's XPath and its content fingerprint, written by `elementPath()` and `FingerprintCache` of `app/src/modules/node-anchor.js`. Opening a bookmark resolves the anchor with `resolveAnchor()`, so the element is found after insertions before it (match `moved`) or after an edit of its content (match `edited`).
- **Scope**: the server only accepts XPaths below `/TEI/text` (`TEXT_ELEMENT_PATH` in `routers/bookmarks.py`) of TEI files the user can view. The context-menu entry is disabled elsewhere.
- **API** (`/api/v1/bookmarks`): `GET` (optional `stable_id` filter), `POST`, `PATCH /{id}` (rename), `DELETE /{id}`. All queries are restricted to the current user; another user's bookmark id gives 404. Items carry `available: false` when the file was deleted or the user lost access.
- **Live updates**: changes send `bookmarksChanged` to the user's other sessions; an open dialog reloads.
- **Deletion with the file** (Christian, 2026-11-14): the `file.deleted` event handler (`on_file_deleted` in `store.py`) deletes the bookmarks of a deleted file, for all users, and sends `bookmarksChanged` to their owners. A restored file therefore has no bookmarks.
- **Cleanup**: GC task `bookmarks` (order 610, after the file purge) removes bookmarks of files that are deleted or purged without the event (e.g. by synchronization) and of removed users.

## Frontend

- Plugin `app/src/plugins/bookmarks.js`, templates `bookmarks-dialog.html` and `bookmarks-menu-item.html`.
- Context menu: "Bookmark…" is prepended to the editor's context menu (above "Comment…"). The prompt is `openCommentPrompt()` of `unit-review-popover.js`, which gained the options `maxLength` and `selectAll`; the proposed title is the start of the element's text, selected so that typing replaces it.
- Dialog: "All documents / This document" switch (opens on "This document" when the open document has bookmarks), client-side search, inline rename, delete.
- `relativeTime()` moved from `messages.js` to `app/src/modules/relative-time.js`; `DocLabels` moved from `routers/messages.py` to `fastapi_app/lib/repository/doc_labels.py`, both shared by messages and bookmarks.

## Tests

- `tests/unit/fastapi/test_bookmarks.py`: store, privacy, path validation, unreadable and non-TEI files, rename/delete, unavailable files, deletion on `file.deleted`, GC (incl. dry run).
- `tests/e2e/tests/bookmarks.spec.js`: context menu (disabled in the header), title prompt, dialog from the user menu, rename, opening after an insertion before the element, privacy against another user, delete, deletion of the bookmarks with the document.

## Not done

- No gutter marker for bookmarked elements in the editor.
- No keyboard shortcut for adding a bookmark.

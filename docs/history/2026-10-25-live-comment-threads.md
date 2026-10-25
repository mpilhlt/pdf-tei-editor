# Live comment threads in the owner's editor (2026-10-25)

Requested by Christian after #629, which made other users' review marks appear live in the owner's open editor.

## Change

- When the stand-off endpoint (`PUT /api/v1/files/{stable_id}/standoff`) changes the unit comment list of a file, it sends `commentsChanged` (`stable_id`, `author`, `author_name`, `list_xml`: the stored `listAnnotation[@type="unit-comment"]`, null when it was removed) to the other sessions, after the `commentReplyAdded` events of new replies, which keep announcing replies with a toast.
- The unit comments plugin of an editor that has the document open and can edit it merges the author's changes into the open document with `mergeAuthorComments()` (`app/src/modules/unit-comments.js`): the author's comments are added, replaced or removed, the author's resolve/reopen changes on other threads are added, and replies of threads the author deleted are removed. Everything else, including unsaved local edits of the owner's own comments, stays. The write does not go into the undo history; the owner's next save keeps the comments (`merge_foreign_standoff`). A new thread shows a toast.
- Documents that are read-only for the user are reloaded instead (since #629).
- The author's name is taken from the event until the owner's document has the author's `respStmt`.

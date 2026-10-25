# Unit review follow-ups (2026-10-25)

Requested by Christian after the merge of #623.

## Changes

- **Automatic review mode.** `UnitReviewPlugin#onDocumentLoaded` switches review mode on when the loaded document has units whose combined state is not OK or disputed. The choice is not stored in UIStorage (`setEnabled(enabled, {remember: false})`). Review mode switched on this way is switched off again when a document without such units is loaded; toggling it by hand ends that.
- **Review popover for non-reviewers.** `openReviewPopover` takes `hideOwn`: the "Your review" and "Comment" rows and the final review box are left out, and the list is headed "Reviews". The plugin sets it for users without the *reviewer* or *admin* role. Reviewers in documents they cannot review (e.g. superseded versions) still see the disabled rows.
- **Read-only documents follow other users' saves.** The XML editor plugin listens to the SSE event `fileDataChanged` with the reasons `file_saved`, `standoff` and `comment_reply`. If the event is about the open document and the document is read-only for the user, it reloads the document 2 s after the last such event (so a series of autosaves reloads it once), keeping the cursor line and the scroll position. Before the reload, the user's own unsaved marks and comments are saved through the stand-off endpoint; the reload is postponed while the focus is in an input field outside the editor (e.g. a review comment). The events are sent only to other sessions, so a user's own saves do not trigger it.

- **Units changed after a not-OK review.** An edited unit whose carried-over (`was-`) marks include a not OK and that has no current mark gets an info diagnostic "Changed after a not-OK review (…), please check again" with the usual OK / not OK / open review actions. `Shift+F7` stops at these units, and they also turn review mode on. Edited units that were only marked OK keep their grey dashes without a diagnostic. Before, such units dropped out of the diagnostics and looked like any other open unit (Christian, 2026-10-25).

- **Diagnostics drawer flicker.** A source replacing the diagnostic set (e.g. a validation run) removes the diagnostics of the other sources, which re-merge them in a `setTimeout(0)`. The drawer refreshed in an animation frame, which often came in between and showed the list without them for a frame. It now refreshes 100 ms after a change.
- **Draft restore prompt in a reloaded read-only document.** `#flushDraftNow` wrote a draft whenever its timer fired, also while a document was loading (the editor counts as dirty until it is ready). When a read-only document then followed another user's save, the draft of the old content differed from the new server content and the restore prompt appeared. Drafts are now written only for unsaved work in a ready editor, and following a save clears the draft first.

- **Live review marks in the owner's editor.** When the stand-off endpoint stores a change of the user's own review annotation, it sends `reviewMarksChanged` (`stable_id`, `reviewer`, `reviewer_name`, `annotation_xml`, null when the review was removed) to the other sessions. The unit review plugin of an editor that has the document open and can edit it replaces that reviewer's annotation in the document (not in the undo history), so the strip, the meter and the diagnostics update without a reload, and switches review mode on if it is off. The owner's next save keeps the annotation (`merge_foreign_standoff`). The reviewer's name comes from the event until the owner's document has the reviewer's `respStmt`.

## Not done

- New comment threads of other users are not merged live into the owner's editor; only replies are (`commentReplyAdded`).

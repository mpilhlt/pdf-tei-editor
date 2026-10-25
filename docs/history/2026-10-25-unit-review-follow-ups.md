# Unit review follow-ups (2026-10-25)

Requested by Christian after the merge of #623.

## Changes

- **Automatic review mode.** `UnitReviewPlugin#onDocumentLoaded` switches review mode on when the loaded document has units whose combined state is not OK or disputed. The choice is not stored in UIStorage (`setEnabled(enabled, {remember: false})`). Review mode switched on this way is switched off again when a document without such units is loaded; toggling it by hand ends that.
- **Review popover for non-reviewers.** `openReviewPopover` takes `hideOwn`: the "Your review" and "Comment" rows and the final review box are left out, and the list is headed "Reviews". The plugin sets it for users without the *reviewer* or *admin* role. Reviewers in documents they cannot review (e.g. superseded versions) still see the disabled rows.
- **Read-only documents follow other users' saves.** The XML editor plugin listens to the SSE event `fileDataChanged` with the reasons `file_saved`, `standoff` and `comment_reply`. If the event is about the open document and the document is read-only for the user, it reloads the document 2 s after the last such event (so a series of autosaves reloads it once), keeping the cursor line and the scroll position. Before the reload, the user's own unsaved marks and comments are saved through the stand-off endpoint; the reload is postponed while the focus is in an input field outside the editor (e.g. a review comment). The events are sent only to other sessions, so a user's own saves do not trigger it.

- **Units changed after a not-OK review.** An edited unit whose carried-over (`was-`) marks include a not OK and that has no current mark gets an info diagnostic "Changed after a not-OK review (…), please check again" with the usual OK / not OK / open review actions. `Shift+F7` stops at these units, and they also turn review mode on. Edited units that were only marked OK keep their grey dashes without a diagnostic. Before, such units dropped out of the diagnostics and looked like any other open unit (Christian, 2026-10-25).

## Not done

- The owner's editable editor still does not merge other users' stand-off changes live, except comment replies.

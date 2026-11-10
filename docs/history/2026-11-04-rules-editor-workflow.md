# Rules editor workflow fixes (#702)

Fixes to the workflow of the document rules editor dialog and its "Update machine rules from guide" and "Propose upstream" sub-dialogs, in `app/src/plugins/document-rules.js`.

## Changes

| Issue item | Change |
| --- | --- |
| Dirty editor loses its content | `_isDirty()` compares the shown text and note with the selected override. `_resolveUnsavedEdits()` asks "Save them? Otherwise they are lost." before a layer-tab switch, selecting another override, opening "Update from guide" or "Propose change upstream", and closing the dialog (Close button and `sl-request-close`, i.e. Escape, header close button). Confirm saves, decline discards. A failed save keeps the user where they are. |
| Save button tied to the dirty state | `_renderSaveButton()` sets `saveBtn.disabled = !_isDirty()`; called on render, after save, on CodeMirror doc changes (update listener on both views) and on note input. |
| Link from the outdated status | `machine_outdated` gets an "Update from guide" link that runs `_openUpdateDialog()`, also from the guide tab. |
| Generated diff hidden | `_onGenerate()` scrolls the "Proposed machine rules" heading into view. |
| Misleading "outdated and edited by hand" | `both_changed` now reads "Guide and machine rules both changed since the last sync. If the machine rules already match the guide, propose both upstream to record the sync", with a "Propose change upstream" link. |
| Pull request message hidden | The result line is scrolled into view. |
| Instructions after the merge | Added below the result: close the dialog after the merge and use "Update to upstream". |
| Refresh after closing | Closing the propose sub-dialog refreshes the sync and upstream status. The "Update to upstream" text in the upstream status line is a link with the button's action (plain text for a read-only document). |

## Backend: `refetch` on `/document-rules/upstream-status`

The branch head SHA is cached for an hour (`UrlCache`, `resolve_ref_to_sha()`). Right after a merge the upstream status would still see the old head, so `refs_behind` stayed false and "Update to upstream" re-pinned to the old commit and removed no overrides. `UpstreamStatusRequest.refetch` makes the status route use a `UrlCache` with a TTL of 0: all lookups of that request are fetched anew and written back, so the following `refresh-resource` and `remove-overrides-in-upstream` calls see the new head. The editor sends it only when the propose sub-dialog closes after creating a pull request.

Remaining limit: `raw.githubusercontent.com` caches branch files for a few minutes, so a status checked within minutes of the merge can still show the old section text.

## Tests

- `tests/unit/js/document-rules.test.js`: "editing workflow (#702)" block (save button, unsaved-changes prompt per trigger, status line links, refresh on close), plus updated texts and scroll assertions.
- `tests/unit/fastapi/test_document_rules_router.py`: `test_status_uses_the_cache_ttl_unless_refetch_is_set`.

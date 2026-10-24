# Document history: read teiHeader/revisionDesc only

## Problem

Unit review and unit comment annotations in `TEI/standOff` have `revisionDesc/change` elements of their own. Readers that queried `//revisionDesc/change` took those as part of the document history:

- `extract_last_revision_status()` and `extract_revision_timestamp()` returned a comment's `resolved` status and date as the document's lifecycle status and last revision (used by `files_repopulate.py` and migrations m005/m006).
- `extract_change_signatures()` counted comment and review changes, so the version ancestry chains compared stand-off data.
- `getRevisionLabel()`, the revision history in `tei-tools.js` and the Save Revision dialog's last change read the whole document; `addRevisionChange()` appended to a stand-off `revisionDesc` when the header had none.

The save path (`extract_tei_metadata()`) was not affected, since it took the first `revisionDesc`.

## Fix

- `fastapi_app/lib/utils/tei_utils.py`: `HEADER_CHANGE_PATH` and `get_header_changes()`, used by all readers; `add_revision_change()` and `rules_refresh._add_revision_change()` look for `revisionDesc` as a child of `teiHeader`.
- Frontend: selectors and XPaths scoped to `teiHeader > revisionDesc > change`.
- Tests: `TestHeaderChangesIgnoreStandOff` (Python) and "document history ignores stand-off revisionDesc" (JS).

Existing `status` and `last_revision` values in `metadata.db` that were computed by the old readers (repopulate) are corrected by running repopulate again.

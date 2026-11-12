# Rule editor missed a guide change merged upstream

## Problem

After a pull request to the annotation guide (mpilhlt/fossil, `docs/guidelines.md`, merged 2026-11-12 15:27 UTC) the document rule editor's "Citation model guidelines" dialog still showed "In sync with the guide" and no "guide upstream has changed" warning.

## Cause

- The sync status line compares the guide and machine sections the document is pinned to (commit SHAs). It cannot show an upstream change by itself; that is the job of the upstream status (`refs_behind`) and the warning on open.
- `refs_behind` is computed by re-building the document's refs from the GROBID plugin's configuration, which resolves the guide's branch URL to a commit SHA via `resolve_ref_to_sha()`. That lookup was cached with the default `UrlCache` TTL of one hour, so within an hour of the last lookup the old head was used and the refs looked current.
- The editor only sends `refetch: true` after it created a pull request itself, which a merge made elsewhere does not trigger.

## Fix

- `UrlCache.get_text()` takes `max_age_seconds`, which can only lower the TTL. The GitHub and GitLab adapters read branch heads and branch commit listings with `BRANCH_HEAD_TTL_SECONDS` (120 s), so a merge shows within two minutes, at most one forge API call per branch and interval.
- After "Update to upstream", if the pair is then `machine_outdated`, the editor asks whether to update the machine rules from the guide and on Confirm opens "Update from guide".
- `dialog.confirm()` now resolves after the dialog has finished hiding. Before, a confirmation shown right after another one received the first one's late `sl-hide` and closed itself.

## Tests

- Unit: `max_age_seconds` in `test_url_cache.py`; a stale branch head is resolved anew in `test_git_forge_adapters.py`.
- E2E: `document-rules.spec.js` "asks to update the machine rules after updating to a changed guide upstream".

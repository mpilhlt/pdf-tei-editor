# Plugin pages and routes without session ids in URLs (#734)

Follow-up to #731 / #732, which opened plugin pages with a launch token and authenticated them with the `pte_plugin_session` cookie. Core kept accepting the `session_id` query parameter for plugins that still read or declared it. This change removes it everywhere.

## pte-plugins (mpilhlt/pte-plugins, branch `claude/project-thread-p4y30n`)

One `fix(<plugin>)` commit per plugin, so each plugin gets a patch release.

- Routes of annotation-history, annotation-progress, collection-overview, edit-history, grobid, iaa-analyzer, inference-endpoints, kisski, local-sync, metadata-extraction, mpcdf-llm, revision-feed, rng-converter, update-metadata and webdav-sync no longer declare `session_id: str | None = Query(None)` / `x_session_id` and hand-written session checks. They use `Depends(require_authenticated_user)`, `require_admin_user` or `require_reviewer_or_admin`. Routes that send SSE events to the caller take `session_id: str = Depends(require_session_id)`.
- Pages that read `session_id` from `location.search` (collection-overview `view.js`, metadata-extraction `backfill.js`, mpcdf-llm `manage.html`) now use plain `fetch()`; the sandbox script adds the header.
- iaa-analyzer no longer appends `&session_id=` to its export and diff URLs; edit-history no longer reads the unused `_session_id`.
- Tests send `headers={"X-Session-ID": ...}`. Error details now come from the core dependencies (`Session expired`, `Authentication required`, `Admin access required`).
- `engines.pte` of the changed plugins is `>=0.83.0`, the first release with #732.

## Core

- `active_sessions`, `backup_restore`, `document_search`, `log_viewer` routes use the authentication dependencies; their tests send the header.
- `PluginWindowAuthMiddleware`: `LEGACY_SESSION_PARAM` and the `"null"`/`"undefined"` values are gone. The cookie fills in the session when the request has no (or an empty) `X-Session-ID` header, and the launch-token redirect only strips `launch`.
- `_SESSION_HEADER_SCRIPT`: adds the header only when the request sets none; no special handling of empty values.
- `createLaunchUrl()` no longer strips `session_id`.
- `_session_id` in the execute params stays: webdav-sync uses it as SSE client id. It is documented in `backend-plugins.md`.
- Documentation (`fastapi_app/CLAUDE.md`, `tests/CLAUDE.md`, `backend-plugins.md`, `testing-guide.md`, `plugin-system-backend.md`, `class-dependencies.md`, `server-progress.md`) shows the dependency-based authentication only.

## Merge order

The core change should ship with the migrated plugins: older plugin pages send an empty `X-Session-ID` header, which the sandbox script no longer replaces with the opening tab's session, so those requests fall back to the profile-wide cookie. While the pte-plugins PR is open, the core PR pins all plugins to its branch head so CI tests the pair. After the pte-plugins PR is merged, its release workflow opens the pin bump PR against `devel`; the core PR then drops its own pin commit and is rebased onto that.

## Out of scope

`/api/v1/sse/subscribe?sessionId=…` and `/api/v1/import?sessionId=…` in the main app still carry the session id in the URL (#246).

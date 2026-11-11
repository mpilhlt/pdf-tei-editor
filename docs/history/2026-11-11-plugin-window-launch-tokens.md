# Plugin window launch tokens

Issue: #731 (narrows point 1 of #246).

## Problem

Backend plugin pages (result dialog iframe, "open in window", `sandbox.navigateIframe()`, `sandbox.openControlledWindow()`) were loaded with `?session_id=<session id>`. Browsers always show the address bar of popups, and the session id also ended up in the browser history, the access logs and `Referer` headers.

## Implementation (option C of the issue)

- `SessionManager.create_launch_token()` / `consume_launch_token()` (`fastapi_app/lib/core/sessions.py`): random single-use tokens, valid 60 s, stored as SHA-256 hashes in the new `launch_tokens` table of `sessions.db` (migration 013), so they work across workers.
- `POST /api/v1/plugins/launch-token` (`fastapi_app/routers/plugins.py`) creates a token for the calling session.
- `PluginWindowAuthMiddleware` (`fastapi_app/lib/plugins/plugin_window_auth.py`), for paths under `/api/plugins/`:
  - `GET`/`HEAD` with `?launch=<token>`: redeems the token, sets the cookie `pte_plugin_session` (HttpOnly, `SameSite=Strict`, `Path=/api/plugins/`, `Secure` over HTTPS incl. `X-Forwarded-Proto`), and answers `303` to the same URL without `launch` and `session_id`. Invalid, used or expired token: `401` HTML page.
  - Requests without their own session id (no `X-Session-ID` header, no `session_id` query parameter; `""`, `null` and `undefined` count as none) get the cookie's session id as `X-Session-ID` header. Existing plugin routes therefore work unchanged, and the legacy query parameter keeps working for older clients and pages.
  - Non-safe methods authenticated by the cookie are rejected with `403` if `Origin` names another host.
- Logout deletes the cookie.
- Frontend: `PluginSandbox.createLaunchUrl()` replaces `session_id` with a launch token for same-origin `/api/plugins/` URLs. It is used by `displayResultInIframe`, the open-window button, `configureExecuteButton`, `navigateIframe` and `openControlledWindow`. Windows open as `about:blank` synchronously and are navigated once the token is there, to keep the user activation. `triggerDownload` authenticates with the header only.
- Core plugin pages (active-sessions, backup-restore, document-search, log-viewer) no longer read `session_id` from the URL. The log viewer takes the id of the opening tab from `sandbox.getCurrentState()` and sends it as header, because its log events reach the page through that tab's SSE stream.

## Decision

The cookie belongs to the browser profile, not to a tab: the most recently opened plugin page decides which session plugin pages without their own session id use. Christian accepted this by choosing option C (2026-11-11).

## Follow-up

- pte-plugins: drop the `session_id` reads from `location.search` and the server-built `&session_id=` URLs (iaa-analyzer).
- Remove the legacy `session_id` query parameter once no plugin relies on it.

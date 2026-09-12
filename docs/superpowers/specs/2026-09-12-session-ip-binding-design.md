# Session IP-Binding + Absolute TTL — Design Spec

Date: 2026-09-12
Status: Approved for planning

## Problem

Several backend plugins let the user open content in an independent browser
window or iframe via a GET request, passing `session_id` as a query
parameter. This is not an isolated oversight — it's structural:

- `SessionManager.is_session_valid()` (`fastapi_app/lib/core/sessions.py`)
  treats `session_id` as a pure bearer token: it checks only existence and a
  sliding `last_access` timeout. No IP, user-agent, scope, or single-use
  binding exists today. Whoever presents the string is fully authenticated as
  that user.
- ~17 plugin route files independently hand-roll their own
  `session_id: Query(None)` + `X-Session-ID` header extraction and call
  `session_manager.is_session_valid(...)` directly, instead of using the
  app's existing `require_authenticated_user` dependency
  (`fastapi_app/lib/core/dependencies.py`). This duplication means a fix has
  to be applied ~17 times by hand.
- The frontend actively embeds `session_id` into `window.open()` targets and
  iframe `src` (`app/src/plugins/backend-plugins.js`,
  `app/src/modules/backend-plugin-sandbox.js`), and several plugins embed it
  in generated HTML links (`iaa_analyzer`, `backup_restore`,
  `document_search`).
- Each malicious replay of a leaked `session_id` resets `last_access`,
  extending the attacker's window indefinitely instead of the session
  expiring.

Leak vectors for a URL-embedded session token: browser history (synced to
cloud), `Referer` headers to any third-party asset the opened window/iframe
loads, server/proxy access logs, screen-shares/screenshots. Since presenting
the token is fully equivalent to being logged in as that user, any leak is a
full account-session takeover for as long as the token stays valid.

## Goal

Harden the existing session-token bearer-auth model with two independent
controls:

1. **IP-binding** — a session is only valid when presented from the IP it
   was created from.
2. **Absolute session TTL** — a session expires after a fixed maximum age,
   regardless of how often it's (ab)used to reset the sliding idle timeout.

Centralize the ~17 plugins' duplicated auth-check code onto the app's
existing `require_authenticated_user` dependency as part of this work, since
IP-binding cannot be added 17 times independently without first removing the
duplication.

**Non-goals**: this does not replace `session_id`-in-URL with a short-lived
single-use exchange-token flow for the highest-value plugins
(`backup_restore`, `log_viewer`, etc.). That is a further hardening step,
tracked as separate follow-up work, and is not designed here — IP-binding
and the TTL cap are a mitigation, not a full fix, for the underlying
anti-pattern of putting a bearer credential in a URL.

## Data model change

Add one column to `sessions` (`fastapi_app/lib/core/sessions.py`):
`ip_address TEXT`, nullable. No new column is needed for the absolute TTL —
`created_at` already exists; the check is simply
`now - created_at <= max_age`.

Add via the existing versioned-migration infrastructure
(`fastapi_app/lib/core/migrations/versions/`, pattern from
`m001_locks_file_id.py`; see `docs/development/migrations.md`). The column is
nullable so existing sessions degrade gracefully: a session created before
the migration has `ip_address IS NULL` and is treated as unbound (no IP
check applied to it), naturally falling off once its sliding or absolute
timeout lapses. No forced mass logout on deploy.

## Getting the real client IP

Nginx is the documented production front door
(`docs/development/securing-server.md`, `bin/generate-nginx-config.sh`) but
is not enforced by the app — `deploy.js`/`container.js` support
`--no-nginx`, and nothing prevents uvicorn from being exposed directly.
`X-Forwarded-For`/`X-Real-IP` are currently set by nginx but ignored
entirely by the backend (zero references in `fastapi_app/`); only
`request.client.host` (the raw socket peer) is available today.

Design: wrap the ASGI app in `fastapi_app/main.py` with
`uvicorn.middleware.proxy_headers.ProxyHeadersMiddleware`, with
`trusted_hosts` set to loopback (`127.0.0.1`, `::1`) — nginx runs on the same
host/container as uvicorn per the documented deployment. Forwarded headers
are honored only when the immediate peer is loopback; otherwise
`request.client.host` is used as-is. This is correct both for the documented
(nginx + same-host) and undocumented (direct-exposure) deployment modes,
without trusting a spoofable header from an untrusted peer.

New config key `proxy.trusted_hosts`, default `["127.0.0.1", "::1"]`, read
via `config_utils.get_config()` — kept configurable in case a future
deployment runs nginx in a separate container/host, even though today's
docs assume same-host.

## Enforcement logic

- `SessionManager.create_session()` takes and stores the caller's IP
  (`ip_address` column).
- `SessionManager.is_session_valid()` gains a `client_ip` parameter and an
  absolute-age check. A session is valid iff:
  - it exists,
  - `now - last_access <= idle_timeout` (existing sliding-window check),
  - `now - created_at <= max_age` (new absolute cap), **and**
  - `session.ip_address is None or session.ip_address == client_ip`.
- **On IP mismatch**: reject that request only (401). The session record
  itself is untouched — the legitimate owner on their real IP is
  unaffected; a mismatched request is treated as if unauthenticated.
- New config key `session.max_age`, default 12h (43200 seconds), read the
  same way as the existing `session.timeout` via
  `config_utils.get_config()`.

## Centralizing the 17 plugins

`fastapi_app/lib/core/dependencies.py` already defines
`require_authenticated_user`, which does session-id extraction + validity
check + user lookup + sliding-timeout refresh — it is simply not used by the
plugins, which each hand-roll their own version instead. There is also a
naming mismatch: the shared `get_session_id_from_request()`
(`fastapi_app/lib/utils/server_utils.py`) checks header `X-Session-Id` →
query `sessionId` → cookie `sessionId`, while the 17 plugins (and the
frontend, and the documented plugin-route pattern in
`fastapi_app/CLAUDE.md`) use query param `session_id` (snake_case).

Plan:

1. Extend `get_session_id_from_request()` to also accept `session_id` as a
   query-param alias, so it covers what's already deployed across the
   frontend and all 17 plugins without a breaking rename.
2. Thread `client_ip` (from `request.client.host`, correct given the
   `ProxyHeadersMiddleware` change above) through
   `SessionManager.is_session_valid()` calls inside `require_authenticated_user`
   and the other dependency-layer helpers in `dependencies.py`.
3. Refactor each of the 17 plugin routes to depend on
   `require_authenticated_user` (or a thin plugin-specific wrapper around it,
   where a route needs the user object in a different shape) instead of
   their own hand-rolled `Query`/`Header`/`is_session_valid` block.

Caveat surfaced during investigation: at least one of the 17
(`webdav_sync/routes.py`) uses `_session_id` as an SSE pub/sub client
identifier, not strictly as an auth credential. Each of the 17 needs
individual triage during implementation to confirm it's a straight
auth-check replacement and not something subtler (e.g. an identifier that
must remain stable independent of auth outcome).

Affected plugin route files (from investigation, `Query(None)`
`session_id` declarations):

- `kisski/routes.py`
- `metadata_extraction/routes.py`
- `rng_converter/routes.py`
- `log_viewer/routes.py`
- `backup_restore/routes.py`
- `edit_history/routes.py`
- `collection_overview/routes.py`
- `webdav_sync/routes.py` (needs triage, see caveat above)
- `tei_annotator/routes.py`
- `iaa_analyzer/routes.py`
- `local_sync/routes.py`
- `active_sessions/routes.py`
- `grobid/routes.py`
- `annotation_progress/routes.py`
- `annotation_history/routes.py`
- `update_metadata/routes.py`
- `document_search/routes.py`

## Testing

- Unit tests for `SessionManager`: IP match, IP mismatch, absolute-TTL
  boundary (just under/over `max_age`), sliding-TTL boundary (existing
  behavior, unchanged), null-IP (pre-migration) sessions bypass the IP
  check.
- Migration test in `fastapi_app/lib/core/migrations/tests/`, per the
  project's migration-testing convention (manual verification, not part of
  CI).
- Dependency test for the extended `require_authenticated_user`: mismatched
  IP → 401, matching IP → passes, legacy null-IP session → passes.
- At least one refactored plugin route covered by an integration test
  hitting both the IP-match and IP-mismatch paths, to serve as the template
  for triaging/refactoring the remaining 16.

## Out of scope (follow-up work)

A short-lived, single-use exchange-token flow for the "open in new
window/iframe" plugins that carry the most sensitive content (e.g.
`backup_restore`, `log_viewer`). Under that design, the window/iframe would
receive a token valid for a short window (e.g. 60s), scoped to one action,
exchanged immediately for a real session and invalidated after first use —
eliminating the leak risk for those flows rather than narrowing its blast
radius. Not designed further here; tracked as a separate spec when
prioritized.

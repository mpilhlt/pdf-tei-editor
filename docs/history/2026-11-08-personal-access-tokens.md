# Personal access tokens (issue #709)

Implements phase 1 of [#709](https://github.com/mpilhlt/pdf-tei-editor/issues/709): reviewers and admins create, list and revoke personal access tokens in the user menu, and scripts exchange a token for a normal session instead of logging in with a password.

## What was built

- `fastapi_app/lib/core/access_tokens.py`: `AccessTokenStore` in `data/db/access_tokens.db`. Tokens are `pte_<id>_<secret>` (8 base32 characters, 32 random bytes); only `sha256(secret)` is stored and compared with `hmac.compare_digest`. `verify()` rejects unknown, revoked and expired tokens and records `last_used_at`. Helpers `revoke_token()` (also ends the token's sessions), `revoke_user_tokens()` and the GC task `access-tokens`, which removes tokens revoked or expired more than 30 days ago.
- `fastapi_app/lib/permissions/access_token_permissions.py`: the permission rules proposed in the issue (admins: everyone; reviewers: themselves and users whose roles are a subset of their own, never privileged roles they lack; others: nobody). Everyone can see and revoke tokens for themselves; reviewers also the tokens they created.
- `fastapi_app/routers/access_tokens.py`: `GET/POST /api/v1/auth/tokens`, `DELETE /api/v1/auth/tokens/{token_id}`, `GET /api/v1/auth/tokens/eligible-users`.
- `POST /api/v1/auth/token-login` in `fastapi_app/api/auth.py`: `Authorization: Bearer pte_...` (or `{"token": ...}` in the body, used by the frontend API client) returns the same `LoginResponse` as `/auth/login`.
- Sessions: migration 012 adds `token_id` and `expires_at` to `sessions.db` (new `SESSIONS_MIGRATIONS` list, run by `SessionManager._init_db`). Revoking a token deletes its sessions, and a token session cannot outlive the token's expiry.
- Failed-login rate limit (`fastapi_app/lib/core/login_rate_limit.py`), as there was none: 10 failures per 5 minutes (config `auth.login.max-failures`, `auth.login.failure-window`), keyed by client address and username for password logins (so that clients behind one reverse-proxy address do not lock each other out) and by client address for token logins. In-memory per server process.
- Deleting a user (users router and `user_utils.remove_user`, used by `manage.py user remove`) revokes the user's tokens.
- Active sessions plugin shows "via access token '<label>'" and now HTML-escapes the owner column.
- Frontend: `app/src/plugins/access-tokens.js` with the "Access Tokens" user menu entry below "API Keys" (reviewers and admins), dialog with token table, "New token" form (label, user, expiry) and a one-time panel with the token and a `.env` line.
- CLI: `bin/manage.py token create|list|revoke` (server-side bootstrap), `manage-remote.js token list|create|revoke`, `--token`/`API_TOKEN` in `batch-extract.js`, `manage-remote.js` and `scripts/dev/debug-api.js` through the shared helper `bin/lib/api-auth.js`.

## Decisions on the open questions of the issue

1. Reviewer rule: implemented as proposed (subset of the reviewer's roles).
2. Real users vs. service users: tokens can be created for real users; the dialog warns that changes are attributed to the selected user, and the user manual recommends a dedicated user for scripts.
3. Phase 2 (direct Bearer authentication on every request): not implemented; token-login covers the bundled scripts.
4. Replacing passwords: for scripts only. Deprecation warnings for `API_USER`/`API_PASSWORD` (phase 3) are left for later.

Config keys use the repository's hyphenated style (`auth.access-tokens.max-days`, `auth.access-tokens.allow-no-expiry`) instead of the underscores in the issue.

## Not done

- `ApiSession.from_token()` in the auto-annotation client of mpilhlt/pte-plugins: separate PR once this is released.
- `manage.py` is deprecated, but `manage.py token create` is the only way to create a first token without the web interface; it should survive the removal of the rest of the script.

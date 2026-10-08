# Revision Feed Plugin — Design Spec

Date: 2026-10-07

## Purpose

Let users follow new document revisions without opening the application, via a
standard Atom feed they can subscribe to in any feed reader.

## Scope

One feed per project (the existing `members`/`collections` grouping in
`fastapi_app/routers/projects.py`), authenticated by a per-user token embedded
in the feed URL (not HTTP Basic Auth — feed readers handle URL tokens more
reliably, and it avoids exposing the app's unsalted-SHA-256 login password
hash on a new, publicly-pollable endpoint).

A feed entry is one TEI `<revisionDesc><change>` element whose `status`
attribute is in a configurable allowlist. Every qualifying `<change>` produces
its own entry (not just the latest per document), matching the existing
`edit_history` plugin's parsing approach but extended to all changes instead
of only the last one.

## Out of scope (YAGNI, can follow later if needed)

- Feed response caching (generate on every request; revisit only if load
  becomes a real problem).
- Shared/project-level tokens for non-account holders.
- Any status other than Atom (no RSS 2.0 variant).

## Architecture

New backend plugin: `fastapi_app/plugins/revision_feed/`.

- `plugin.py` — metadata, registers config key `revision_feed.included_statuses`
  (default: `annotation.lifecycle.order` from `config/config.json` minus
  `"extraction"`, i.e.
  `["unfinished", "draft", "checked", "in-review", "approved", "candidate", "published"]`).
- `routes.py` — the endpoints below.
- Own token store, `data/plugins/revision-feed/tokens.json`, mapping
  `token -> user_id`. Plugin-owned and separate from core `users.json` /
  `AuthManager` — a single-purpose feed credential should not require changing
  core auth schema. One token per user; regenerating invalidates the previous
  one. File access follows the same lock pattern `AuthManager` uses for
  `users.json` (thread lock + file lock) to avoid concurrent-write corruption.
- `extensions/revision-feed.js` — frontend extension registered via
  `FrontendExtensionRegistry`, surfaced in the existing user/account menu.

## Endpoints

### `GET /api/plugins/revision-feed/feed/{project_id}.atom?token=<token>`

Public (no session cookie/header required), authenticated solely by `token`.

1. Look up `token` in the plugin's token store → `user_id`. Missing/unknown
   token → `401`.
2. Resolve the project by `project_id`; confirm the user is still a member
   (or holds a wildcard `*` role) via the existing project/collection access
   helpers (`user_has_collection_access`, project membership resolution in
   `fastapi_app/lib/permissions/user_utils.py`). Access is re-checked on every
   request, so removing a user from a project silently stops their feed from
   updating (no separate revocation step needed). Unknown project or no
   access → `403`.
3. For every collection in the project, fetch TEI files
   (`FileRepository.get_files_by_collection`), parse `<revisionDesc>` for all
   `<tei:change>` elements (extending `edit_history`'s
   `_extract_revision_info`, which currently only reads the last one), and
   keep entries whose `status` is in `revision_feed.included_statuses`.
4. Sort all kept entries by `when` descending, cap at 50.
5. Render as Atom XML, `Content-Type: application/atom+xml`. Per entry:
   - `id`: `urn:revision-feed:{stable_id}:{when}:{status}` (unique per change).
   - `title`: `"{doc_label} — {status}"`.
   - `author`: resolved annotator name (`get_annotator_name`).
   - `updated`: the change's `when` timestamp.
   - `summary`: the `<desc>` text (or change element text, matching
     `edit_history`'s fallback).
   - `link`: `{app_base_url}/#xml={stable_id}&collection={collection_id}`,
     using the app's existing URL-hash deep-linking (`xml` and `collection`
     are both in `state.allowSetFromUrl`, see `config/config.json` and
     `app/src/plugins/url-hash-state.js`). `app_base_url` read from request
     context (same way other plugins build absolute URLs back to the app).
6. No qualifying entries is a valid, empty feed — not an error.

### `GET /api/plugins/revision-feed/my-feeds` (session-authenticated)

Returns `{ token, feeds: [{ project_id, project_name, url }] }` — one entry
per project the current user belongs to (or all projects, if the user holds
a wildcard role). Generates a token on first call if the user has none yet.

### `POST /api/plugins/revision-feed/token/regenerate` (session-authenticated)

Issues a new token, deletes the old one from the store, returns the same
shape as `my-feeds`. Any previously distributed feed URLs for this user stop
working immediately.

## Frontend

A small section in the existing user/account menu: lists the user's projects
with their feed URLs (copy-to-clipboard), and a "Regenerate token" action
behind a confirmation prompt (it invalidates every URL already handed out).

## Error handling

| Condition | Response |
|---|---|
| Unknown/missing token | 401 |
| Unknown `project_id`, or user no longer a member | 403 |
| No qualifying revisions | 200, empty Atom feed |
| Malformed TEI in a given file | Skip that file's entries, log and continue (matches `edit_history`'s per-file `try`/`except`) |

## Testing

- Backend unit tests (`fastapi_app` test suite):
  - Token generation, lookup, regeneration (old token stops resolving).
  - Status filtering against `revision_feed.included_statuses`, including the
    config default and a custom override.
  - Multi-`<change>` parsing producing one entry per qualifying change.
  - Access re-check: user removed from a project's membership between two
    requests → second request gets `403`.
- E2E test: generate a token via the UI, fetch the feed URL directly, assert
  it parses as valid Atom XML with the expected entry count.

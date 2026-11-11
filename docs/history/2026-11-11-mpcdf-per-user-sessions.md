# MPCDF LLM: per-user sessions (plan)

Status: in implementation (core hook in pdf-tei-editor, per-user managers in pte-plugins, library change in llm-mpcdf).

## Problem

The MPCDF Terms of Use do not allow other users to reuse the session an administrator started. Today the plugin (`pte-plugins/plugins/mpcdf-llm`) holds **one** MPCDF session per installation:

- `manager.py` creates one `ProvisioningManager` per worker on `<plugins data dir>/mpcdf-llm/` (session, presets, endpoints, locks).
- Only admins can log in and start presets (`required_roles: ["admin"]`, admin router behind `require_admin_user`).
- `providers.py` registers one provider `mpcdf-llm-<preset>` per ready endpoint, marked `free`, so **every** user's requests run on the admin's endpoint with the admin's credentials.

Required: each user logs in with their own MPCDF account, starts their own endpoints, and only sees and uses their own endpoints in the model picker.

## What does not change

- The library (`mpcdf-llm`) does the MPCDF work: login, start, follow, renew, idle cancel. Its multi-worker guarantees (file locks, one supervisor, one job per start) hold per data directory, so they carry over unchanged when each user gets their own directory.
- Consumers (annotation review, auto-annotation, LLamore, document rules, Default Model) already resolve providers through `LLMProviderRegistry.get_provider_for_user(provider_id, username)` and map `KeyError` to "not found / not available". They need no changes if the new core hook reuses that error path.

## Plan

### 1. Core: per-user provider resolution (pdf-tei-editor)

The registry is global and `list_models()` has no user context. The only per-user hook today is the secret-key path (`secret_service` + `with_api_key()`), which would show MPCDF as "enter your API key" — wrong for a login with a one-time code. Add a general hook instead:

- `LLMProvider.for_user(username: str | None) -> LLMProvider | None`, default `return self`. A provider returns a copy bound to that user, or `None` if it offers nothing to that user.
- New `ProviderNotAvailableError(KeyError)` with a user-presentable message. `get_provider_for_user()` calls `for_user()` first and raises it on `None`, so all existing `except KeyError` handlers keep working (404 / "not available").
- `GET /api/v1/llm/providers` skips providers whose `for_user()` is `None`, so users never see other users' endpoints.
- The per-user copy sets `uses_user_key = True`: the user runs on their own MPCDF quota, so the model filter and the admin/free rules do not apply (same reasoning as an own API key).
- Bump `PLUGIN_API_VERSION` minor (1.3), add tests in `tests/unit/fastapi/` for the registry and the providers route, update `docs/code-assistant/` LLM provider docs and `api-client-v1.js` only if a response model changes (it does not).

### 2. Plugin: one manager per user (pte-plugins)

- **Data layout:** `<plugins data dir>/mpcdf-llm/users/<safe-username>/` per user (endpoints, locks; the session is in the secret store, see 5). `safe-username` is a filesystem-safe encoding of the username (e.g. URL-safe base64 or a hash with a mapping file), never the raw name.
- **Managers:** `manager.py` holds `dict[username, ProvisioningManager]` per worker. At startup it opens a manager for every user directory that has a stored session, so supervisors (renewal, idle cancel) keep running while the user is offline. Other managers are created lazily on the user's first dialog request. `get_manager()` becomes `get_manager_for(username)`.
- **Routes:** the library's admin router is mounted behind `require_authenticated_user` and resolves the **requesting user's** manager per request. Every user can therefore only touch their own session and endpoints. At the pinned commit, `admin_router(source)` wraps `source` in a zero-argument dependency (`web._resolver`), so the getter cannot receive the current user. Library change (small): when `source` is a callable, use it as the FastAPI dependency itself, so a getter such as `def get_user_manager(user: dict = Depends(require_authenticated_user)) -> ProvisioningManager` gets the user injected. A contextvar set by a router-level dependency would avoid the library change, but is fragile (sync dependencies run in a thread pool).
- **Providers:** register one provider per preset in the catalog (`mpcdf-llm-<preset>`, stable ids so a saved model choice works for every user). The watch loop refreshes, every 10 s, a per-user cache of ready endpoints for users with a valid session (one `available()` call per such user, as today for the single session). `for_user(username)` reads that cache (no network, since the providers route is synchronous) and returns a copy bound to the user's manager and credentials, or `None` when that user has no ready endpoint for the preset. `chat_completion()` takes credentials from and reports activity (`touch`) to the user's manager.
- **Background jobs:** auto-annotation and LLamore pass the job's username, so long jobs run on the starting user's endpoint. A call without a username (`None`) never resolves an MPCDF provider.

### 3. Presets: shared catalog, maintained by admins

Presets stay an installation-wide catalog that admins maintain (they encode GPU type, run time, build timeout, which take expertise). Users pick a preset and start it with their own session.

- Catalog in `<plugins data dir>/mpcdf-llm/presets/`; preset create/edit/duplicate/import/export stay admin only.
- `ProvisioningManager(presets=...)` accepts any `PresetStore`, so every user's manager gets the same catalog store (`JsonFilePresetStore(<data dir>/presets)`); no copying. Preset writes from users are rejected by mounting the preset routes for admins only (or by a read-only wrapper store for non-admins).
- Saving a preset in the form validates against the service's live options and needs a login: it uses the admin's **own** session for that.

### 4. Hugging Face token per user

Decided (Christian, 2026-11-11): no installation-wide token. The config key `plugin.mpcdf-llm.hf-token` / `HF_TOKEN` and `manager.hf_token()` are removed; each user stores their own token in the API Keys dialog.

- The plugin registers a secret service in `initialize()` with `register_secret_service("hf-read-token", "Hugging Face read token", description=..., help_url="https://huggingface.co/settings/tokens")` and unregisters it in `cleanup()`. The id names the token, not the plugin, so other plugins that need Hugging Face access can reuse it.
- Each user's manager gets `hf_token=lambda: _user_hf_token(username)`, which returns `get_secret_store().get(username, "hf-read-token")` or `None`. The callable is read at every submit, so renewals by the supervisor pick up a changed token. It must never return `None` by falling through to the library default: `ProvisioningManager` uses `os.environ["HF_TOKEN"]` when `hf_token` is not passed, so the plugin always passes the callable, and the README tells admins to unset `HF_TOKEN` in the server environment.
- The token is optional: only gated models need it. The dialog's Start section says when the user has no token stored and links to the API Keys dialog; a start of a gated model without a token fails at MPCDF with the service's message (scrubbed by the library).
- Migration: an existing `plugin.mpcdf-llm.hf-token` config value is removed on startup and a warning is logged once.

### 5. Sessions stored encrypted

Decided (Christian, 2026-11-11): users' MPCDF sessions are stored encrypted, not in the library's plain `session.json`.

- The plugin implements the library's `SessionStore` protocol (`load`/`save`/`clear`) as `SecretSessionStore(username)` on the core secret store: `save` writes the session's JSON with `get_secret_store().set(username, "mpcdf-llm-session", ...)`, `load` reads and validates it, `clear` deletes it. Each user's manager gets `sessions=SecretSessionStore(username)`.
- `mpcdf-llm-session` is not registered as a secret service, so it does not appear as an API key users can edit. "Remove all" in the API Keys dialog (`delete_all`) also removes it, which logs the user out of MPCDF; that is intended.
- The secret store is shared by all workers, so every worker of a user sees the same session, as with the file store today. The user directory then holds only endpoint state and locks.
- Startup finds the users with a session by `list_services(username)` over the users, or by an index of user directories; the directory alone no longer proves a stored session.

### 6. Management dialog

- Menu entry for all users (not only admins); `required_roles` becomes empty: "Inference > My MPCDF endpoints".
- Sections for every user: Session (own login with password and one-time code), Start (catalog presets), My endpoints (status, remaining time, until, cancel).
- Admin only: Presets section (as today), and a read-only overview of all users' endpoints (user, preset, status, remaining time), read from the users' state files without using their sessions. Admins cannot cancel other users' endpoints, since that would act through another user's session; they can remove a user's stored session (log the user out), after which the endpoints expire or idle out at MPCDF.

### 7. Migration

On first start of the new version: move the presets from `<plugins data dir>/mpcdf-llm/` into the catalog, discard the shared session, and leave the old endpoints untouched (no session, so they expire at MPCDF). The release notes ask admins to cancel running endpoints before upgrading. Any Default Model pointing at an MPCDF provider then only resolves for users with a running endpoint of that preset; the README says so.

### 8. Tests and docs

- Plugin unit tests: the session is saved encrypted in the secret store and survives a restart, no `session.json` is written; a user's endpoint is submitted with that user's `hf-read-token` and with an empty token when none is stored, even with `HF_TOKEN` set in the environment; two users on one worker and on two workers against `FakeLlmis`; user A never sees or uses user B's endpoint; per-user supervisor; catalog copy on start; admin overview has no keys.
- API test: non-admin user logs in to the fake, starts a preset, finds `MPCDF: <preset>` in `/api/v1/llm/providers`; a second user does not.
- README: drop `plugin.mpcdf-llm.hf-token` from Configuration and document the `hf-read-token` API key; rewrite Usage, Security (each user's own session, admins cannot act on other sessions), Routes, Manual live check (two real MPCDF accounts).

## Decisions (Christian, 2026-11-11)

1. The server may keep a user's session and renew that user's endpoints while they are offline.
2. Every user with access to the editor may log in and start endpoints, like adding an own API key for a service. No role setting.
3. Presets are a shared catalog maintained by admins.
4. No installation-wide Hugging Face token; each user stores an `hf-read-token` API key (see 4).
5. Users' MPCDF sessions are stored encrypted in the core secret store (see 5).

## Open questions

None at the moment.

## Library facts (checked at bdcb9f5)

- `ProvisioningManager.__init__` takes injectable `presets`, `sessions` and `state` stores; locks (shared lock, supervisor lock) are per data directory, so one manager per user directory keeps the multi-worker guarantees.
- Each manager has its own `MpcdfClient` and poll loop (`poll_interval` 5 s) and a supervisor (`interval` 30 s); many managers per process are fine at the expected number of users.

## Order of work

0. Library change: `admin_router`/`read_router` use a callable source directly as the dependency; bump the pinned commit.
1. Core PR: `for_user()` hook, `ProviderNotAvailableError`, providers route, API version bump.
2. pte-plugins PR (after the core release): per-user managers, catalog, providers, dialog, migration, tests, README; `engines` raised to the core release and `pte-plugin-api: ^1.3`.

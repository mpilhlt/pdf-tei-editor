# Plugin Management (admin) — Design

Status: draft for review. Date: 2026-09-26.

## Goal

Core, admin-only feature to inspect and enable/disable backend plugins at runtime, without a server restart. Backend machinery plus a UI opened from the left "Tools" menu (category `administration`, like the config editor).

## Scope

In scope (v1):

- Persisted enabled/disabled state per plugin.
- Runtime toggle without restart ("soft toggle", see Mechanism).
- Dependency-aware toggling with a confirmation warning.
- Plugin info panel with README link, status and failure reasons.
- Admin-only REST API and dialog.

Out of scope (v1, see [Follow-ups](#follow-ups-recommended-best-practices)): installing/uninstalling plugins, updates, version-compatibility checks, live push to other sessions, env-var locking.

## Current state (relevant facts)

- `PluginManager` ([plugin_manager.py](../../../fastapi_app/lib/plugins/plugin_manager.py)) discovers and imports all plugins at module import time in `main.py`, mounts `routes.py` routers via `app.include_router` and `static/` via `app.mount`. FastAPI cannot cleanly unmount these.
- `PluginRegistry` ([plugin_registry.py](../../../fastapi_app/lib/plugins/plugin_registry.py)) drops plugins silently when `is_available()` is false, when loading fails, or when a dependency is missing/cyclic (only a log line). Nothing records why.
- `initialize()` runs once at startup, `cleanup()` once at shutdown.
- Frontend extensions are collected in `FrontendExtensionRegistry` during `initialize()` and served as one bundle at `/api/v1/plugins/extensions.js`, loaded once per page load.
- `GET /api/v1/plugins` returns role-filtered metadata for the frontend "backend plugins" dropdown; `POST /api/v1/plugins/{id}/execute` runs endpoints.
- Dependencies are declared as `metadata["dependencies"]` (plugin ids), e.g. `grobid -> tei-wizard`, `collection-overview -> annotation-progress`.
- Admin-only endpoints use `require_admin_user`; admin-only frontend items follow [config-editor.js](../../../app/src/plugins/config-editor.js).

## Mechanism: soft toggle

All discovered plugins stay imported and their routes/static mounts stay registered. A persisted enabled-state gates everything at request time, and lifecycle hooks run on toggle. Rejected alternatives: hard unload (relies on private FastAPI router internals, leaks module state) and lazy import (late route mounting, more moving parts for a small startup saving).

Consequences:

- A disabled plugin still costs import time and memory. Its `__init__` and module-level code still run at startup, so they must stay side-effect-light (already required for `is_available()` checks).
- No restart is needed for either direction.
- Plugin data is never deleted on disable.

## State model

Persisted: only the set of **explicitly disabled** plugin ids. New plugins are enabled by default. Storage: config key `plugins.disabled` (`type: array`, default `[]`) in `config/config.json`, read/written through `get_config()` (never `ConfigManager` directly). The config editor must not offer this key for free editing (hide via the key's existing UI-visibility mechanism or a `plugins.` prefix exclusion; to be verified during implementation).

Derived per plugin, computed by the registry:

| status | meaning |
| --- | --- |
| `active` | enabled and all dependencies active |
| `disabled` | explicitly disabled |
| `inactive` | not explicitly disabled, but a dependency is not active (reason lists the dependencies) |
| `unavailable` | `is_available()` returned false (reason from plugin if provided, else generic) |
| `failed` | import, instantiation, registration or `initialize()` raised (error message stored) |

Rule: a plugin is effectively enabled iff it is not in the disabled set and all its dependencies are effectively enabled. Cascades are therefore derived, not persisted: disabling `tei-wizard` makes `grobid` and `metadata-extraction` `inactive`; re-enabling `tei-wizard` brings them back unless they were explicitly disabled too.

Optional new metadata fields (all optional, backwards compatible):

- `protected: bool` — cannot be disabled (UI shows the toggle locked). Use for plugins the admin tooling itself depends on.
- `readme_url: str` — overrides the derived README link (needed for external plugins).
- `unavailable_reason` is provided via new classmethod `Plugin.unavailable_reason() -> str | None` (default `None`); optional.

## Backend design

### Registry changes (`plugin_registry.py`)

- Introduce `PluginRecord` (dataclass): `id`, `metadata`, `instance | None`, `directory: Path`, `source` (`builtin` | `external`), `load_status` (`ok` | `unavailable` | `failed`), `error: str | None`, `dependencies`, `initialized: bool`.
- `discover_plugins` keeps records for unavailable/failed/dependency-broken plugins instead of dropping them. Existing behaviour for `get_plugin`/`get_all_plugins` (registered, loadable plugins) is unchanged for callers other than the manager.
- Add the disabled set, dependency graph (forward and reverse), and:
  - `effective_status(id)`, `dependents(id, transitive=True)`, `missing_or_disabled_dependencies(id)`.
  - `plan_change(disable: set[str] = ..., enable: set[str] = ...) -> ChangePlan` — pure function returning which plugins go active→not-active and back, in order.
- `get_plugins(...)` (used by the frontend and `execute`) returns only `active` plugins. New `get_plugin_records()` for the admin API.
- `initialize_all` initializes only `active` plugins. Init failure sets `failed` and continues.

### Manager changes (`plugin_manager.py`)

- `async set_plugin_enabled(plugin_id, enabled, cascade, user)`:
  1. Reject protected, unknown, `unavailable`, `failed` plugins (409 with reason).
  2. Build `ChangePlan`. If disabling and dependents would go inactive, or enabling and dependencies are explicitly disabled, and `cascade` is false: raise `CascadeRequired(affected)`.
  3. Persist the new disabled set (single config write).
  4. Apply the plan: `cleanup()` for plugins going down, dependents first (reverse topological order); `initialize()` for plugins coming up, dependencies first. Errors: log, mark `failed`, continue; report in the result.
  5. Log an audit line (`user`, plugin, action, affected ids).
- Serialize toggles with an `asyncio.Lock`. Single-process deployment is assumed (the state is in-process); state is re-read from config on startup.
- On going down, remove the plugin's extension files from `FrontendExtensionRegistry` (new `unregister_plugin(plugin_id)`); on coming up, `initialize()` re-registers them. `extensions.js` needs no filtering beyond that.

### Request-time gate

- Custom routes: `app.include_router(router, dependencies=[Depends(plugin_gate(plugin_id))])`. `plugin_gate` raises 404 if the plugin is not `active`. Removes any need to know route prefixes.
- Static mounts: mount a `GatedStaticFiles(StaticFiles)` subclass that checks plugin state and raises 404 when inactive.
- `POST /plugins/{id}/execute`: already filters through `get_plugins`, which now excludes inactive plugins.
- Service registry: plugins that register services in `initialize()` must unregister them in `cleanup()`. Audit needed (see Plugin contract).

### Plugin contract change

`initialize()` and `cleanup()` become **re-entrant and symmetric**: `cleanup()` undoes everything `initialize()` did (background tasks, service registrations, registered extensions, caches); `initialize()` can run again afterwards. All 26 built-in plugins get audited; document in [backend-plugins.md](../../code-assistant/backend-plugins.md). Add a shared conformance test (`initialize → cleanup → initialize`) run against every built-in plugin.

### REST API

New router `fastapi_app/routers/plugins_admin.py`, prefix `/plugins/admin`, all endpoints `Depends(require_admin_user)`, tagged `plugins-admin`. It must be registered before/independent of `/plugins/{plugin_id}/execute`; POST paths differ, so no conflict.

| method | path | body | result |
| --- | --- | --- | --- |
| GET | `/plugins/admin` | – | `{plugins: PluginAdminInfo[]}` (all records, any status) |
| POST | `/plugins/admin/{id}/enable` | `{cascade: bool}` | `ChangeResult` |
| POST | `/plugins/admin/{id}/disable` | `{cascade: bool}` | `ChangeResult` |

`PluginAdminInfo`: `id`, `name`, `version`, `description`, `category`, `required_roles`, `status`, `status_reason`, `enabled` (explicit), `protected`, `dependencies: str[]`, `dependents: str[]` (transitive), `source`, `readme_url: str | None`, `has_routes`, `has_frontend_extension`, `menu_endpoints: int`.

`ChangeResult`: `{changed: {id: status}, errors: {id: message}, reload_required: true}`.

`409` body when cascade confirmation is needed: `{detail: "cascade_required", affected: str[], direction: "disable" | "enable"}`. The frontend normally knows this in advance from `dependents`/`dependencies` and sends `cascade: true` after the user confirms; the server check is the safety net.

Typed Pydantic models for all bodies; then regenerate `api-client-v1.js` with the existing generate-client script (never hand-edit).

### README link

`readme_url` = metadata `readme_url` if set; otherwise, for `builtin` plugins with a `README.md` in the plugin directory: `https://github.com/mpilhlt/pdf-tei-editor/blob/main/fastapi_app/plugins/<dir>/README.md` (repo URL from one constant in `fastapi_app/config.py`). `None` otherwise (UI hides the link).

## Frontend design

New frontend plugin `app/src/plugins/plugin-admin.js` (class-based, deps `client`, `tools`, `dialog`), modelled on [config-editor.js](../../../app/src/plugins/config-editor.js):

- Templates: `plugin-admin-menu-item.html`, `plugin-admin-dialog.html` (+ generated `.types.js`). Menu item added to the Tools menu under category `administration`, shown only for admins.
- Dialog: see [Visual concept](#visual-concept). Protected, unavailable and failed plugins have the switch disabled.
- Toggle flow:
  - Disable with non-empty active `dependents`: confirm dialog "Disabling *X* will also deactivate: A, B, C. Continue?" → call with `cascade: true`.
  - Enable when a dependency is explicitly disabled: confirm "*X* requires A, which is disabled. Enable A as well?" → `cascade: true`.
  - Otherwise apply immediately. On error, revert the switch and show the message.
- After any successful change show a persistent banner in the dialog: "Changes apply to open pages after reload" with a **Reload now** button. Rationale: frontend extensions and the plugin dropdown are built once at page load.
- Refresh the list from the server after each change (statuses of dependents change).
- Persist filter/collapse state via UIStorage where useful (see [ui-storage.md](../../code-assistant/ui-storage.md)); all user-visible strings in the existing style.

## Visual concept

Interactive mockup (open in a browser): [2026-09-26-plugin-management-mockup.html](2026-09-26-plugin-management-mockup.html). It is a concept only; the real dialog uses Shoelace components and the app's styling. Layout requirements taken from it:

- **Menu entry**: "Manage plugins" in the Tools menu, group "Administration", between "Edit configuration" and "Show logs". Admin-only.
- **Header**: title "Plugins", summary line "N of M plugins active", close button.
- **Reload banner** (hidden until a change is made): "Changes apply to open pages after a reload." with a primary **Reload now** button.
- **Toolbar**: text filter (matches id, name, description, category) and status filter chips with counts: All, Active, Disabled, Inactive, Unavailable, Failed. Chips with a zero count are hidden.
- **Plugin row** (scrollable list, one row per plugin, sorted by name):
  - Switch (reflects the explicit enabled state, not the effective status; an inactive plugin shows the switch on).
  - Title line: name, version, status badge, and a "Protected" badge where applicable.
  - Description.
  - Reason line for `inactive`, `unavailable` and `failed` (failed in error colour).
  - Dependency line: "Requires" and "Required by" chips (direct dependencies only). Clicking a chip clears the filters, scrolls to that plugin and briefly highlights its row.
  - Meta line: category, source (built-in or external via `FASTAPI_PLUGIN_PATHS`), number of menu items, "frontend extension" when present.
  - README button on the right (built-in plugins with a README, or a `readme_url`); no button otherwise. Wraps below the text on narrow screens.
  - Non-active rows are dimmed.
- **Confirmation layer** (modal over the dialog):
  - Disable with active dependents: title "Disable *X*?", text explaining that the listed plugins depend on it and will be deactivated, list of affected plugins with their current status badge, buttons **Cancel** and destructive **Disable all**.
  - Enable with explicitly disabled dependencies: title "Enable *X*?", list of the required plugins, buttons **Cancel** and **Enable all**.
- **Toast** after each change: "Disabled *X* and deactivated N dependent plugins" / "Enabled *X* and N required plugins".
- Light and dark theme, keyboard-operable switches (`role="switch"`), visible focus state, respects reduced motion.

## Error handling

- Toggle failures (init/cleanup errors) never leave the persisted set inconsistent with what the UI shows: the persisted set is written first, failures mark the plugin `failed` with its message, and the list refresh reflects reality.
- Another admin's concurrent toggle: the server lock serializes; the client always re-fetches after each call.
- A user with a stale page calling a now-disabled plugin gets 404; the existing backend-plugins error path shows a notification. No special handling in v1.
- Config write failure: return 500, do not run lifecycle hooks.

## Testing

- Unit (registry): status derivation, transitive dependents/dependencies, `plan_change` ordering, cycles/missing deps recorded as `failed` with reason, unavailable plugins recorded.
- Unit (manager): cascade required vs confirmed, protected rejection, persistence round-trip, lifecycle call order (mock plugins recording hook order), failure during `initialize()` marks `failed`.
- Conformance test: every built-in plugin survives `initialize → cleanup → initialize`.
- API tests: admin-only (401/403 for others), `409 cascade_required`, disabled plugin's route and static file return 404, `/plugins` and `extensions.js` exclude disabled plugins and re-include after enabling.
- E2E: open dialog from Tools menu, disable `tei-wizard`, verify warning lists dependents, confirm, reload, verify dependents' menu items are gone; non-admin does not see the menu item. Follow [testing-guide.md](../../code-assistant/testing-guide.md).

## Documentation

- [backend-plugins.md](../../code-assistant/backend-plugins.md): re-entrant lifecycle, `protected`, `readme_url`, `unavailable_reason`.
- User manual page for the plugin dialog.
- `docs/development/plugin-system-backend.md`: registry records, gate, status model.

## Follow-ups (recommended best practices)

Ordered by value; none are in v1.

1. **Env-based locking for deployments**: `PLUGINS_DISABLED` / `PLUGINS_ENABLED` env vars take precedence over the UI; the dialog shows those plugins as locked with the reason. Makes Docker images deterministic.
2. **Compatibility metadata**: optional `min_app_version` / `max_app_version` in plugin metadata, checked at discovery, surfaced as status `incompatible`. Prevents a broken plugin after an app upgrade.
3. **Live notification of other sessions**: broadcast a `plugins-changed` SSE event so open pages offer a reload instead of failing with 404s (verify the SSE layer supports server-wide broadcast).
4. **Audit trail**: persist who toggled what and when (v1 only logs); show "last changed by" in the dialog.
5. **Safe mode**: a startup flag/env that skips all non-protected plugins, for recovering from a plugin that breaks startup.
6. **Health and diagnostics**: per-plugin health check hook and last-error display; link to the Log Viewer filtered by plugin id.
7. **Per-plugin settings access**: link each plugin row to its config keys in the config editor.
8. **Install / uninstall / update** of external plugins (from a git URL or archive into `FASTAPI_PLUGIN_PATHS`), with pinned version, checksum, and an explicit trust prompt. Enabling is not a sandbox: plugins run arbitrary code with full server privileges, so installation from untrusted sources needs a separate security design.
9. **Declared capabilities**: plugins declare what they touch (file storage, network, config keys, routes) so the dialog can show a permissions summary before enabling.
10. **Dependency hygiene**: warn about undeclared dependencies (`get_dependency` already logs these), and validate `dependencies` ids at discovery with a clear message in the dialog.

## Open points to confirm during implementation

- Exact mechanism to hide `plugins.disabled` from the generic config editor.
- Whether any built-in plugin holds state that `cleanup()` cannot safely undo (audit result may mark some as `protected` or require refactoring).
- Deployment is assumed single-process; if multiple workers are ever used, the state must be shared or re-read per request.

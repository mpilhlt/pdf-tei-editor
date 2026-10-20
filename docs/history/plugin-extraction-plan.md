# Plan: Moving Backend Plugins Out of Core

Status: plan, not implemented.

## Goal

Move most backend plugins out of `fastapi_app/plugins/` into separately released packages that can be installed

1. at deployment time with `uv sync` (pinned, reproducible, works in Docker), and
2. at runtime by an administrator from a list of GitHub repositories carrying the topic `pte-plugin`, without restarting the server.

## Starting Point

Much of the needed infrastructure already exists:

- **External plugins** are loaded from `FASTAPI_PLUGIN_PATHS` and imported as packages under `pte_external_plugins.<dir>` (`fastapi_app/lib/plugins/plugin_paths.py`).
- **Manifest** `pte-plugin.json` with `version`, `readme` and `engines.pte` (semver range checked against `package.json`; incompatible plugins are not loaded) (`plugin_manifest.py`).
- **Plugin dependencies** (`metadata.dependencies`) with cascading activation (`plugin_registry.py`).
- **Runtime enable/disable** without restart: all routes stay mounted and are gated per request by `plugin_gate()` / `GatedStaticFiles` (`plugin_gate.py`); `initialize()`/`cleanup()` are re-entrant and conformance-tested.
- **Frontend extensions** are read from the plugin directory and concatenated per request into `/api/v1/plugins/extensions.js` (`routers/plugins.py`). There is no build step, so an extension shipped inside a Python package works unchanged.

What is missing: packaging and entry-point discovery, loading plugins *after* startup, removing core's imports of plugin code, a stable plugin API surface, and an installer with a trust model.

### Facts that shape the plan

- Production runs **4 uvicorn workers** (`bin/start-prod`, used by `docker/entrypoint.sh`). Every runtime change to the plugin set has to reach all 4 processes.
- Consequence for the existing feature: `PluginManager.set_plugin_enabled()` updates `registry._disabled` only in the worker that served the request. The other 3 workers keep the old state until restart, so a disabled plugin still answers on roughly 3 of 4 requests. This is a bug today, independent of this plan, and the propagation mechanism in [Multi-worker propagation](#multi-worker-propagation) fixes it.
- Plugin routes are registered at module level in `main.py`; after them come the `/api/files/{document_id}` compat router and the `StaticFiles` mount at `/`. A route appended to `app.router.routes` after startup lands behind the `/` mount and is never reached.
- Core imports plugin code directly in two places (`routers/files_gc.py` -> `plugins.grobid.cache`, `routers/files_locks.py` -> `plugins.webdav_sync`) and contains plugin-specific code, configuration and tests in many more. The full inventory and how each item is removed is in [Removing Plugin Code from Core](#removing-plugin-code-from-core).
- `google-genai`, `llamore`, `tei-annotator` and `webdav4` are core dependencies only because of plugins. `kisski` imports `openai`, which is not declared anywhere and arrives transitively through `llamore`.
- Core has no `[build-system]`; `fastapi_app` is not an installable distribution.

## Runtime Route Registration: Feasibility

**Verdict: feasible for adding plugins; not for upgrading or removing them.** The GitHub install path can therefore work without restart for new plugins, while updates and uninstalls need a worker recycle (which keeps the server up, see below).

### Why adding works

Starlette resolves routes by iterating `app.router.routes` on every request, and FastAPI's `include_router()` only copies route objects into that list. There is no compiled routing table. Adding a route after startup requires:

1. **Insertion position.** Splice the plugin's routes into `app.router.routes` *before* the first catch-all (the compat router and the `/` static mount), not at the end. At startup, `PluginManager` records the first catch-all route object as an anchor; live registration builds the routes in a scratch `APIRouter` (`include_router(router, dependencies=[Depends(plugin_gate(id))])`), then assigns a new list `routes[:i] + new + routes[i:]` with `i = routes.index(anchor)`. Replacing the list in one assignment avoids a request iterating a list that is being mutated.
2. **Static mounts** (`/api/plugins/<id>/static`) are `Mount` objects and are spliced the same way.
3. **OpenAPI.** FastAPI caches the schema in `app.openapi_schema`; set it to `None` after splicing.
4. **Gating** works unchanged: new routes get the same `plugin_gate` dependency.
5. **Lifecycle**: discover the single plugin directory, `registry` registers it, then the existing `_apply_plan()` path runs `initialize()` and registers frontend extensions. Open pages pick up the new menu entries and `extensions.js` after a reload, exactly like enabling a plugin today.
6. **Middleware** is built once but does not depend on routes, so nothing to rebuild.

### Why upgrading and removing do not

A Python module that has been imported cannot be reliably unloaded: other modules, closures, registered services, background tasks and `sys.modules` keep references to the old code. Re-importing a new version next to it gives two versions in one process.

- **Remove**: mark the plugin `pending-removal`, run `cleanup()`, and let the gate answer 404 (the same state as "disabled"). Code is gone after the next worker recycle.
- **Upgrade**: install the new version on disk, show "restart pending", and recycle workers.

### Worker recycle instead of server restart

uvicorn 0.52 (current lock) runs the workers under a supervisor that restarts all workers on `SIGHUP` while the listening socket stays open. An admin action "Apply plugin changes" sends `SIGHUP` to the supervisor (parent PID, recorded by `bin/start-prod`). Requests keep being served by the other workers during the sequential restart; SSE connections drop and reconnect, and in-flight long jobs (e.g. a GROBID batch) in the restarted worker are lost, so the dialog warns about running jobs. This must be verified on the deployed uvicorn version before relying on it. In development mode (single process with `--reload`), touching a watched file has the same effect.

### Multi-worker propagation

Each worker must apply the same plugin state. Proposal:

- Persist the desired plugin state in one file, `data/db/plugins-state.json`: `{"generation": n, "disabled": [...], "installed": [{"id", "source", "ref", "sha256"}]}`. `plugins.disabled` moves there from the config (migration in `bin/migrations`).
- The worker serving the admin request writes the file (atomic rename, file lock) and applies the change locally.
- Every worker runs a lifespan background task that checks the file's mtime every 2 seconds and, when `generation` changed, reconciles: loads newly installed plugins (live registration above), applies the disabled set via `registry.plan()` / `_apply_plan()`, marks removed ones `pending-removal`.
- The admin API answers once the local worker has applied the change and reports `"propagation": "pending"`; the plugin manager dialog polls `/api/v1/plugins/admin` until all workers report the same generation (each worker writes its applied generation and PID into a small heartbeat table in the existing SQLite database).

Polling a file mtime is simpler and more robust than an IPC channel and needs no new dependency.

## Which Plugins Stay in Core

Criteria for staying: other plugins use it as an extension point, it is part of the tooling needed to administer plugins and recover the instance, or it is a basic editor feature without external dependencies. Staying in core does not mean core may depend on it: core must work with any of these plugins removed, so each can be moved out later without core changes (see [Core plugins without hard dependencies](#core-plugins-without-hard-dependencies)).

| Plugin | Decision | Reason |
| --- | --- | --- |
| `dashboard` | stay | Login landing page; extension host for 4 plugins |
| `recent_documents` | stay | Default dashboard content |
| `review_queue` | stay | Default dashboard content, core review workflow |
| `tei_wizard` | stay | Extension host for `grobid`, `metadata_extraction`; its frontend moves from core into the plugin |
| `backup_restore` | stay | Protected; `main.py` handles pending restores |
| `log_viewer` | stay | Protected; needed to debug failed plugin installs |
| `active_sessions` | stay | Admin tooling |
| `document_search` | stay | Basic editor feature without external dependencies |
| `xslt_export` | stay | 57 lines, generic export |
| `test_plugin` | move to `tests/fixtures/plugins/` | Test fixture, should not ship |
| `grobid` | move | Extractor, external service |
| `metadata_extraction` | move | Depends on `grobid` |
| `kisski` | move | Extractor, institution-specific service |
| `llamore_extractor` | move | Extractor; takes `llamore` out of core deps |
| `anthropic_llm` | move | LLM provider |
| `google_llm` | move | LLM provider; takes `google-genai` out of core deps |
| `tei_annotator` | archive in monorepo | Superseded by `annotation_review` (LLM reviewer); kept for reference, not released |
| `annotation_review` | move | LLM-based review |
| `annotation_history` | move | Analysis tool |
| `iaa_analyzer` | move | Analysis tool |
| `rng_converter` | move | Schema tooling |
| `update_metadata` | move | DOI backfill; belongs with `metadata_extraction` |
| `webdav_sync` | move | Sync backend; takes `webdav4` out of core deps |
| `local_sync` | move | Sync backend |
| `edit_history` | move | Collection analytics (dashboard box), installed via deployment extras |
| `annotation_progress` | move | Collection analytics (dashboard box), installed via deployment extras |
| `collection_overview` | move | Depends on `annotation_progress` |
| `revision_feed` | move | Atom feeds |

9 stay, 16 move, 1 is archived, 1 becomes a test fixture. The analytics group (`edit_history`, `annotation_progress`, `collection_overview`, `revision_feed`) moves and is part of the `default` extra, so standard deployments get it through `uv sync` / the deploy script.

With no extractor in core, a fresh install cannot extract anything. Docker images and the demo therefore install the default set (see [Packaging and uv sync](#packaging-and-uv-sync)), and core shows a hint in the empty extraction dialog.

## Removing Plugin Code from Core

Rule: after the migration, nothing outside `fastapi_app/plugins/` may import, name or special-case any plugin, whether it moved or stays in the core repository. Plugins may depend on other plugins through declared dependencies; core depends on none. Core provides extension points; plugins use them. Generic references in comments and docstrings (e.g. "an extractor such as GROBID") are rewritten to be neutral where they describe behavior, and may stay where they only give an example.

The inventory below comes from searching core (`fastapi_app` outside `plugins/`, `app/src`, `bin`, `scripts`, `config`, `tests`, `pyproject.toml`) for the ids and names of all moved plugins.

### Backend

| Location | Coupling | Fix |
| --- | --- | --- |
| `routers/files_gc.py` | Imports `plugins.grobid.cache.get_cache_dir` and deletes the GROBID training-data cache | Add a garbage-collection hook in core (`register_gc_handler(plugin_id, handler) -> int`, called by `files_gc` for active plugins, unregistered in `cleanup()`). The grobid plugin registers its cache cleanup. |
| `lib/models/models_files.py` | `GarbageCollectResponse.grobid_cache_deleted` | Replace with `plugin_items_deleted: dict[str, int]` keyed by plugin id; update the matching typedef in `app/src/modules/api-client-v1.js` |
| `routers/files_locks.py` | Imports `plugins.webdav_sync.config` and `SyncService` to push lock changes to WebDAV | Emit a `file.lock_changed` event on the existing `EventBus` (`lib/sse/event_bus.py`); `webdav_sync` subscribes in `initialize()` and unsubscribes in `cleanup()` |
| `lib/extraction/manager.py` | Decides on the mock extractor by matching `GROBID_SERVER_URL` / `GEMINI_API_KEY` in error messages | Introduce `ExtractorUnavailableError` in `lib/extraction`; extractors raise it, the manager checks the type instead of strings |
| `lib/core/schema_validator.py` | `SCHEMA_CONFIG` hard-codes the GROBID RelaxNG URL with a reduced timeout | Add `register_schema_config(url, timeout, reason)` next to the existing `register_schema_redirect()` / bundled-schema registration; the grobid plugin registers its schema |
| `lib/utils/tei_utils.py` | `create_encoding_desc_with_grobid()`, `get_training_data_id()`, `set_training_data_id()` | No callers anywhere (verified by search); delete. The generic `create_encoding_desc_with_extractor()` stays |
| `lib/services/statistics.py` | Only used by `collection_overview`, mirrors `annotation_progress` logic | Move into the analytics plugins (`annotation_progress` exports it, `collection_overview` imports it as a package dependency), together with `tests/unit/fastapi/test_statistics.py` |
| `lib/services/metadata_extraction.py`, `metadata_update_utils.py` | Used by core (`tei_utils`, `doc_id_resolver`) and by several plugins | Generic DOI/bibliographic metadata service: stays in core and becomes part of `plugin_api` |
| `lib/llm/openai_compatible.py`, `lib/llm/base.py` | Comments refer to kisski | Generic LLM layer: stays; comments made neutral |
| `bin/migrations/migrate-tei-flavor-rename.py` | GROBID-specific flavor migration | Move to the grobid plugin (`bin/` of the plugin package, run via `python -m pte_plugin_grobid.migrations...`) |
| `pyproject.toml` | `google-genai`, `llamore`, `tei-annotator`, `webdav4` and their `tool.uv.sources` | Remove; they come with the plugin packages |
| `config/config.json` | `model-configurations` with a `llamore` entry | Unused by any code (verified by search); delete the key, with a migration that removes it from existing `data/db/config.json` |
| `scripts/deploy/container.js` | Lists `GROBID_SERVER_URL`, `KISSKI_API_KEY`, `WEBDAV_*` as key variables | Point to the plugins' READMEs; each plugin documents its own variables |

### Frontend

| Location | Coupling | Fix |
| --- | --- | --- |
| `app/src/plugins/services.js` | Strips a `grobid.` prefix from the variant when building the download filename | Make the rule generic (strip the extractor id from the variant using the extractor list the backend already returns), or let extractors declare a `variant_prefix` in their metadata |
| `app/src/plugins/client.js` | Default extractor `llamore-gemini` | No hard-coded default; use the first available extractor or the configured default from the backend |
| `app/src/templates/extraction-dialog.html` | Static `<sl-option value="llamore">` and `value="llamore"` | Remove; the dialog is populated from the extractor list |
| `app/src/modules/tei-utils.js` | Comment about lowercasing "GROBID" | The lowercasing is generic; neutral comment |
| `app/src/modules/api-client-v1.js` | Typedefs for `kisski` routes, `grobid_cache_deleted` | Remove plugin route typedefs from the core client; plugins that need a typed client ship their own in their extension. Update the GC typedef as above |
| `app/src/plugins/progress.js` | Example `cancelUrl` uses `/api/plugins/grobid/...` | Neutral example |

### Core plugins without hard dependencies

The plugins that stay in the core repository must be removable like any other: core code may not import them, call their routes, or ship their frontend. Searching core for their ids gives:

| Location | Coupling | Fix |
| --- | --- | --- |
| `app/src/plugins/tei-wizard.js`, `app/src/templates/tei-wizard-button.html`, `tei-wizard-dialog.html` (+ generated `.types.js`), `app/src/modules/enhancement-registry.js`, registration in `app/src/plugins.js` / `plugin-registry.js` | The whole frontend of the TEI wizard is a core frontend plugin that loads `/api/plugins/tei-wizard/enhancements.js` unconditionally | Move the frontend into the `tei_wizard` backend plugin as a frontend extension (the dashboard and document-search plugins already add toolbar buttons and dialogs this way). The enhancement registry moves with it. Without the backend plugin, no button appears and nothing is requested |
| `app/src/ui.js` (`teiWizardDialog`), `app/src/plugins/xmleditor.js` (`teiWizardBtn`), `app/src/plugins/toolbar.js` (`searchBtn`, `dashboardBtn`) | Core UI typedefs declare elements that plugins add | Remove from core typedefs; each extension declares its own element types. Core code must not access these elements |
| `bin/backup-download.js`, `tests/unit/js/backup-download.test.js` | Core CLI calls `/api/plugins/backup-restore/download` | Move into the `backup_restore` plugin directory (`bin/` inside the plugin) with its test |
| `app/src/modules/api-client-v1.js` | Typedef for the backup-restore upload route | Remove; the core client covers `/api/v1/` only |
| `fastapi_app/main.py` + `lib/core/data_restore.py` | Applies a pending restore from `data_restore/` at startup | Allowed: this is a generic core facility that must run before plugins load. `backup_restore` uses it; core does not import the plugin. Only the comment naming the plugin changes |
| `grobid`, `metadata_extraction` -> `tei_wizard` | Plugins register enhancements | Allowed: plugin-to-plugin dependency declared in `metadata.dependencies` |
| Tests in `tests/`: `tests/api/v1/tei_wizard_enhancements.test.js`, the `TestTeiWizardLifecycle` tests in `test_plugin_management.py`, `test_plugin_admin_api.py` and `plugin-admin.spec.js` (where they use real plugins), `dashboard-plugin.spec.js` | Core test suite requires these plugins | Plugin-specific tests move into each plugin's `tests/` directory; plugin-system tests use fixture plugins only |


### Tests

Core tests must run without any moved plugin installed:

- **Extractor and plugin-system tests** (`test_extractor_plugins.py`, `test_extractor_annotation_guides_validation.py`, `test_external_plugins.py`, `test_plugin_management.py::test_dependent_cleanup_removes_its_enhancements`) import `grobid`, `kisski`, `llamore_extractor` or `metadata_extraction`. The plugin-specific parts move to the plugins' own tests; the core parts switch to the `test_plugin` fixture (which already registers an extractor and frontend extensions) or to small fixtures under `tests/fixtures/plugins/`.
- **`TestBuiltinLifecycleConformance`** stays in core for the remaining built-in plugins and is exported as a reusable helper so the monorepo runs the same `initialize -> cleanup -> initialize` check for every plugin.
- **E2E**: `dashboard-plugin.spec.js` relies on the `edit-history` and `annotation-progress` boxes, `revision-feed-plugin.spec.js` and `plugin-admin.spec.js` on moved plugins. Dashboard tests use a fixture box plugin; the plugin-specific specs move to the monorepo.
- **WebDAV test infrastructure** (`tests/lib/webdav-server-manager.js`, `tests/api/helpers/webdav-server.js`, the WebDAV part of `tests/api/helpers/test-env.js` and `tests/e2e-runner.js`) moves to the monorepo with `webdav_sync`.
- **Fixtures and data**: E2E fixture configs with `llamore` entries are cleaned up. Tests that only use `grobid...` as a variant *name* in sample data (`test_file_exporter.py`, `test_doc_rules_rules_refresh.py`, `test_tei_utils.py`) do not depend on the plugin and stay.
- **Frontend unit tests** (`inference-settings.test.js`) use provider names `kisski`/`anthropic` as mock data only; they stay, with neutral names where it is cheap.
- `test_plugin` moves to `tests/fixtures/plugins/test_plugin/` and is loaded by the test runners through `FASTAPI_PLUGIN_PATHS`, so it is never shipped.

### Documentation

User-manual pages that describe moved plugins (`extraction-workflow.md`, `batch-processing.md`, `docker-deployment.md`, `getting-started.md`, `import-export*.md`, `interface-overview.md`, `editing-workflow.md`) keep the generic workflow and link to the plugin READMEs for plugin-specific steps and configuration.

### Guard against regressions

Two checks keep the state from regressing:

- A core unit test fails if a file under `fastapi_app/` (outside `fastapi_app/plugins/`), `app/src/`, `bin/`, `config/` or `tests/` (outside `tests/fixtures/plugins/`) imports `fastapi_app.plugins.<id>` or references `/api/plugins/<id>` for any plugin id. There is no allowlist.
- A CI job runs the core unit, API and E2E suites with `fastapi_app/plugins/` emptied (only `tests/fixtures/plugins/` on `FASTAPI_PLUGIN_PATHS`). If it passes, every remaining core plugin can be moved out without changing core.

## Repository Layout: Monorepo (Recommended)

**Recommendation: one monorepo `mpilhlt/pte-plugins` for all first-party plugins, organized as a uv workspace with one distribution package per plugin.** Third-party plugins live in their own repositories.

Reasons:

- Several moved plugins depend on each other or on the same core APIs (`metadata_extraction` -> `grobid`, `collection_overview` -> `annotation_progress`). A core API change then needs one PR, not five.
- One CI configuration tests all plugins against core `devel` and the latest core release.
- 17 repositories (issue trackers, release workflows, branch protection, topic tags) is too much overhead for the current team.
- A monorepo still allows independent versions: each package is released with its own tag (`grobid-v1.4.0`) via `semantic-release` in monorepo mode or `release-please` with a manifest, both of which support per-package tags.

Costs: the GitHub topic applies per repository, not per plugin, so discovery needs an index file (below); release tooling is a little more complex than for single-package repos.

Alternatives considered:

- **One repository per plugin**: best fit for the topic-based discovery, worst for maintenance. Recommended only for third-party plugins and for plugins maintained by someone else.
- **Keep plugins in the core repo but package them separately**: no history split and the simplest migration, but keeps the plugin release cadence tied to core and does not reduce the core repository. Worth keeping in mind as a fallback if the monorepo turns out to be too costly.

### Monorepo structure

```text
pte-plugins/
├── pyproject.toml              # uv workspace root (members = ["plugins/*"]), dev deps
├── pte-plugins.json            # discovery index: list of plugin subdirectories
├── plugins/
│   └── grobid/
│       ├── pyproject.toml      # name = "pte-plugin-grobid", entry point, deps
│       └── src/pte_plugin_grobid/
│           ├── __init__.py
│           ├── plugin.py
│           ├── routes.py
│           ├── pte-plugin.json # version, readme, engines
│           ├── extensions/*.js # package data
│           ├── static/         # package data
│           └── README.md
├── archived/
│   └── tei_annotator/          # superseded, not a workspace member, not in the index, never released
└── tests/                      # shared fixtures; per-plugin tests next to each plugin
```

`archived/` holds plugins that are no longer maintained but should stay available for reference. Archived plugins are excluded from the uv workspace, CI, releases and `pte-plugins.json`; each has a README line naming its successor. `tei_annotator` goes there directly (superseded by `annotation_review`), so the `tei-annotator` dependency is dropped from core without a replacement package.

History is preserved with `git filter-repo --path fastapi_app/plugins/<id> --path-rename fastapi_app/plugins/<id>:plugins/<id>/src/pte_plugin_<id>` per plugin, merged into the new repository.

## Packaging and Entry Points

Each plugin is a normal Python distribution:

```toml
[project]
name = "pte-plugin-metadata-extraction"
version = "1.2.0"
dependencies = ["pte-plugin-grobid>=1.4,<2"]

[project.entry-points."pte.plugins"]
metadata-extraction = "pte_plugin_metadata_extraction"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

- The entry point group `pte.plugins` maps the plugin id to its package. Core adds a discovery source next to `fastapi_app/plugins/` and `FASTAPI_PLUGIN_PATHS`: for each entry point, resolve the package directory from the module spec (`submodule_search_locations`) and pass it to the existing `PluginRegistry` discovery. `get_plugin_package_name()` returns the real package name (`pte_plugin_grobid`) for such directories instead of the synthetic `pte_external_plugins.*` name, so `import_plugin_module()` keeps working.
- Package data (`extensions/`, `static/`, `README.md`, `pte-plugin.json`) is inside the package directory; hatchling includes it by default. `FrontendExtensionRegistry` and `GatedStaticFiles` read from that directory as today.
- Imports change from `fastapi_app.plugins.grobid.x` to `pte_plugin_grobid.x` (relative imports inside a plugin are unaffected). Cross-plugin imports become package dependencies: `pte-plugin-metadata-extraction` depends on `pte-plugin-grobid`. Plugins that stay in core (`tei_wizard`, `dashboard`) are imported as `fastapi_app.plugins.*` and need no package dependency.
- `pte-plugin.json` stays the source of compatibility information because it is also needed for plugins loaded from directories. The package version and the manifest version are kept in sync by the release tooling.
- Plugin-specific Python dependencies move from core `pyproject.toml` into the plugin packages (`google-genai`, `llamore`, `webdav4`; `kisski` declares `openai` explicitly). `tei-annotator` is dropped entirely with the archived plugin.

## Packaging and uv sync

Core declares first-party plugins as optional dependencies:

```toml
[project.optional-dependencies]
grobid = ["pte-plugin-grobid"]
webdav-sync = ["pte-plugin-webdav-sync"]
# ...
analytics = ["pte-plugin-edit-history", "pte-plugin-annotation-progress", "pte-plugin-collection-overview", "pte-plugin-revision-feed"]
default = ["pte-plugin-grobid", "pte-plugin-llamore-extractor", "pte-plugin-google-llm", "pte-plugin-anthropic-llm", "pte-plugin-metadata-extraction", "pte-plugin-annotation-review", "pte-plugin-edit-history", "pte-plugin-annotation-progress", "pte-plugin-collection-overview", "pte-plugin-revision-feed"]
all = ["pte-plugin-grobid", "..."]

[tool.uv.sources]
pte-plugin-grobid = { git = "https://github.com/mpilhlt/pte-plugins", subdirectory = "plugins/grobid", tag = "grobid-v1.4.0" }
```

- Deployments run `uv sync --extra default` or `uv sync --all-extras`; `uv.lock` pins every plugin to a commit, so builds are reproducible. Later the packages can be published to PyPI and the git sources dropped.
- The Dockerfile takes a build argument `PTE_PLUGIN_EXTRAS` (default `default`; the demo image uses `all`) and runs `uv sync --frozen --extra ...`.
- Updating a plugin is a core PR that bumps the tag in `tool.uv.sources` and the lock, which semantic-release then ships. A Renovate rule can propose these bumps.
- Third-party plugins in a deployment: the operator adds them to a deployment-specific project that depends on core, or installs them through the runtime installer below. Editing core's `pyproject.toml` is not recommended because it conflicts on every update.

`uv sync` removes packages that are not in the lock. Runtime-installed plugins therefore must not live in the venv (see next section).

## GitHub Discovery and Runtime Install

### Discovery

- The plugin manager gets an "Available" tab (admin only, and only when the feature is enabled, see [Security](#security)).
- The backend queries the GitHub search API for `topic:pte-plugin` (unauthenticated: 10 search requests/minute; an optional `GITHUB_TOKEN` raises the limit) and caches the result for an hour.
- For each repository it reads `pte-plugins.json` from the default branch (monorepo index: `{"plugins": ["plugins/grobid", ...]}`); without it, the repository root is the plugin. For each plugin it reads `pte-plugin.json` and the latest release.
- Each entry shows name, version, `engines.pte` compatibility with this installation, required Python dependencies, whether it is already installed, and the trust level (trusted owner or not).

### Install

1. The admin picks a plugin and a release. Only GitHub **releases** are installable, not branches.
2. The backend downloads the release's **wheel asset** (built and attached by the plugin's CI) and verifies its sha256 against the checksum file attached to the same release. Installing from a git URL is not offered because building a package executes its build backend, i.e. arbitrary code at install time.
3. Dependency check: the wheel's `Requires-Dist` is resolved against the packages already installed in the core venv (`importlib.metadata`). Plugins whose dependencies are all satisfied, including other plugins, can be installed at runtime. A plugin that needs new third-party packages is rejected with "needs a deployment install" and the `uv sync` instruction. This keeps the runtime path free of dependency resolution and avoids conflicts with the locked core environment.
4. The wheel is unpacked with `--no-deps` semantics into `data/plugins/site/` (persisted on the data volume, so it survives container recreation and is not touched by `uv sync`). This directory is put on `sys.path` at startup and scanned for `pte.plugins` entry points via `importlib.metadata.distributions(path=[...])`.
5. The install is recorded in `plugins-state.json` (id, repository, tag, sha256) with the plugin **disabled**, and the generation is bumped. The plugin appears in the list but is not imported yet. When the admin enables it, all workers import it, register its routes live and run `initialize()`.
6. Upgrade: same steps into a new version directory, then "restart pending" and worker recycle. Remove: `pending-removal`, files deleted after the recycle.

`bin/manage.py plugins list|install|remove` provides the same operations on the command line for operators without the web UI.

## Dependency, Versioning and Compatibility

- **Plugin API surface.** Plugins currently import about 40 core modules (`fastapi_app.config`, `lib.core.dependencies`, `lib.repository.file_repository`, `lib.plugins.plugin_tools`, `lib.utils.tei_utils`, `lib.llm`, `lib.extraction`, ...). Without a defined surface every internal refactoring can break external plugins. Add `fastapi_app/plugin_api.py` that re-exports the supported symbols, document it, and make the moved plugins import only from it. Imports from elsewhere keep working but are unsupported.
- **API version.** Core is at 0.x, where an `engines.pte` caret range like `^0.75.0` means `<0.76.0`, i.e. every minor release would be "incompatible". Add `PLUGIN_API_VERSION = "1.0"` in `plugin_api.py` and a manifest field `engines.pte-plugin-api` (semver range, e.g. `^1.0`). Core bumps the major only on breaking changes to `plugin_api`; `engines.pte` remains for "requires at least editor version X".
- **Inter-plugin versions** are expressed as Python dependencies (`pte-plugin-grobid>=1.4,<2`), which uv resolves at deployment time and the runtime installer checks against installed distributions. The existing `metadata.dependencies` still controls activation order and cascades.
- **CI**: the monorepo tests every plugin against core `devel` and the latest core release (matrix), with core checked out and its test runners used. Core CI installs `--all-extras` and runs the E2E suite, so a core change that breaks a first-party plugin is caught in the core PR.

## Frontend Extensions

No change to the delivery mechanism: extensions are package data, registered in `initialize()` as today and concatenated into `extensions.js` per request. Remaining points:

- Extensions use JSDoc `@import` from core paths (`../ui.js`). Outside the core tree these resolve only with a core checkout next to the plugin. Publish core's frontend type definitions (`app/src/ui.js`, `endpoints.js`, the `FrontendExtensionPlugin` base) as a types-only npm package or document the sibling-checkout convention for plugin development.
- E2E tests in `fastapi_app/plugins/*/tests/*.test.js` move with the plugins. Core's `tests/e2e-runner.js` gets a `--plugin-tests <dir>` option so plugin CI can run them against a core build.
- Core frontend couplings to moved plugins are removed as listed in [Removing Plugin Code from Core](#removing-plugin-code-from-core).

## Security

Installing a plugin is installing server-side code with full access to all documents, the user database, stored per-user API keys, and the `.env` secrets in the process environment. Frontend extensions additionally run in every user's browser session; `validate_javascript_content()` is a lint, not a sandbox. Therefore:

- **Off by default, enabled by the operator, not by an admin account.** Runtime install requires the environment variable `PTE_PLUGIN_INSTALL=1`. It is deliberately not a config key, because the config is editable from the web UI, and an admin password compromise must not turn into remote code execution unless the operator opted in.
- **Trusted owners.** `PTE_PLUGIN_TRUSTED_OWNERS=mpilhlt,cboulanger` (default: `mpilhlt`). Plugins from other owners are listed as "unverified" and installing them requires typing the repository name to confirm; operators can set `PTE_PLUGIN_TRUSTED_ONLY=1` to hide them. The `pte-plugin` topic can be set by anyone, so it is a discovery hint, never a trust signal.
- **Pinned, verified artifacts.** Release wheels only, sha256 checked, the installed version recorded with its hash. Optionally verify GitHub artifact attestations (`gh attestation verify`-equivalent via the sigstore bundle) for trusted owners.
- **No code execution before enabling.** The wheel is unpacked, not built. Note that loading the plugin to register routes imports its module-level code, so a newly installed plugin is imported only when the admin enables it, not at install time.
- **Audit log** entries for discover, install, enable, upgrade and remove, with user, repository, tag and hash.
- **Network**: the backend needs outbound access to `api.github.com` and `objects.githubusercontent.com`; deployments without it use the `uv sync` path only.

## Migration Steps

Each phase is one or more PRs against `devel` and leaves the application working.

### Phase 0: core prerequisites (no plugin moves)

1. Fix multi-worker plugin state: `plugins-state.json`, reconcile task, migration of `plugins.disabled`. Ships independently because it fixes the current enable/disable bug.
2. Remove all plugin code from core as listed in [Removing Plugin Code from Core](#removing-plugin-code-from-core): the two hooks, dead GROBID helpers, plugin-specific configuration, frontend couplings and tests, including the couplings to the plugins that stay (TEI wizard frontend, backup CLI). Add the guard test and the core-without-plugins CI job so the state cannot regress.
3. Add `fastapi_app/plugin_api.py` and `PLUGIN_API_VERSION`; switch the plugins that will move to import from it.
4. Add `pte.plugins` entry-point discovery to `plugin_paths.py`/`PluginManager`.
5. Move `test_plugin` to `tests/fixtures/plugins/`; add `--plugin-tests` to the test runners.
6. Add `[build-system]` to core so the plugin CI can install core as a dev dependency.

### Phase 1: monorepo and pilot

1. Create `mpilhlt/pte-plugins` (uv workspace, CI matrix against core, release tooling with per-package tags, `pte-plugins.json`, topic `pte-plugin`).
2. Move the three leaf plugins with external dependencies and no dependents: `google_llm`, `anthropic_llm`, `llamore_extractor`. Remove `google-genai` and `llamore` from core dependencies.
3. Add the optional dependencies and `tool.uv.sources` to core, the `PTE_PLUGIN_EXTRAS` Docker build argument, and verify `uv sync --frozen --extra default` in the Docker build and in CI.

### Phase 2: remaining plugins

Move in dependency order, one group per PR: `grobid` + `metadata_extraction` + `update_metadata`; `kisski`; `annotation_review`; `tei_annotator` (to `archived/`); `webdav_sync` + `local_sync`; `annotation_history` + `iaa_analyzer` + `rng_converter`; `edit_history` + `annotation_progress` + `collection_overview` + `revision_feed`. Each PR deletes the plugin from core, adds the extra, and updates docs that link to the plugin source.

### Phase 3: runtime install

1. Live route registration (anchor splice, OpenAPI reset) with unit tests that register a plugin after the app started and request its routes through `TestClient`.
2. Worker recycle via `SIGHUP` from the plugin manager; verify on the deployed uvicorn version.
3. Discovery API and "Available" tab; installer with wheel verification, dependency check and `data/plugins/site/`; CLI commands; security switches and audit log.

### Phase 4: documentation

Update `docs/code-assistant/backend-plugins.md` (packaging, entry points, `plugin_api`), `docs/user-manual/plugin-manager.md` (Available tab, install, restart pending), `docs/user-manual/docker-deployment.md` (`PTE_PLUGIN_EXTRAS`, data volume for `data/plugins/`), and add a plugin template repository (`pte-plugin-template`) for third parties.

## Open Questions

- Monorepo release tooling: semantic-release with per-package tags vs. release-please manifest mode.
- Whether to publish plugin packages to PyPI (simpler `uv sync`, needs a PyPI organization) or keep git sources.
- Whether the plugins that stay in core (`dashboard`, `tei_wizard`, ...) should eventually become regular core modules instead of plugins.

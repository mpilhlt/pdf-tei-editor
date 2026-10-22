# Backend Plugin Development Guide

Practical guide for creating **backend plugins** in the PDF-TEI Editor.

**Note**: This guide covers **backend plugins** (Python code running on the server). For **frontend plugins** (JavaScript code running in the browser), see [plugin-development.md](./plugin-development.md). For detailed backend plugin architecture, see [../development/plugin-system-backend.md](../development/plugin-system-backend.md).

**Key Differences**:

- **Backend plugins**: Python modules in `fastapi_app/plugins/` that provide server-side functionality and API endpoints
- **Frontend plugins**: JavaScript classes in `app/src/plugins/` that extend the UI and handle client-side logic

## Architecture

Backend plugins are Python modules discovered at runtime from:

- `fastapi_app/plugins/<plugin_id>/`
- Paths in `FASTAPI_PLUGIN_PATHS` environment variable (see [External Plugins](#external-plugins))

Each plugin:

- Inherits from `fastapi_app.lib.plugin_base.Plugin`
- Defines metadata (id, name, description, category, version, required_roles)
- Implements endpoints as async methods
- Has access to `PluginContext` for app state and user info

## External Plugins

Plugins do not have to live in the source tree. Set `FASTAPI_PLUGIN_PATHS` to one or more directories, separated by `:` (`;` on Windows). An external plugin is a directory with the same layout as a built-in plugin plus the manifest `pte-plugin.json` (see [Plugin manifest](#plugin-manifest); an empty file or `{}` is fine):

```text
/opt/my-plugins/            # FASTAPI_PLUGIN_PATHS=/opt/my-plugins
├── my_extractor/
│   ├── pte-plugin.json     # marks the directory as a plugin, declares version and compatibility
│   ├── __init__.py
│   ├── plugin.py
│   ├── extractor.py        # imported from plugin.py as `from .extractor import ...`
│   ├── routes.py
│   ├── static/
│   └── extensions/
└── some-repo/
    └── plugins/
        └── another_plugin/ # found too: plugins may be nested up to three levels deep
```

- Only directories containing both `pte-plugin.json` and `plugin.py` are imported, so `FASTAPI_PLUGIN_PATHS` can point to a folder of checked-out repositories: other code, including unrelated `plugin.py` files, is never executed. A listed directory may also be a plugin itself. Hidden directories (`.git`, `.venv`), `node_modules`, `venv`, `env`, `site-packages`, `__pycache__`, symlinked directories and the subdirectories of a plugin are not searched (`find_external_plugins()` in `fastapi_app/lib/plugins/plugin_paths.py`).
- A plugin whose import fails, including one that calls `sys.exit()`, is listed as failed in the Plugin Manager; the other plugins and the server keep running.

- External plugins are imported as packages under the `pte_external_plugins` namespace (e.g. `pte_external_plugins.my_extractor`), so they can consist of several modules using relative imports. Import application code with absolute imports (`from fastapi_app.lib.extraction import BaseExtractor`).
- A directory name that also exists in `fastapi_app/plugins/` does not shadow or load the built-in plugin; plugin ids must still be unique.
- `routes.py`, `static/` (served at `/api/plugins/{plugin_id}/static/`) and frontend extensions registered from `initialize()` work as for built-in plugins.
- External plugins run in the application's Python environment and cannot declare their own dependencies. Use only packages the application already installs, or install additional ones into the deployment yourself.
- The Plugin Manager lists them as "external". See [pte-edition-plugin](https://github.com/cboulanger/pte-edition-plugin) for a complete example.

### Installed Plugins (Python Packages)

A plugin can also be a regular Python distribution installed into the application's environment (e.g. with `uv sync --extra ...`). It declares an entry point in the group `pte.plugins` that maps the plugin id to its package:

```toml
[project]
name = "pte-plugin-grobid"
dependencies = ["requests>=2.33"]

[project.entry-points."pte.plugins"]
grobid = "pte_plugin_grobid"
```

- The package directory is the plugin directory: it contains `plugin.py`, `pte-plugin.json` (required, as for external plugins), and optionally `routes.py`, `static/` and `extensions/` as package data.
- Modules are imported under the real package name (`pte_plugin_grobid.plugin`), so plugins can import each other's packages; declare such dependencies both as a Python dependency and in `metadata["dependencies"]`.
- The package is located with `importlib.util.find_spec()` without importing it (`get_installed_plugin_dirs()` in `plugin_paths.py`). Unlike directory plugins, an installed plugin declares its own Python dependencies.
- The Plugin Manager lists installed plugins as "external", and plugins installed in the Plugin Manager as "site" (see [Runtime Install](#runtime-install)).
- The first-party plugins (all except the ones in `fastapi_app/plugins/`) are such packages, maintained in the [pte-plugins](https://github.com/mpilhlt/pte-plugins) monorepo. Core declares them as optional dependencies with git sources pinned to a commit (`[project.optional-dependencies]` and `[tool.uv.sources]` in `pyproject.toml`); the Docker build selects them with `PTE_PLUGIN_EXTRAS`. To update a plugin, change the `rev` of its source and run `uv lock`. Core code must not import them (guard test `tests/unit/fastapi/test_core_plugin_independence.py`).

### Plugin API

`fastapi_app/plugin_api.py` re-exports the core symbols plugins are supposed to use (plugin base classes, dependencies, registries, extension points such as `register_gc_handler()` and `register_schema_config()`). Within a major `PLUGIN_API_VERSION` they stay compatible; imports from other core modules keep working but may break with any core release. Plugins maintained outside the core repository should import from `fastapi_app.plugin_api` and declare `engines.pte-plugin-api` in their manifest.

### Extension Points Instead of Core Couplings

Core must not import, call or name any plugin (enforced by `tests/unit/fastapi/test_core_plugin_independence.py` and the CI job that runs the core suites with `fastapi_app/plugins/` emptied). Plugins hook into core through:

- `register_gc_handler(plugin_id, handler)` (`lib/core/gc_hooks.py`): reproducible plugin data deleted by `POST /api/v1/files/garbage_collect`; the response reports the counts in `plugin_items_deleted`.
- Event bus events (`lib/sse/event_bus.py`): e.g. `file.lock_changed` (emitted after a lock is acquired or released, payload `stable_id`), `file.deleted`, `document.saved`.
- `register_schema_config(url, timeout, reason)` (`lib/core/schema_validator.py`): a shorter validation timeout for complex schemas.
- `ExtractorUnavailableError` (`lib/extraction`): raise it when an external dependency of an extractor is missing; the extraction router then falls back to the mock extractor if one is registered.

### Plugin Manifest

`pte-plugin.json` marks an external plugin directory and may declare the plugin version and the editor versions it works with:

```json
{
  "version": "1.2.0",
  "readme": "https://github.com/me/my-plugin#readme",
  "engines": { "pte": ">=0.75.0 <1.0.0", "pte-plugin-api": "^1.0" }
}
```

- `version`: semantic version of the plugin. The plugin manager shows it instead of the `version` in the plugin's `metadata`.
- `readme`: http(s) URL of the plugin documentation. The plugin manager shows it as a "README" button (a `readme_url` in the plugin `metadata` takes precedence).
- `engines.pte-plugin-api`: semver range of plugin API versions (`PLUGIN_API_VERSION`, see [Plugin API](#plugin-api)); a plugin outside the range is not loaded.
- `engines.pte`: npm-style semver range of PDF-TEI-Editor versions (as `engines.node` in `package.json`): comparators (`>=0.75.0`, `<1.0.0`), caret (`^0.75.0`), tilde (`~0.75.1`), x-ranges (`0.75.x`, `*`), hyphen ranges, space for AND and `||` for OR. The editor version is the `version` in `package.json`; pre-release suffixes are ignored (`0.76.0-devel.2` counts as `0.76.0`).
- All fields are optional. An empty manifest, a manifest without fields and plugins without manifest (all built-in plugins) declare no constraints and load as before.
- The manifest is read before `plugin.py` is imported. A plugin outside the declared range is not imported and shows as "Incompatible" in the plugin manager, with the required and the actual version. A manifest that is not valid JSON, or has an invalid `version` or range, marks the plugin as "Failed".

### Developing an External Plugin in Its Own Repository

[pte-edition-plugin](https://github.com/cboulanger/pte-edition-plugin) is a complete example (extractor, schema, guidelines, tests). Its conventions:

- Keep the plugin directories under `plugins/` in the repository, each with `plugin.py` and `pte-plugin.json`. Users clone the repository and set `FASTAPI_PLUGIN_PATHS=<clone>/plugins`, or mount it into the Docker container (see [Docker deployment](../user-manual/docker-deployment.md#external-plugins)).
- Run the plugin's tests in the Python environment of an editor checkout (`uv run --project <editor checkout> python -m pytest`), with a `conftest.py` that adds the `plugins/` directory to `sys.path`. A test can load the plugin through `FASTAPI_PLUGIN_PATHS` like the application does.
- In CI, check out the editor, install its environment and run the same command, pinned to a branch or tag of the editor.
- Everything the plugin ships (schema, guidelines, prompts) stays inside the plugin directory; serve files through `static/` and reference them by their `/api/plugins/{plugin_id}/static/` URL.
- A schema the plugin's documents reference by a public URL (`<?xml-model href=...?>`) is shipped in `static/` as well and registered in `initialize()` with `register_bundled_schema(url, path)` from `fastapi_app.lib.core.schema_validator`. Validation and autocomplete then read the bundled file instead of downloading the URL, so they work offline and with the schema version of the installed plugin.

## User API Keys

A plugin that calls a service billed to the user (instead of using a key configured by the administrator) reads the user's own key from the encrypted secret store in `fastapi_app/lib/secrets/` (SQLite `secrets.db`, Fernet; see [User API Keys](../user-manual/cli.md#user-api-keys) for the key management and the CLI):

```python
from fastapi_app.lib.secrets import register_secret_service, require_user_secret

# in initialize(): tells the frontend how to ask for the key
register_secret_service("anthropic", "Anthropic Claude", "Billed to your account.", "https://console.anthropic.com/settings/keys")

# in extract(), on behalf of options["username"]; raises MissingSecretError if the user has no key yet
api_key = require_user_secret(options.get("username"), "anthropic")
```

- `POST /api/v1/extract` turns `MissingSecretError` into HTTP 428 with `detail = {code: "secret_required", service, label, description, help_url}`. The frontend (`api-keys` plugin, `withKeyPrompt()`) then asks for the key, stores it through `PUT /api/v1/secrets/{service}` and repeats the request. Other routes can use the same pattern: raise `MissingSecretError` and wrap the frontend call in `getDependency('api-keys').withKeyPrompt(...)`.
- The REST API (`GET /api/v1/secrets`, `PUT`/`DELETE /api/v1/secrets/{service}`) never returns values. Only registered services can be stored.
- `unregister_secret_service(id)` removes a service that no longer exists (e.g. a deleted endpoint of the inference-endpoints plugin) from the API Keys dialog; stored keys are kept.
- Extractors that use this set `"uses_inference_model": False` in `get_info()`, so the client does not add the model chosen under Tools > Default Model to the options.

## Annotation Tags (Visual Mode)

The XML editor offers its visual annotation mode for a variant only when an extractor declares chips for it in `get_info()` under `annotationTags[variant_id]`. Generate them from the variant's RelaxNG schema with `generate_annotation_tags()` instead of writing them by hand:

```python
from fastapi_app.lib.utils.annotation_tags import generate_annotation_tags

# chips: <p> and every element allowed in it, plus the children of <choice>, without <lb>/<pb>
"annotationTags": {VARIANT_ID: generate_annotation_tags(SCHEMA_PATH, "p", exclude={"lb", "pb"}, expand=["choice"])},
```

A chip whose element allows neither text nor any of its (non-excluded) children gets `empty: true` (e.g. `gap`, `pb`): the editor shows such elements as outlined badges that open the attributes popup, but does not offer them for wrapping selected text. Exclude a tag (e.g. `lb`) to leave it as plain XML. The result is cached until the schema file's mtime changes. Colors are derived from the tag name, so a tag has the same color in every variant. The GROBID plugin uses the same function with the scopes in `pte-plugins/plugins/grobid/src/pte_plugin_grobid/config/annotation_tags_scope.py`.

## Creating a Plugin

### Directory Structure

**Use underscores in directory names** (not hyphens) to avoid Python import issues:

```text
fastapi_app/plugins/my_plugin/
├── __init__.py
├── plugin.py          # Main plugin class
├── routes.py          # Optional custom routes
├── extensions/        # Optional: frontend extensions to be registered
│   ├── my-script.js
├── static/            # Optional: static assets served at /api/plugins/{plugin_id}/static/
│   ├── view.html      # HTML templates (read by routes.py, also served statically)
│   ├── view.js        # JavaScript for view.html
│   ├── styles.css
│   └── template.xslt
└── tests/             # Plugin tests
    ├── test_plugin.py # Python unit tests
    └── script.test.js # JavaScript unit tests (if applicable)
```

**Static assets** (`static/`): Files in the `static/` subdirectory are automatically served at `/api/plugins/{plugin_id}/static/`. Use this for HTML templates, JS, CSS, XSLT, and other assets. See [Static File Serving](../development/plugin-system-backend.md#static-file-serving).

**Keep JavaScript out of HTML templates**: Never put `<script>` blocks with significant logic inline in HTML template files. Instead, place JavaScript in a separate `.js` file in the `static/` directory — it will be served automatically at `/api/plugins/{plugin_id}/static/view.js` — and reference it from the template:

```html
<script type="module" src="/api/plugins/my-plugin/static/view.js"></script>
```

This keeps templates lean, enables IDE type-checking and autocompletion in the JS file, and avoids JSDoc type resolution limitations in inline scripts.

**Test Discovery**: The smart test runner automatically discovers tests in plugin `tests/` directories. Use `@testCovers` annotations to link tests to plugin files for dependency-based test execution.

**Example Test Annotation**:

```python
"""
Unit tests for My Plugin.

@testCovers fastapi_app/plugins/my_plugin/plugin.py
"""
```

### Minimal Plugin

```python
# plugin.py
from fastapi_app.lib.plugins.plugin_base import Plugin
from typing import Any

class MyPlugin(Plugin):
    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "my-plugin",
            "name": "My Plugin",
            "description": "What it does",
            "category": "analyzer",  # Used for UI grouping
            "version": "1.0.0",
            "required_roles": ["user"]  # or ["*"] for all
        }

    def get_endpoints(self) -> dict[str, callable]:
        return {
            "execute": self.execute,
            "info": self.get_info
        }

    async def execute(self, context, params: dict) -> dict:
        """Main execution endpoint"""
        # Access user: context.user
        # Access app: context.app
        return {"result": "data"}

    async def get_info(self, context, params: dict) -> dict:
        """Info endpoint"""
        return {"plugin": self.metadata["id"]}
```

### Plugin Registration

Plugins are discovered from the filesystem: `PluginRegistry` imports `fastapi_app.plugins.<dir>.plugin`, finds the `Plugin` subclass in it and instantiates it. No registration code is required. By convention `__init__.py` re-exports the plugin class (and the router, if any):

```python
# __init__.py
from .plugin import MyPlugin

__all__ = ["MyPlugin"]
```

Do not put required initialization in `__init__.py` (see [Initialization Pattern](#initialization-pattern)).

## Service Registry

Plugins can register and consume services by capability name without hard dependencies. See [Service Registry](../development/service-registry.md) for details.

## Plugin Dependencies

Plugins can declare dependencies on other plugins. The plugin system loads dependencies first and provides runtime access to them.

### Declaring Dependencies

Add a `dependencies` field to your plugin metadata:

```python
@property
def metadata(self) -> dict[str, Any]:
    return {
        "id": "my-plugin",
        "name": "My Plugin",
        "description": "Plugin that uses another plugin",
        "category": "analyzer",
        "version": "1.0.0",
        "required_roles": ["user"],
        "dependencies": ["base-analyzer", "data-exporter"],
    }
```

### Accessing Dependencies

Use `context.get_dependency()` in your endpoint methods:

```python
async def execute(self, context, params: dict) -> dict:
    # Get dependency plugin instance
    analyzer = context.get_dependency("base-analyzer")
    if analyzer:
        # Call dependency endpoint
        result = await analyzer.get_endpoints()["analyze"](context, params)
        return {"analysis": result}
    return {"error": "Dependency not available"}
```

### Behavior

- Plugins are loaded in dependency order (dependencies first)
- Missing dependencies prevent plugin registration
- Circular dependencies are detected and reported
- Undeclared dependency access logs a warning and returns None

## Conditional Availability

Plugins can define runtime availability conditions using the `is_available()` class method. This allows plugins to be conditionally loaded based on:

- Environment variables (e.g., application mode)
- External dependencies
- Configuration settings
- System capabilities

```python
import os
from fastapi_app.lib.plugins.plugin_base import Plugin

class MyPlugin(Plugin):
    # ... metadata and endpoints ...

    @classmethod
    def is_available(cls) -> bool:
        """Only available in development and testing modes."""
        app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
        return app_mode in ("development", "testing")
```

**When to Use:**

- Development/testing-only plugins (like sample_analyzer)
- Plugins requiring optional external services
- Feature-flagged functionality
- Environment-specific tools

**Behavior:**

- Unavailable plugins are not registered, but are listed in the plugin manager with the reason from `unavailable_reason()`
- Default implementation returns `True` (always available)
- Checked once at startup during plugin discovery

**Example - Mock Extractor Pattern:**

Similar to [mock_extractor.py](../../fastapi_app/extractors/mock_extractor.py):

```python
@classmethod
def is_available(cls) -> bool:
    """Available only in testing mode."""
    app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
    return app_mode == "testing"
```

## Runtime Enable/Disable

Administrators can enable and disable plugins at runtime from the Tools menu ("Manage Plugins", see the [user manual](../user-manual/plugin-manager.md)). Plugins stay imported and their routes stay mounted; a persisted state gates them. Consequences for plugin authors:

- **`initialize()` and `cleanup()` must be re-entrant and symmetric.** `cleanup()` must undo everything `initialize()` did (service/extractor/provider registrations, event handlers, registrations with other plugins such as `tei-wizard` enhancements) so that `initialize()` can safely run again. Frontend extensions registered through `FrontendExtensionRegistry` are removed automatically. The test `TestBuiltinLifecycleConformance` in `tests/unit/fastapi/test_plugin_management.py` runs `initialize -> cleanup -> initialize` for all built-in plugins; plugin repositories run the same check with `check_lifecycle_conformance()` from `fastapi_app/lib/plugins/plugin_testing.py`.
- **Disabling cascades along `dependencies`.** Disabling a plugin makes its dependents `inactive`; they return when it is enabled again (unless they are disabled explicitly). Dependents are cleaned up first, dependencies are initialized first.
- **Inactive plugins answer 404.** Custom routes (`routes.py`) are gated with a router dependency and `static/` mounts with `GatedStaticFiles`; `/api/v1/plugins` and `/extensions.js` list only active plugins.
- **Module-level code and `__init__()` still run at startup** for disabled plugins, so keep them free of side effects.
- **Every worker process applies the change.** The disabled set is stored in `data/db/plugins-state.json` (`{"generation": n, "disabled": [...]}`, `fastapi_app/lib/plugins/plugin_state.py`). The worker that serves the admin request writes it and runs the hooks; the other workers check the file every 2 seconds (`PluginManager.watch_state()`, started in the lifespan) and run `cleanup()`/`initialize()` themselves. Each worker reports the generation it has applied in `data/db/plugin-workers/<pid>.json`; `GET /api/v1/plugins/admin` returns `propagation` (`generation`, `workers`, `pending`) and the dialog waits until `pending` is 0. So hooks run once per worker, possibly a few seconds apart. The former config key `plugins.disabled` is migrated when the state file is created.
- **Status** is derived: `active`, `disabled`, `inactive` (dependency not active), `unavailable` (`is_available()` is false; override `unavailable_reason()` to explain why), `failed` (import error, unresolved dependency, or `initialize()` raised).
- **Optional metadata:** `"protected": True` prevents disabling (use for plugins the admin tooling depends on); `"readme_url"` overrides the README link shown in the manager (built-in plugins with a `README.md` link to GitHub automatically).

## Runtime Install

With `PTE_PLUGIN_INSTALL=1` (operator setting, see [Runtime Plugin Install](../user-manual/docker-deployment.md#runtime-plugin-install)), administrators install plugins from GitHub release wheels in the Plugin Manager. Modules: `plugin_catalog.py` (discovery), `plugin_wheel.py` (inspection, requirement check, unpacking), `plugin_install.py` (download and verification), `plugin_site.py` (`data/plugins/site/`), `plugin_install_policy.py` (settings and audit log), and the install/upgrade/remove methods of `PluginManager`.

- **Releases.** A plugin repository lists its plugins in `pte-plugins.json` on its default branch (`id`, `package`, `module`, `path`, `version`, `requires` (plugin ids), `dependencies` (other Python requirements), `engines`); a repository with one plugin uses `"path": "."`. Releases are tagged `<id>-v<version>` (`v<version>` in a single-plugin repository) and carry the wheel (`py3-none-any`) and `SHA256SUMS` as assets; [pte-plugins](https://github.com/mpilhlt/pte-plugins) creates them with its release workflow.
- **Install.** The wheel is downloaded, checked against `SHA256SUMS`, inspected without importing it (one `pte.plugins` entry point, only the plugin package plus `.dist-info`, no `.data`, compatible `engines`), and its `Requires-Dist` is checked against the installed distributions. Plugins that need packages that are not installed are refused ("install it with uv sync"). The wheel is unpacked into `data/plugins/site/<distribution>/<version>/` and recorded in `installed` of `plugins-state.json`.
- **Not imported until enabled.** A new plugin is installed disabled. Disabled runtime-installed plugins are listed from their state entry (`PluginRecord.deferred`), not imported, also at startup. Enabling one imports it (`PluginRegistry.load_deferred()`), registers its routes and static files live and runs `initialize()`, in every worker (`PluginManager.reconcile()`).
- **Live routes.** `register_plugin_routes()` records the position after the startup plugin routes; `register_live_routes()` inserts the routes of a plugin loaded later at that position, before the catch-all compat router and static mounts, by replacing `app.router.routes` in one assignment, and resets `app.openapi_schema`.
- **Precedence.** The version directories are put at the front of `sys.path` at startup, so a runtime-installed version replaces a version installed with `uv sync` (its entry point and package are found first). Built-in plugins and plugins from `FASTAPI_PLUGIN_PATHS` cannot be replaced.
- **Upgrade and removal** of a plugin that is imported take effect only in worker processes started afterwards: the state records `restart_required_at` and `restart_plugins`, heartbeats carry each worker's start time, and `propagation.restart_pending` counts the workers still running old code. `POST /api/v1/plugins/admin/restart` sends `SIGHUP` to the uvicorn supervisor (only when `PTE_WORKER_RECYCLE=1`, set by `bin/start-prod`), which restarts the workers one after the other. Superseded version directories (`pending_removal`) are deleted at startup once no older worker runs. Enabling a plugin with a pending restart is refused.
- **Client reload**: after a worker applied a plugin change it calls the listeners of `PluginManager.add_change_listener()`; `fastapi_app/main.py` uses this to broadcast the SSE event `serverChanged` to the worker's clients. The clients compare `plugins_version` of `GET /api/v1/maintenance/status` (null while a restart is pending) with the value at page load and reload (`app/src/modules/server-change-monitor.js`).
- **Trust.** Repositories of `PTE_PLUGIN_TRUSTED_OWNERS` are trusted; others need the repository name as `confirm`, and `PTE_PLUGIN_TRUSTED_ONLY=1` refuses them. Only repositories in the catalog (`PTE_PLUGIN_SOURCES` and the `pte-plugin` topic search) can be installed from.
- **Audit.** Discover, install, upgrade, remove, enable, disable and restart are appended to `data/db/plugin-audit.jsonl` and logged.

## Plugin Configuration with Environment Variables

Plugins often need configuration that can be set via environment variables or config keys.

### Initialization Pattern

**Initialize configuration values in the plugin class `__init__()`**, not in the package's `__init__.py`. Importing `plugin.py` does run `__init__.py` as a side effect, but the fallback loader (`spec_from_file_location` on `plugin.py`) and route loading (`routes.py` by file path) bypass it, so nothing there is guaranteed to run. The plugin constructor always runs when the plugin is loaded, so config keys are created from environment variables at that point:

```python
# plugin.py
from fastapi_app.lib.plugins.plugin_base import Plugin
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

class MyPlugin(Plugin):
    def __init__(self) -> None:
        # Initialize config values from environment variables
        get_plugin_config("plugin.my-plugin.enabled", "MY_PLUGIN_ENABLED", default=False, value_type="boolean")
        get_plugin_config("plugin.my-plugin.api-key", "MY_PLUGIN_API_KEY", default=None)
        get_plugin_config("plugin.my-plugin.timeout", "MY_PLUGIN_TIMEOUT", default=30, value_type="number")
```

For plugins with many keys, put them in an `init_plugin_config()` function in a `config.py` and call it from the constructor (see `tei_annotator/config.py`, `webdav_sync/config.py`).

**Access configuration in plugin methods** using `get_config()`:

```python
# plugin.py
from fastapi_app.lib.utils.config_utils import get_config

class MyPlugin(Plugin):
    async def execute(self, context, params: dict) -> dict:
        config = get_config()
        api_key = config.get("plugin.my-plugin.api-key")
        timeout = config.get("plugin.my-plugin.timeout", default=30)

        # Use config values...
```

**Access configuration in custom routes** using `get_config()`:

```python
# routes.py
from fastapi_app.lib.utils.config_utils import get_config

@router.get("/action")
async def custom_action():
    config = get_config()
    api_key = config.get("plugin.my-plugin.api-key")

    # Use config values...
```

**Priority**: Config file (`data/db/config.json`) > Environment variable > Default value

**Key points**:

- Initialize config in the plugin class `__init__()` using `get_plugin_config()` (creates keys from env vars)
- Access config everywhere else using `get_config()` (retrieves existing keys)
- Config values are automatically created from environment variables on first initialization
- Routes and plugin methods use the same `get_config()` pattern

**MANDATORY: Mask credentials** — Any plugin that reads an API key, password, token, or other credential from an environment variable and stores it via `get_plugin_config()` **must** pass `masked=True`. This ensures the value is excluded from the public (pre-auth) config endpoint and displayed as `****` in the config editor:

```python
get_plugin_config(
    "plugin.my-plugin.api-key",
    "MY_PLUGIN_API_KEY",
    default=None,
    description="API key for My Plugin",
    masked=True,   # REQUIRED for any secret / credential
)
```

Failure to pass `masked=True` for credentials is a security defect.

A masked key without a value (no environment variable, `default=None`) is stored as an empty string, so that it appears as "not set" in the config editor and administrators can enter a shared key there. An empty string counts as unset: the environment variable still applies at the next start, and plugins must treat an empty value like a missing one.

**Example - Plugin availability based on config**:

```python
@classmethod
def is_available(cls) -> bool:
    """Only available if enabled in config."""
    from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

    enabled = get_plugin_config(
        "plugin.my-plugin.enabled",
        "MY_PLUGIN_ENABLED",
        default=False,
        value_type="boolean"
    )

    if not enabled:
        return False

    # Check if required configuration is present
    api_key = get_plugin_config(
        "plugin.my-plugin.api-key",
        "MY_PLUGIN_API_KEY",
        default=None
    )

    if not api_key:
        return False

    return True
```

**Reference Implementation**: See [local_sync plugin](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/local-sync/src/pte_plugin_local_sync) for complete example.

## Role-Based Access

- `required_roles: ["admin"]` - Only admin users
- `required_roles: ["user"]` - Any authenticated user
- `required_roles: ["*"]` - Everyone (including anonymous)
- `required_roles: []` - Everyone (including anonymous)

Wildcard `*` in user roles grants access to all plugins. `required_roles` is any-of, so list every role that should see the plugin (e.g. `["admin", "backup", "restore"]`).

A plugin that needs its own roles adds them to `data/db/roles.json` in `initialize()` with an idempotent function (see `ensure_roles()` in `fastapi_app/plugins/backup_restore/plugin.py`), since the `config/roles.json` defaults are only copied on first start.

## Frontend Integration

Plugins appear in toolbar dropdown, organized by category. Frontend calls:

```javascript
// List plugins (role-filtered)
const plugins = await api.getBackendPlugins();

// Execute plugin
const result = await api.executeBackendPlugin(
  'my-plugin',
  'execute',
  { param: 'value' }
);
```

### Multi-Endpoint Menu Support

Plugins can define multiple menu entries, each calling a different endpoint with different parameters from the application state:

```python
@property
def metadata(self) -> dict[str, Any]:
    return {
        "id": "my-analyzer",
        "name": "Document Analyzer",
        "description": "Analyzes documents",
        "version": "1.0.0",
        "category": "analyzer",
        "required_roles": ["user"],
        "endpoints": [
            {
                "name": "analyze",
                "label": "Analyze Current XML",
                "description": "Analyze currently open XML document",
                "state_params": ["xml", "variant"]
            },
            {
                "name": "analyze_all",
                "label": "Analyze All Documents",
                "description": "Run analysis on all documents",
                "state_params": []
            },
            {
                "name": "info",
                "label": "Plugin Info",
                "description": "Get plugin information",
                "state_params": []
            }
        ]
    }
```

**Endpoint Definition Fields:**

- `name` (required): Endpoint method name (must match key in `get_endpoints()`)
- `label` (required): Display label for menu item
- `description` (optional): Tooltip text
- `state_params` (required): List of state fields to pass as parameters (see [app/src/state.js](../../app/src/state.js))

**Available State Parameters:**

- `pdf` - PDF document ID
- `xml` - XML document ID
- `diff` - Diff XML document ID
- `xpath` - Current XPath selection
- `variant` - Variant filter
- `collection` - Current collection ID
- Other fields from `ApplicationState` typedef

**Backward Compatibility:**

- If `endpoints` not defined: Single menu item calls `execute` endpoint
- If `endpoints` is empty array: Plugin appears in list but adds no menu items

**Example with State Parameters:**

```python
async def analyze(self, context, params: dict) -> dict:
    """Analyze XML document from state parameters"""
    xml_id = params.get("xml")  # Passed from frontend state
    variant = params.get("variant")  # Passed from frontend state

    if xml_id:
        # Load and analyze the XML file
        from fastapi_app.lib.core.dependencies import get_db, get_file_storage
        from fastapi_app.lib.repository.file_repository import FileRepository

        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        file_metadata = file_repo.get_file_by_id_or_stable_id(xml_id)
        if file_metadata and file_metadata.file_type == "tei":
            content_bytes = file_storage.read_file(file_metadata.id, "tei")
            text = content_bytes.decode("utf-8")
            # Perform analysis on text
            return {"analysis": "result"}

    return {"error": "No XML document open"}
```

## Backend Plugin Output Pattern

**IMPORTANT: When creating backend plugins that generate HTML or CSV output, ALWAYS use custom routes instead of returning content directly from plugin endpoints except when generating simple messages such a report on a completed task.**

### Pattern for HTML/CSV Output

1. **Plugin endpoint returns URLs** (not HTML/CSV content):

   ```python
   async def analyze(self, context, params: dict) -> dict:
       """Return URLs pointing to custom routes."""
       pdf_id = params.get("pdf")
       variant = params.get("variant")

       view_url = f"/api/plugins/my-plugin/view?pdf={pdf_id}&variant={variant}"
       export_url = f"/api/plugins/my-plugin/export?pdf={pdf_id}&variant={variant}"

       return {
           "outputUrl": view_url,    # For HTML view
           "exportUrl": export_url,  # For CSV export
           "pdf": pdf_id,
           "variant": variant
       }
   ```

2. **Custom routes generate content** (in `routes.py`):

   ```python
   @router.get("/view", response_class=HTMLResponse)
   async def view_history(
       pdf: str = Query(...),
       variant: str = Query("all"),
       session_id: str | None = Query(None),
       x_session_id: str | None = Header(None, alias="X-Session-ID"),
       session_manager=Depends(get_session_manager),
       auth_manager=Depends(get_auth_manager),
   ):
       """Generate HTML page with results."""
       # Authenticate user
       # Process data
       # Generate HTML using generate_datatable_page() or custom template
       return HTMLResponse(content=html)

   @router.get("/export")
   async def export_csv(
       pdf: str = Query(...),
       variant: str = Query("all")
   ):
       """Generate CSV export."""
       # Process data
       # Generate CSV
       return StreamingResponse(
           iter([csv_content]),
           media_type="text/csv",
           headers={"Content-Disposition": f"attachment; filename=export.csv"}
       )
   ```

### Reference Examples

- `pte-plugins/plugins/edit-history/src/pte_plugin_edit_history/` - Collection-based edit history with DataTables
- `pte-plugins/plugins/annotation-history/src/pte_plugin_annotation_history/` - Document-based annotation history with nested tables



## API Endpoints

- `GET /api/v1/plugins` - List plugins (filtered by user roles)
- `POST /api/v1/plugins/{plugin_id}/execute` - Execute endpoint

Request body:

```json
{
  "endpoint": "execute",
  "params": {"key": "value"}
}
```

## Custom Routes (Optional)

Add `routes.py` for custom FastAPI routes. Plugin routes use the unversioned `/api/plugins` prefix:

```python
from fastapi import APIRouter

# Router prefix uses unversioned /api/plugins
router = APIRouter(prefix="/api/plugins/my-plugin", tags=["my-plugin"])

@router.get("/custom")
async def custom_route():
    return {"custom": "data"}
```

This creates the endpoint at `/api/plugins/my-plugin/custom`.

**Automatic Route Discovery:**

Routes are automatically discovered and registered by the `PluginManager` at application startup. The discovery process:

1. Searches for `routes.py` in each plugin directory
2. Loads the module using `importlib`
3. Looks for a `router` object in the module
4. Registers the router with the FastAPI app via `app.include_router()`

**No manual registration is required** - simply create a `routes.py` file with a `router` export and it will be automatically discovered. The router is registered at the application level (not under `api_v1`), so routes are unversioned.

**Export in `__init__.py` (recommended):**

For consistency with other plugins, also export the router in `__init__.py`:

```python
# __init__.py
from .plugin import MyPlugin
from .routes import router

__all__ = ["MyPlugin", "router"]
```

**Path Requirements:**

- Router prefix should be `/api/plugins/{plugin-id}` (unversioned)
- The router is registered directly on the app (not under the versioned api_v1 router)
- Plugin routes are unversioned and independent of the main API versioning
- Plugin routes are excluded from the generated API client (`api-client-v1.js`)

**Frontend Access:**

Plugin routes should be called using the `callPluginApi` method from `BackendPluginsPlugin`, not the main `callApi` function:

```javascript
// In a plugin or component that has access to BackendPluginsPlugin
const backendPluginsPlugin = /* get BackendPluginsPlugin instance */;

// GET request with query params
const response = await backendPluginsPlugin.callPluginApi(
  '/api/plugins/my-plugin/custom',
  'GET',
  { param1: 'value1', param2: 'value2' }
);

// POST request with JSON body
const response = await backendPluginsPlugin.callPluginApi(
  '/api/plugins/my-plugin/action',
  'POST',
  { data: 'value' }
);

// Handle different response types
const jsonData = await response.json();  // For JSON responses
const blob = await response.blob();      // For file downloads
const text = await response.text();      // For text responses
```

The `callPluginApi` method:

- Automatically adds authentication headers (`X-Session-ID`)
- Handles query parameters for GET requests
- Handles JSON body for POST/PUT/etc requests
- Returns the raw `Response` object for flexible response handling
- Throws errors for non-OK responses

## Key Files

- [fastapi_app/lib/plugins/plugin_base.py](../../fastapi_app/lib/plugins/plugin_base.py) - Base classes
- [fastapi_app/lib/plugins/plugin_registry.py](../../fastapi_app/lib/plugins/plugin_registry.py) - Discovery
- [fastapi_app/lib/plugins/plugin_manager.py](../../fastapi_app/lib/plugins/plugin_manager.py) - Lifecycle
- [fastapi_app/routes/plugins.py](../../fastapi_app/routes/plugins.py) - API routes
- [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js) - Frontend integration

## Plugin Response Formats

Backend plugins can return results in three formats depending on the complexity and interaction requirements:

### 1. Inline HTML (for simple content)

Use the `html` field for short, simple text results that fit comfortably in the dialog:

```python
async def execute(self, context, params: dict) -> dict:
    """Return simple HTML content."""
    return {
        "html": "<p>Analysis complete. Found 42 matches.</p>"
    }
```

**When to use:**

- Short text results (a few paragraphs)
- Simple lists or small tables
- Quick status messages or summaries
- Content that doesn't need extensive formatting

### 2. Standalone Pages (for complex content)

Use the `outputUrl` field for complex, tabular data, or content requiring JavaScript libraries:

```python
async def execute(self, context, params: dict) -> dict:
    """Return URL to standalone page."""
    collection_id = params.get("collection")
    variant = params.get("variant")

    # Build URL to custom route that returns complete HTML page
    view_url = f"/api/plugins/my-plugin/view?collection={collection_id}&variant={variant}"
    export_url = f"/api/plugins/my-plugin/export?collection={collection_id}&variant={variant}"

    return {
        "outputUrl": view_url,      # Displayed in iframe
        "exportUrl": export_url,    # Optional: enable export button
        "collection": collection_id # Optional: pass data to frontend
    }
```

**When to use:**

- Large tables with sorting/filtering (e.g., DataTables)
- Content requiring external JavaScript libraries
- Complex visualizations or charts
- Multi-section reports
- Any content needing custom CSS or extensive styling

**Benefits:**

- Proper script execution (iframe loads scripts naturally)
- Better performance (libraries load once)
- "Open in new window" button for full-screen viewing
- Cleaner separation (route generates HTML, plugin coordinates)

**Implementation pattern:**

1. **Create a custom route** in `routes.py` that generates the full HTML page:

```python
from fastapi import APIRouter
from fastapi.responses import HTMLResponse
from fastapi_app.lib.plugins.plugin_tools import generate_datatable_page, escape_html

router = APIRouter(prefix="/api/plugins/my-plugin", tags=["my-plugin"])

@router.get("/view", response_class=HTMLResponse)
async def view_results(
    collection: str = Query(...),
    variant: str | None = Query(None),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Generate standalone HTML page with results."""
    # Authenticate user (see User Authentication section)
    # ...

    # Prepare table data
    headers = ["Column 1", "Column 2", "Column 3"]
    rows = [
        [escape_html("Data 1"), escape_html("Data 2"), "Data 3"],
        # ... more rows
    ]

    # Generate HTML page with DataTables
    html = generate_datatable_page(
        title="My Plugin Results",
        headers=headers,
        rows=rows,
        table_id="resultsTable",
        page_length=25,
        default_sort_col=0,
        default_sort_dir="desc",
        enable_sandbox_client=True  # For inter-window communication
    )

    return HTMLResponse(content=html)
```

1. **Return the URL** from your plugin endpoint:

```python
async def execute(self, context, params: dict) -> dict:
    collection_id = params.get("collection")
    view_url = f"/api/plugins/my-plugin/view?collection={collection_id}"

    return {
        "outputUrl": view_url,
        "collection": collection_id
    }
```

**See also:** [edit_history plugin](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/edit-history/src/pte_plugin_edit_history) for complete example.

### 3. Preview-then-Execute Pattern (for operations requiring confirmation)

Use the `outputUrl` and `executeUrl` fields together for operations that should show a preview before execution:

```python
async def execute(self, context, params: dict) -> dict:
    """Return URLs for preview and execute endpoints."""
    collection_id = params.get("collection")
    variant = params.get("variant", "all")

    # Build URLs for preview and execute
    variant_param = f"&variant={variant}" if variant != "all" else ""
    preview_url = f"/api/plugins/my-plugin/preview?collection={collection_id}{variant_param}"
    execute_url = f"/api/plugins/my-plugin/execute?collection={collection_id}{variant_param}"

    return {
        "outputUrl": preview_url,      # Shows preview in iframe
        "executeUrl": execute_url,      # Execute button calls this URL
        "collection": collection_id,
        "variant": variant
    }
```

**When to use:**

- Operations that modify data (syncing, batch updates, deletions)
- Operations where users need to review changes before applying
- Operations that can be expensive and should be confirmed

**User flow:**

1. Plugin returns `outputUrl` and `executeUrl`
2. Frontend displays preview in iframe (from `outputUrl`)
3. Execute button appears in dialog footer
4. User reviews changes and clicks Execute
5. Execute button loads `executeUrl` in the same iframe
6. Execute button is hidden after clicking

**Implementation pattern:**

Create two routes in `routes.py`:

```python
@router.get("/preview", response_class=HTMLResponse)
async def preview_operation(
    collection: str = Query(...),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Generate preview HTML (dry-run mode)."""
    # Authenticate user
    # Perform dry-run operation
    # Generate detailed HTML with preview notice
    # Return HTML with message: "Click Execute to apply these changes"
    return HTMLResponse(content=preview_html)

@router.get("/execute", response_class=HTMLResponse)
async def execute_operation(
    collection: str = Query(...),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Execute the operation and return summary HTML."""
    # Authenticate user
    # Perform actual operation
    # Generate summary HTML (statistics only)
    return HTMLResponse(content=summary_html)
```

**Preview HTML structure:**

- Include prominent notice: "Preview Mode - Click Execute to apply changes"
- Show detailed list of changes that will be made
- Use complete HTML document with styles
- Keep layout clean and readable

**Execute HTML structure:**

- Show success message
- Display summary statistics only (no details)
- Optionally show errors if any occurred
- Use complete HTML document with styles

**See also:** [local_sync plugin](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/local-sync/src/pte_plugin_local_sync) for complete example.

### 4. Options-then-Execute Pattern (for user-configured operations)

Use `outputUrl` with `sandbox.navigateIframe()` when the user must configure options in a form before execution starts. Unlike Preview-then-Execute (which uses a fixed `executeUrl`), this pattern lets the iframe build the next URL dynamically based on form input.

**User flow:**

1. Plugin endpoint returns `outputUrl` pointing to an options form route
2. Frontend loads form in iframe
3. User configures options, clicks "Start"
4. Form JS calls `sandbox.navigateIframe('/api/plugins/.../execute?params...')`
5. Sandbox injects `session_id` and navigates iframe to execution route
6. Execution route runs and displays results

**Key requirements:**

- Options form must include `generate_sandbox_client_script()` so `sandbox.navigateIframe()` is available
- `session_id` is injected automatically — form JS only builds the path and query parameters
- "Cancel" button can call `sandbox.closeDialog()`
- Each page in the chain is a full page load; the sandbox client reconnects on each navigation

For detailed implementation pattern with code examples, see [Options-then-Execute Pattern](../development/plugin-system-backend.md#4-options-then-execute-pattern-for-user-configured-operations).

**See also:** [update_metadata plugin](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/update-metadata/src/pte_plugin_update_metadata) for complete example.

## Interactive HTML Content

Both response formats support interactive elements through the **Plugin Sandbox** interface.

### Plugin Sandbox API

When plugin content is displayed (either via `html` or `outputUrl`), a `window.pluginSandbox` object (or `window.sandbox` in standalone pages) exposes methods to interact with the application:

```javascript
// Available methods:
// - In inline HTML: window.pluginSandbox
// - In standalone pages (outputUrl): window.sandbox

// Update application state (any fields from ApplicationState) - async
await pluginSandbox.updateState({ xml: 'doc-id', variant: 'model-x' });

// Close the result dialog
pluginSandbox.closeDialog();

// Navigate the iframe to a new URL (session_id injected automatically)
sandbox.navigateIframe('/api/plugins/my-plugin/execute?param=value');

// Convenience: Open a document (updates xml state, clears diff, closes dialog) - async
await pluginSandbox.openDocument('stable-id');

// Convenience: Open diff view (updates xml and diff states, closes dialog) - async
await pluginSandbox.openDiff('stable-id-1', 'stable-id-2');
```

### Example: Clickable Links

**In inline HTML:**

```python
async def execute(self, context, params: dict) -> dict:
    """Generate interactive HTML with clickable links."""
    doc_id = "abc123"

    # Create clickable link that opens document
    html = f'''
    <p>View document:
      <a href="#"
         onclick="window.pluginSandbox.openDocument('{doc_id}'); return false;"
         style="color: #0066cc; text-decoration: underline;">
        {doc_id}
      </a>
    </p>
    '''

    return {"html": html}
```

**In standalone pages (outputUrl):**

When using `generate_datatable_page()` with `enable_sandbox_client=True`, use `sandbox` (not `pluginSandbox`):

```python
# In your custom route
from fastapi_app.lib.plugins.plugin_tools import escape_html

doc_link = f'''<a href="#"
   onclick="sandbox.openDocument('{entry["stable_id"]}'); return false;"
   style="color: #0066cc; text-decoration: underline;">
   {escape_html(entry["doc_label"])}
</a>'''

rows.append([
    escape_html(entry["date"]),
    doc_link,  # Clickable link
    escape_html(entry["description"])
])
```

### Available State Fields

The sandbox can update any field from `ApplicationState` (see [app/src/state.js](../../app/src/state.js)):

- `xml` - Open XML document ID
- `diff` - Diff XML document ID (triggers diff view when set with `xml`)
- `pdf` - Open PDF document ID
- `xpath` - Current XPath selection
- `variant` - Variant filter
- `collection` - Current collection ID
- Other fields as needed

### Implementation Examples

- **Inline HTML**: The [iaa_analyzer plugin](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/iaa-analyzer/src/pte_plugin_iaa_analyzer/plugin.py) demonstrates inline HTML with clickable stable IDs and match counts that open documents or diff views
- **Standalone pages**: The [edit_history plugin](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/edit-history/src/pte_plugin_edit_history) demonstrates the `outputUrl` pattern with a complete DataTables implementation

### Utility Functions

The `fastapi_app.lib.plugin_tools` module provides utilities for generating plugin content:

**`generate_datatable_page()`** - Generate complete HTML page with sortable DataTables table:

```python
from fastapi_app.lib.plugins.plugin_tools import generate_datatable_page, escape_html

html = generate_datatable_page(
    title="Results",                    # Page title
    headers=["Col1", "Col2"],          # Column headers
    rows=[                              # Table rows (can contain HTML)
        [escape_html("A"), "B"],
        [escape_html("C"), "D"]
    ],
    table_id="myTable",                # HTML table ID
    page_length=25,                    # Rows per page
    default_sort_col=0,                # Sort column index
    default_sort_dir="desc",           # "asc" or "desc"
    enable_sandbox_client=True,        # Include sandbox for links
    custom_css="",                     # Additional CSS
    custom_js=""                       # Additional JavaScript
)
```

**`escape_html()`** - Escape HTML to prevent XSS:

```python
from fastapi_app.lib.plugins.plugin_tools import escape_html

safe_text = escape_html(user_input)  # Escapes <, >, &, ", '
```

**`generate_sandbox_client_script()`** - Generate sandbox client for custom HTML pages (advanced use). In development it extracts the API live from `app/src/modules/backend-plugin-sandbox.js`. In production that source directory is removed after the frontend build (see `Dockerfile`), so it instead reads the script pre-generated at build time into `app/web/sandbox-client.js` by `scripts/build/generate-sandbox-client-script.py`. If you add a method to `PluginSandbox` (`backend-plugin-sandbox.js`), no action is needed beyond the normal build - the script is regenerated as part of the Docker build automatically.

**`load_plugin_html()`** - Load an HTML template from `static/` and inject the sandbox client automatically:

```python
from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

@router.get("/view", response_class=HTMLResponse)
async def view_page(...):
    html = load_plugin_html(__file__, "view.html")
    return HTMLResponse(content=html)
```

Reads `static/view.html` relative to the calling module's directory. Pass `inject_sandbox=False` to skip sandbox injection. The legacy `html/` directory is still supported as a fallback for backwards compatibility but is deprecated.

**`wrap_html_with_sandbox_client()`** - Lower-level helper that injects the sandbox client script into an arbitrary HTML string (advanced use).

**IMPORTANT**: Never inline long HTML strings in route files. Place HTML in external template files in `static/` and load them with `load_plugin_html()`.

## Frontend Extensions

Backend plugins can register JavaScript files that extend frontend functionality. These extensions integrate with the application's PluginManager lifecycle and have access to a controlled sandbox API.

See [Frontend Extensions](../development/frontend-extensions.md) for detailed documentation.

Quick reference:

- Register extensions via `FrontendExtensionRegistry.register_extension(path, plugin_id)`
- Extensions integrate with PluginManager lifecycle (`install`, `start`, `onStateUpdate`)
- Use sandbox for controlled API access (`ui`, `dialog`, `notify`, `invoke`, etc.)

**Example registration in plugin initialize():**

```python
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from pathlib import Path

async def initialize(self, context: PluginContext) -> None:
    registry = FrontendExtensionRegistry.get_instance()
    extension_file = Path(__file__).parent / "extensions" / "my-extension.js"
    if extension_file.exists():
        registry.register_extension(extension_file, self.metadata["id"])
```


### Fallback for Autosearch

When the text of the selected XML node is not found in the PDF (typically because the PDF is a scan without text layer), or the node has no text at all (e.g. an empty `<pb/>` selected via the navigation), the Autosearch switch of the PDF viewer asks the `pdfSearch.fallback` extension point for a page. A frontend extension implements it to supply its own heuristic:

```javascript
class MyExt extends window.FrontendExtensionPlugin {
  static extensionPoints = ['pdfSearch.fallback'];

  /**
   * @param {Element} node - the selected XML node
   * @param {{xml: string|null, pageCount: number}} info - the document id and the page count of the loaded PDF
   * @returns {{page: number}|null} 1-based PDF page, or null if the handler does not apply to this document
   */
  ['pdfSearch.fallback'](node, { pageCount }) {
    return { page: 3 }
  }
}
```

The first handler returning a valid page wins; the viewer scrolls to the top of that page. The pdf-tei-editor plugin [pte-edition-plugin](https://github.com/cboulanger/pte-edition-plugin) uses it to map the nearest preceding `<pb>` to a PDF page, taking the pages of the prepended form into account.

## Notes

- **Directory naming**: Use underscores (e.g., `my_plugin`) not hyphens (e.g., `my-plugin`) in directory names to avoid Python import issues
- Shadow DOM: Frontend uses `querySelector` to access Shoelace menu elements
- Plugin discovery happens at startup
- Plugins can be reloaded without restart in dev mode
- Use `PluginManager.get_instance()` to access plugin manager
- **Plugin Sandbox**: Always available as `window.pluginSandbox` when plugin HTML is displayed
- **HTML escaping**: Always escape user-provided content in HTML to prevent XSS attacks

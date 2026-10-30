# HTML templates for backend plugin frontend extensions

## Problem

Frontend extensions shipped by backend plugins cannot use the HTML template system (`registerTemplate` / `createFromTemplate`). They build UI imperatively with `document.createElement` and `innerHTML`.

Current obstacles:

- Extensions are IIFEs with imports stripped; they reach app modules only through `getDependency()`, and `ui-system.js` is not registered in `app/src/module-registry.js`.
- In production, `getTemplateHtml()` in `app/src/modules/ui-system.js` ignores `pathOrHtml` and looks the id up in `templates.json`, which `scripts/build/bundle-templates.js` builds from `app/src/templates/` only. A plugin template would work in `?dev` mode and fail in production.
- Relative template paths are resolved against `/src/templates/`.

## Goals

- A backend plugin can ship HTML templates next to its extensions and instantiate them from extension code.
- Identical behavior in dev and production, without a build step for plugins.
- No new network round-trips.
- Template ids from different plugins and from the app cannot collide.

## Non-goals

- Typed access to plugin UI elements (`ui.js` `@typedef`s cannot cover them; untyped access is accepted).
- Lazy loading of templates.
- Templates for static plugin pages under `static/` (those are plain HTML files and unaffected).

## Design

### 1. Plugin layout

A plugin may add a `templates/` directory next to `extensions/`:

```text
my_plugin/
├── plugin.py
├── extensions/
│   └── my-extension.js
└── templates/
    ├── my-dialog.html
    └── my-toolbar-button.html
```

- Flat directory, only `*.html` files are considered; subdirectories are ignored.
- The template name is the file stem (`my-dialog.html` → `my-dialog`), matching the convention for app templates.
- Discovery is automatic: no change to `plugin.py`. The backend derives the directory from each registered extension file as `<extension file>.parent.parent / "templates"`. All existing plugins register extensions from `Path(__file__).parent / "extensions"`, so this holds by convention.
- Pip-packaged plugins (`pte-plugins` repo) must include `templates/*.html` as package data, as they already do for `extensions/*.js`. Document this in `docs/code-assistant/backend-plugins.md`.

### 2. Server-side bundling

`GET /api/v1/plugins/extensions.js` (`fastapi_app/routers/plugins.py`) inlines the templates into the bundle it already builds:

- For each distinct `plugin_id` in `FrontendExtensionRegistry.get_extension_files()`, before that plugin's first extension IIFE, emit one call:

  ```javascript
  // Frontend templates from plugin: my_plugin
  window.registerFrontendExtensionTemplates("my_plugin", {"my-dialog": "<sl-dialog ...>...</sl-dialog>", ...});
  ```

- The map is serialized with `json.dumps` (keys = template names, values = file contents, stripped). The bundle is executed via `scriptEl.textContent`, so `</script>` in template content is harmless.
- Plugins without a `templates/` directory, or with an empty one, emit nothing.
- Templates are read on every request, as extension files already are (`Cache-Control: no-store`), so editing a template in dev takes effect on reload. This is why there is no dev/prod split.
- A read or validation failure for a template is logged and emitted as a `// Error ...` comment, like extension load failures. It does not abort the bundle; the plugin's extensions then fail at instantiation with the existing "not registered" error, which names the missing id.
- The `FrontendExtensionRegistry` stays unchanged; template collection lives in a helper in `fastapi_app/lib/plugins/` (e.g. `collect_extension_templates(extension_files) -> dict[str, dict[str, str]]`) so the router remains thin and the helper is unit-testable.

### 3. Frontend registration

`app/src/modules/ui-system.js`:

- New synchronous `addTemplateHtml(id, html)` that stores an already-loaded template (`cached: true`) in the registry. It bypasses `getTemplateHtml()` and therefore works the same in dev and production. Overwrite warns as `registerTemplate` does today.

`app/src/modules/frontend-extension-registry.js`:

- New global `window.registerFrontendExtensionTemplates(pluginId, templates)` that calls `addTemplateHtml(`${pluginId}:${name}`, html)` for each entry.
- `registerFrontendExtension(ExtensionClass, pluginId)` additionally sets `ExtensionClass.backendPluginId = pluginId`.
- Order is guaranteed by the bundle: template registration calls precede the plugin's IIFEs, and `loadExtensionsFromServer()` executes the whole bundle before any `createInstance()` / `pluginManager.register()`. Templates are therefore registered before any extension's `install()`.
- `clearExtensions()` is unaffected; tests that need to reset templates use a matching `removeTemplates(prefix)` only if a test actually needs it (not planned).

### 4. Convenience API on `FrontendExtensionPlugin`

`app/src/modules/frontend-extension-plugin.js` gains:

- `get backendPluginId()` → `this.constructor.backendPluginId` (the id passed by the bundle; `undefined` outside the bundle, e.g. in unit tests that instantiate the class directly).
- `templateId(name)` → `${this.backendPluginId}:${name}`.
- `createFromTemplate(name, parentNode = null, params = {})` and `createSingleFromTemplate(name, parentNode = null, params = {})`, which prefix the name and delegate to the `ui-system` functions of the same name.
- `getTemplateHtml(name)` → the cached HTML string, for extensions that need the raw markup.

All methods are synchronous and take the bare template name. Extensions never see where the HTML came from. Since templates are always inlined, there is no fetch fallback. If lazy loading were added later, it would happen behind these methods and require an `await` in callers, which would be a breaking change at that point. That trade-off is accepted.

An extension can still use a template from another plugin (or an app template) by calling `ui-system` directly with the full id (see 5).

### 5. Module exposure and UI wiring

`app/src/module-registry.js` registers a new module `ui-system` with `registerTemplate`, `addTemplateHtml`, `createFromTemplate`, `createSingleFromTemplate` and `updateUi`.

- `createFromTemplate(id, parentNode)` already calls `updateUi()` when `parentNode` is given, so named elements become reachable through `getDependency('ui')` without extra calls.
- Extensions that create nodes without a parent and insert them themselves (e.g. into a shadow root, or via `tools.addMenuItems`) call `this.getDependency('ui-system').updateUi()` afterwards.
- `getDependency('ui')` stays valid after `updateUi()`: `createNavigableElement(document)` assigns the named elements onto `document` and returns it, so the registered `ui` object is the live `document`, not a snapshot.
- Access to plugin elements via `ui` is untyped.

### 6. Interactions checked

| Concern | Finding | Consequence |
| --- | --- | --- |
| JS validator bypass | `validate_javascript_content` checks extension JS only. Template HTML is inserted via `innerHTML`; `<script>` does not execute, but inline handlers (`onerror=`, `onclick=`) and `javascript:` URLs do, which would bypass the `fetch`/`eval`/`localStorage` checks. | Validate templates: reject a template containing `<script`, an `on*=` attribute, or a `javascript:` URL. A rejected template is skipped with a logged warning and a `// Skipped` comment, like extensions. Extensions attach handlers in JS. |
| Access gating | `GatedStaticFiles` gates by plugin *active* state, not by role. The extension bundle is not role-gated either; inactive plugins are removed from `FrontendExtensionRegistry` via `unregister_plugin`. | Templates follow the extension bundle: delivered iff the plugin is active, to every client. Templates must not contain anything sensitive; this is the same exposure as extension JS. |
| Id collisions | The registry is global and only warns on overwrite. App templates have no prefix, and plugin ids do not contain `:`. | `pluginId:name` cannot clash with app templates or other plugins. Two extensions of the same plugin share the namespace by design. |
| Template parameters | `${param}` substitution in `replaceTemplateParameters` uses the same syntax as JS template literals. | No effect: templates are JSON strings in the bundle, not JS template literals. |
| Bundle size | All active plugins' templates are inlined into a `no-store` response on every page load. | Acceptable at current scale (a few KB per plugin). Revisit with ETag caching if bundles grow. |
| Hot plugin install / uninstall | The bundle is rebuilt per request from the registry, so templates follow plugin activation without a restart, with the same page-reload requirement as extension JS. | None. |
| Element-name collisions | Template ids are namespaced, but `name` attributes are not: `updateUi()` merges every named element into the one global `ui` tree, and a second element with the same top-level name silently replaces the first. Document rules alone adds `documentRulesEditorDialog`, `documentRulesUpdateDialog`, `documentRulesProposeDialog`. | Convention: top-level `name`s in plugin templates start with the plugin id in camelCase (`grobidSettingsDialog`). The template collector logs a warning for a top-level `name` without that prefix; it does not reject it. |
| Global styles | Plugin dialogs need page-level CSS, e.g. the `--sl-z-index-dialog` boosts in `app/web/app.css` that keep nested dialogs (document rules' propose dialog over its editor dialog) above each other regardless of DOM order. Extensions cannot ship CSS today, and a `<style>` inside a template is only applied while an instance is in the DOM. | Plugin stylesheets, see section 7. |
| `has_frontend_extension` in plugin admin info | Checks `extensions/*.js` only. | Unchanged; templates without extensions are useless and are not discovered. |

### 7. Plugin stylesheets

- `templates/*.css` files are collected with the templates and inlined into the same bundle, before the plugin's template registration call:

  ```javascript
  window.registerFrontendExtensionStyles("my_plugin", "/* my-dialog.css */ ...");
  ```

- `registerFrontendExtensionStyles` appends one `<style data-plugin="my_plugin">` to `document.head` (replacing an existing one for that plugin), so styles apply before any extension's `install()`.
- Validation rejects a stylesheet containing `@import`, `url(` with a scheme other than `data:` or a relative/`/api/` path, `expression(` or `javascript:`; the stylesheet is skipped with a warning like a rejected template.
- Selectors are not scoped automatically. The documented convention is to select by the plugin's own element names or a `data-plugin` attribute on the template root.

## Validation case: document rules (#666) as a plugin

To check whether this design, together with the existing plugin API, is enough to move a feature out of core, the document rules feature (#666 and its predecessors; editor dialog, human/machine sync, update from guide, upstream proposals) was walked through an extraction into a `document-rules` plugin in pte-plugins. Extraction is not planned; the result is the checklist below and the list of core gaps.

### Footprint in core

| Area | Files |
| --- | --- |
| Backend library | `fastapi_app/lib/doc_rules/` (16 modules), `lib/models/models_document_rules.py` |
| Routes | `routers/document_rules.py` (`/api/v1/document-rules/...`) |
| Database | migrations `m009_document_rules_tables`, `m011_document_rules_section_overrides` (tables in `metadata.db`) |
| Startup | `main.py`: legacy override-key migration thread, GitHub secret service |
| Hooks into core | `dependencies.get_document_rules_store`, `plugin_api.register_document_rules_provider`, `routers/validation.py` (per-user schema override), `lib/utils/annotation_rules_utils.py` |
| Frontend | `plugins/document-rules.js` (2200 lines), `modules/document-rules-decorations.js`, 5 templates with `.types.js`, `ui.js` typedefs, `api-client-v1.js` methods, 3 rules in `app/web/app.css` |
| Frontend consumers | `plugins/annotation-guide.js` (personal version of a guide section) |
| Plugin consumers | grobid, llamore-extractor (rules providers, `extraction_contribution`), annotation-review (store, selected override) |
| Tests | 19 Python unit test files (incl. migrations and router), 6 JS unit test files, `tests/e2e/tests/document-rules.spec.js`, TEI fixtures in `tests/e2e/fixtures/standard/files/tei/document-rules/` |

### Gaps found

| # | Gap | Needed for | Where |
| --- | --- | --- | --- |
| 1 | HTML templates for extensions | 5 dialog/menu templates | this PR |
| 2 | Plugin stylesheets | dialog stacking rules in `app.css` | this PR (section 7) |
| 3 | Element-name collisions in `ui` | 3 top-level dialog names | this PR (convention + warning) |
| 4 | Frontend modules beyond `ui-system`: `markdown-utils`, `panels` (`PanelUtils`), the CodeMirror packages (`@codemirror/state`, `view`, `merge`, `commands`, `lang-xml`, `lang-markdown`, `@lezer/markdown`), `codemirror/editor-themes`, `codemirror/dialog-search` | editor dialog (merge view, markdown editor), headerbar widget | follow-up: extend `module-registry.js`; CodeMirror as one `codemirror` module re-exporting the used symbols, so extensions share the app's instances (two copies of `@codemirror/state` break `instanceof` checks) |
| 5 | Plugin-owned database migrations | `m009`/`m011` tables; existing instances already have them | follow-up: `register_plugin_migrations(plugin_id, migrations)` in `plugin_api`, versioned per plugin, run in `initialize()` under the existing migration lock. Tables created by core migrations keep their names, and the plugin's first migration adopts them (`CREATE TABLE IF NOT EXISTS`) |
| 6 | `plugin_api` exports for secrets (`register_secret_service`, `unregister_secret_service`, `MissingSecretError`, `get_secret_store`) | GitHub token for pull requests | follow-up; inference-endpoints, anthropic-llm and kisski already import `fastapi_app.lib.secrets` directly |
| 7 | `plugin_api` exports for `UrlCache`, `GitForgeAdapterRegistry`, `check_file_access`, `extract_schema_locations` | fetching rule files, forge permalinks and pull requests, writing refreshed TEI | follow-up |
| 8 | Hook for validation schema overrides: `routers/validation.py` calls `build_schema_text_override` directly | per-user schema overrides during validation | follow-up: `register_schema_override_provider(fn(xml, user) -> dict[str, str])` next to the schema registration functions |
| 9 | Frontend extension point for the annotation guide: `annotation-guide.js` calls `documentRulesSelectedOverride` | "Personal version" badge and section replacement | follow-up: e.g. `annotationGuide.transformSection(markdown, url, anchor)` invoked by the annotation-guide plugin, implemented by the extension |
| 10 | A Python API published by one plugin and used by others, with an optional dependency | grobid and llamore register rules providers; annotation-review and llamore read overrides | follow-up: document the pattern. The provider registry moves to the document-rules plugin and is exposed through `get_service_registry()` as a capability; consumers look it up in `initialize()` and skip registration when it is absent, instead of importing it. A hard dependency is declared as `Requires-Dist: pte-plugin-document-rules` |
| 11 | Plugin E2E tests can be staged, plugin data fixtures cannot: `tests/lib/plugin-tests.js` copies spec files only | TEI fixtures of `document-rules.spec.js` | follow-up: stage `<plugin>/tests/e2e/fixtures/files/` into the fixture set used by the run |
| 12 | Typed `ui` access and a typed API client for plugin routes | `.types.js` typedefs, `api-client-v1.js` methods | accepted loss (non-goal); the extension declares local JSDoc typedefs for its responses and uses `callPluginApi` |

Not gaps: `tools.addMenuItems`, `xmleditor.createExtensionSlot` / `addHeaderbarWidget`, `dialog`, `api-keys.withKeyPrompt`, `inference-settings` and `logger` are reachable through `getDependency()`; plugin routes, `LLMProviderRegistry` and config are in `plugin_api`; `fetch` to `/api/` passes the JS validator. The JS validator rejects the `window.open(response.url, '_blank', 'noopener')` that opens the forge's edit page; the extension has to open it through a clicked `<a target="_blank" rel="noopener">` instead, as the pull-request link in the same plugin already does. This is a code change, not a core gap.

### Agent checklist for moving a feature out of core

Run each step against the feature and record the result in the plan before writing code. A "gap" outcome blocks the extraction until core provides the missing piece in a separate PR.

1. **Inventory inbound dependencies.** `git grep` for the feature's modules, routes, templates and API client methods outside the feature's own files, in core and in pte-plugins. Every hit is either moved, replaced by a hook, or a gap.
2. **Inventory outbound dependencies.** List every core import the feature makes (`git grep -h "from fastapi_app" <files> | sort | uniq -c`). Each must be in `fastapi_app/plugin_api.py`; anything else is a gap (add the export) or moves with the feature.
3. **Persistent state.** Tables, migrations, files under `data/`, secrets, config keys. Existing instances keep their data: plan the adoption of existing tables and config keys by the plugin, never a rename.
4. **Startup and background work.** Code in `main.py` lifespan, background threads, GC handlers: move to `initialize()` / `cleanup()`, and check it is safe to run in every worker.
5. **Request-path hooks.** Places where core routers call into the feature (validation, extraction, file save). Each needs a registration function in `plugin_api` that does nothing when no plugin is registered.
6. **Routes and client.** `/api/v1/<feature>` becomes `/api/plugins/<id>/...`; remove the `api-client-v1.js` methods and typedefs; the extension uses `callPluginApi`. Check whether external clients use the old URL.
7. **Frontend code.** Every `import` in the plugin file must be reachable through `getDependency()` (app plugins, `module-registry.js`). Missing modules are gaps. Check the JS validator against the code (`fetch` outside `/api/`, `window.open`, `localStorage`, dynamic `import()`).
8. **Templates and styles.** Move templates to `templates/`, prefix top-level `name`s, move CSS from `app/web/app.css` to `templates/*.css`, drop the `ui.js` typedefs and `.types.js` files.
9. **Frontend consumers.** Core plugins that call the feature's methods or client endpoints need an extension point that the extension implements.
10. **Plugin consumers.** Plugins that import the feature's Python API: decide between a hard dependency (`Requires-Dist`) and an optional capability looked up in `initialize()`, and update them in the same release.
11. **Tests.** Python unit tests move to `<plugin>/src/<pkg>/tests/`, JS unit tests import the extension file directly, API and E2E tests to `<plugin>/tests/api|e2e`; data fixtures must be stageable (gap 11). Add the feature to `test_core_plugin_independence.py` so core cannot import it again.
12. **Docs and references.** User manual, `docs/development/*`, CLAUDE.md files in core and in repositories that link to the feature (fossil's CLAUDE.md, grobid's `annotation_guides.py`).
13. **Release order.** Core release with the new hooks and exports first, then the plugin release, then the core release that deletes the feature and pins the plugin in `pyproject.toml`.

## Testing

- Python unit tests for the template collector: discovery via the extension path, file-stem naming, ignoring non-HTML files and subdirectories, rejection of `<script>` / `on*=` / `javascript:`, stylesheet collection and validation, the warning for unprefixed top-level `name`s.
- API test in `tests/api/v1/plugins_extensions.test.js`: the bundle contains a `registerFrontendExtensionTemplates("test-plugin", ...)` call ahead of the test plugin's IIFE, and a `registerFrontendExtensionStyles` call when the plugin has a stylesheet.
- Frontend unit test for `addTemplateHtml`, `registerFrontendExtensionTemplates`, and the `FrontendExtensionPlugin` template methods (prefixing, missing-template error).
- A new fixture plugin `tests/fixtures/plugins/reference_plugin` (available in testing mode only, `"hidden": True` so the plugin manager does not list it) serves as test subject and reference implementation: a toolbar button and a parameterized dialog from templates, and a stylesheet. `tests/e2e/tests/frontend-extension.spec.js` checks that the dialog is rendered from the template, reachable through `ui` and styled by the stylesheet. The hello-world extension of `test_plugin` stays as the example of an extension without templates.

## Documentation

- `docs/code-assistant/backend-plugins.md`: `templates/` directory, naming, the `name` prefix convention, stylesheets, validation rules, packaging as package data.
- `docs/code-assistant/plugin-development.md` / the frontend extension section: the template methods on `FrontendExtensionPlugin` and the `ui-system` module.

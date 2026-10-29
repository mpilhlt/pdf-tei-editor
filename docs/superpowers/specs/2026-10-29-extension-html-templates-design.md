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
| `has_frontend_extension` in plugin admin info | Checks `extensions/*.js` only. | Unchanged; templates without extensions are useless and are not discovered. |

## Testing

- Python unit tests for the template collector: discovery via the extension path, file-stem naming, ignoring non-HTML files and subdirectories, rejection of `<script>` / `on*=` / `javascript:`.
- API test in `tests/api/v1/plugins_extensions.test.js`: the bundle contains a `registerFrontendExtensionTemplates("test-plugin", ...)` call ahead of the test plugin's IIFE.
- Frontend unit test for `addTemplateHtml`, `registerFrontendExtensionTemplates`, and the `FrontendExtensionPlugin` template methods (prefixing, missing-template error).
- Convert the test plugin's hello-world dialog to a template and extend `tests/e2e/tests/frontend-extension.spec.js` so the dialog is rendered from it and reachable through `ui`.

## Documentation

- `docs/code-assistant/backend-plugins.md`: `templates/` directory, naming, validation rules, packaging as package data.
- `docs/code-assistant/plugin-development.md` / the frontend extension section: the template methods on `FrontendExtensionPlugin` and the `ui-system` module.

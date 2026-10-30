# HTML templates for backend plugin frontend extensions

PR #677. Design: [docs/superpowers/specs/2026-10-29-extension-html-templates-design.md](../superpowers/specs/2026-10-29-extension-html-templates-design.md). User documentation: [docs/development/frontend-extensions.md](../development/frontend-extensions.md#html-templates-and-stylesheets).

## Implementation

| Part | Files |
| --- | --- |
| Collecting, validating and rendering templates and stylesheets | `fastapi_app/lib/plugins/extension_templates.py` |
| Inlining into the extension bundle, once per plugin ahead of its first extension | `fastapi_app/routers/plugins.py` (`get_extensions_bundle`) |
| Synchronous template registration | `app/src/modules/ui-system.js` (`addTemplateHtml`, `getRegisteredTemplateHtml`, re-export of `updateUi`) |
| Bundle globals | `app/src/modules/frontend-extension-registry.js` (`registerFrontendExtensionTemplates`, `registerFrontendExtensionStyles`, `backendPluginId` on the extension class) |
| Extension API | `app/src/modules/frontend-extension-plugin.js` (`templateId`, `createFromTemplate`, `createSingleFromTemplate`, `getTemplateHtml`, `backendPluginId`) |
| `ui-system` module for `getDependency()` | `@registerModule` tag in `ui-system.js`, regenerated `app/src/module-registry.js` |
| Hidden plugins | `"hidden": True` in plugin metadata, filtered in `fastapi_app/routers/plugins_admin.py` |
| Reference implementation and test subject | `tests/fixtures/plugins/reference_plugin/` |

## Decisions made during implementation

- Stylesheets (`templates/*.css`) were added to the original template design after the review against extracting the document rules feature: plugin dialogs need page-level CSS such as z-index rules.
- Top-level element names without the camelCase plugin-id prefix are logged as a warning, not rejected, so existing naming does not break a plugin.
- The test subject is a new fixture plugin instead of converting the hello-world extension of `test_plugin`, so the hello-world extension remains the example without templates and the reference plugin stays minimal. It is hidden from the plugin manager with a new `hidden` metadata flag; it is still loaded and active in testing mode.

## Tests

- `tests/unit/fastapi/test_extension_templates.py`, `tests/unit/fastapi/test_plugin_admin_api.py` (hidden plugins)
- `tests/unit/js/frontend-extension-templates.test.js`
- `tests/api/v1/plugins_extensions.test.js`
- `tests/e2e/tests/frontend-extension.spec.js`

# Reference Plugin

Test fixture and reference implementation of a frontend extension that builds its UI from HTML templates. It is only available when `FASTAPI_APPLICATION_MODE=testing` and is hidden from the plugin manager (`"hidden": True` in its metadata).

## Layout

```text
reference_plugin/
├── plugin.py                      # registers extensions/reference-dialog.js
├── extensions/
│   └── reference-dialog.js        # FrontendExtensionPlugin subclass
└── templates/
    ├── dialog.html                # template "dialog" -> id "reference-plugin:dialog"
    ├── toolbar-button.html        # template "toolbar-button"
    └── reference-plugin.css       # plugin stylesheet
```

`plugin.py` does not mention `templates/`: the server finds it next to the directory of the registered extension file and inlines templates and stylesheets into `GET /api/v1/plugins/extensions.js`, ahead of the plugin's extensions.

## What It Shows

- `this.createSingleFromTemplate('dialog', document.body, { title: ... })`: a template with a `${title}` parameter, appended to a parent node, so its named elements are reachable as `getDependency('ui').referencePluginDialog`.
- `this.createSingleFromTemplate('toolbar-button')`: a template created without a parent and inserted by the extension, followed by `getDependency('ui-system').updateUi()`.
- Top-level element names start with the plugin id in camelCase (`referencePlugin...`), since all named elements share the global `ui` tree.
- The stylesheet selects by the plugin's own class names.
- Extension point `reference-plugin.show` (`app.invokePluginEndpoint('reference-plugin.show', [message])`) opens the dialog with a message.

## Tests

- `tests/unit/fastapi/test_extension_templates.py` (collector, validation)
- `tests/api/v1/plugins_extensions.test.js` (bundle)
- `tests/e2e/tests/frontend-extension.spec.js` (rendering in the app)

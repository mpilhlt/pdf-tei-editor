# LLM Review button missing: annotation-review extension skipped by the validator

## Problem

On devel, the "LLM Review" focus-mode button and the Tools menu item "Review document annotations" were gone for all document variants; only the core "LLM OCR review" button showed.

## Cause

annotation-review 1.6.1 (pte-plugins#77, #931) uses the editor's shared `FindingsDisplay` and passes its `sessionStorage` option:

```javascript
new FindingsDisplay({ source: SOURCE, sessionStorage: new SessionStorage(SOURCE), ... })
```

`validate_javascript_content()` in `fastapi_app/lib/plugins/plugin_tools.py` flags every `\bsessionStorage\b`, so `/api/v1/plugins/extensions.js` left the whole extension out. The only trace was a server log warning and a `// Skipped ...` comment in the bundle. The plugin's unit tests stub the base class and never run the validator.

## Fix

- The validator no longer counts `localStorage`, `sessionStorage` and `indexedDB` as storage access when they are keys of object literals (after `{` or `,`, before `:`). Unit tests: `tests/unit/fastapi/test_plugin_tools_validate_javascript.py`.
- A skipped extension is reported with `console.warn()` in the bundle, naming the patterns found, so that it shows in the browser console.
- pte-plugins: `tests/test_packages.py` runs the validator over every plugin's extensions, so that a plugin change that would be skipped fails the plugin tests.

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

The check was meant as a security measure, but it is none: the patterns are textual and easy to evade, an extension runs with the user's session in the editor's origin, and the plugin's Python code runs on the server. Installing a plugin is the trust decision. Leaving out a whole extension turned a convention slip into a missing feature. Christian decided (2026-11-27) to keep the check as a lint only:

- `/api/v1/plugins/extensions.js` (and the TEI Wizard enhancements bundle) serve extensions that break a convention, with a server log warning and a `console.warn()` in the bundle naming the patterns.
- The check no longer counts `localStorage`, `sessionStorage` and `indexedDB` as storage access when they are keys of object literals (after `{` or `,`, before `:`).
- pte-plugins: `tests/test_packages.py` runs the check over every plugin's extensions, so the conventions are enforced before a release.
- Template checks (no inline scripts, `on*=` attributes or `javascript:` URLs) stay rejections.
- Tests: `tests/unit/fastapi/test_plugin_tools_validate_javascript.py`. Docs: "Code Conventions" in `docs/development/frontend-extensions.md`.

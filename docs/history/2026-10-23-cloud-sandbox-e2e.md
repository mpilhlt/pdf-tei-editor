# E2E tests in the Claude Code cloud sandbox

## Problem

In the cloud sandbox, `npm run test:e2e` failed almost completely:

1. Playwright looked for `chromium_headless_shell-1248`, but the sandbox only has Chromium 1194 under `/opt/pw-browsers` and blocks browser downloads. Every test failed at launch.
2. With the sandbox Chromium, 43 tests failed because PDF.js calls `Map.prototype.getOrInsertComputed`, which that Chromium lacks ("Failed to initialize PDF.js viewer", later "Failed to load PDF: UnknownErrorException" from the worker).
3. `app-loading.spec.js` checked `ui.loginDialog` after a fixed 2 s wait; the sandbox needs longer.

## Fix

- `tests/lib/cloud-sandbox.js`: detects the sandbox (`CLAUDE_CODE_REMOTE=true` and `/opt/pw-browsers/chromium` present), provides the Chromium launch options and the upsert polyfill.
- `playwright.config.js`: chromium project uses the sandbox launch options (empty elsewhere).
- `tests/e2e/fixtures/debug-on-failure.js`: in the sandbox, adds the polyfill as an init script and prepends it to `pdf.worker.mjs` via `context.route()`, for the default context and for `browser.newContext()`.
- `app-loading.spec.js`: waits for `window.ui.loginDialog` before checking it.
- Docs: `docs/code-assistant/testing-guide.md` (troubleshooting).

No test is skipped or disabled. Outside the sandbox, only the `app-loading` wait changes behavior.

## Result

Full suite in the sandbox: 78 passed, 10 skipped (skipped before as well), 0 failed.

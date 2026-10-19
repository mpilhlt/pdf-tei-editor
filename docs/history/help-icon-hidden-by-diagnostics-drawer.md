# Help icon hidden by the diagnostics drawer

## Problem

The question-mark help icon in the bottom right corner no longer appeared.

## Cause

`app/src/templates/help-widget.html` hides the icon with `body:has(sl-drawer[open])` while any drawer is open. The diagnostics drawer added in #549 (`app/src/plugins/diagnostics-drawer.js`) is a `contained` drawer that keeps `open = true` permanently and controls its visibility through the `empty` and `retracted` classes, so the rule matched at all times.

## Fix

The rule now ignores contained drawers: `body:has(sl-drawer[open]:not([contained]))`. Contained drawers live inside a panel and do not cover the icon; page-level drawers (file selection, user manual, annotation guide, revision history) still hide it.

## Tests

`tests/e2e/tests/diagnostics-drawer.spec.js` now asserts that the help icon is visible while the diagnostics drawer lists entries.

# Copy button for inference model ids

Admins get a small clipboard button at the right of each model entry in the Tools > Default Model submenu (`app/src/plugins/inference-settings.js`). It copies `<provider id>/<model id>` (e.g. `kisski/gemma-3-27b-it`), the form that scripts such as the auto-annotation probe (`--model`) accept, and shows a toast. The labels in the menu are display names that differ from these ids.

- The button is an `sl-icon-button` in the item's `suffix` slot, next to the busy-status warning icon when there is one.
- Its click handler stops propagation, so the click never reaches the `sl-menu` and does not select the model (which, for admins, would open the "set default for all users" confirmation).
- Only built when `_isAdmin()` is true. The submenu is rebuilt when the admin status changes, since `_isAdmin()` is part of `_menuSignature`.

Tests: unit tests in `tests/unit/js/inference-settings.test.js`, E2E in `tests/e2e/tests/inference-settings.spec.js` (mocks `/api/v1/llm/providers`, checks the clipboard content and that no confirmation dialog opens, and that non-admins get no button).

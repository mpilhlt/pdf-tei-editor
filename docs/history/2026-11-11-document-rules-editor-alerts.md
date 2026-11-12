# Document rules editor alerts

Two changes to the document rules editor (`app/src/plugins/document-rules.js`), so that important states are not missed.

## Created pull request in a message dialog

After **Create pull request** in the **Propose upstream** dialog, the result ("Pull request #N created[ from your fork …]: <url>" plus the instructions for after the merge) was appended below the proposal, where it was easy to overlook. It is now shown with `dialog.info()` (the URL is linkified by the dialog plugin). The `prResult` element only shows errors. The merge instructions now name the **Propose upstream** dialog, since "this dialog" became ambiguous.

## Warning on open when the rules are behind upstream

When the editor dialog is opened (not on a layer switch, and not on the re-query after an update), `_openResourceEditor()` waits for the first upstream status and calls `_promptUpdateToUpstream(request)`. If the status is actionable (`refs_behind` or overrides now in upstream), the document is writable, the dialog is still open, no newer status was requested and no update is running, it shows a confirmation with a warning icon ("Document rules outdated"), naming what changed and what the update does. On Confirm it runs `_runUpdateToUpstream()` directly, without the button's second confirmation.

`dialog.confirm()` got an optional third parameter `variant` (`'question'` default, `'warning'` shows `exclamation-triangle`).

`_onUpdateToUpstream()` was split into `_updateToUpstreamText()` (confirmation text) and `_runUpdateToUpstream()` (button spinner + `_updateToUpstream()`), shared by the button and the warning.

## Tests

- Unit: `tests/unit/js/document-rules.test.js` (info dialog content, warning accepted/declined, the cases that stay silent, prompt only on open).
- E2E: `tests/e2e/tests/document-rules.spec.js` (info dialog after creating a pull request; the update-to-upstream test declines the warning on reopen before using the button).

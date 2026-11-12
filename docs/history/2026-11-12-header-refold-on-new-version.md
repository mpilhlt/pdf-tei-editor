# Header stays folded after creating a new version

## Problem

A reviewer who saved a new version with reviews and comments removed got the new version with the
teiHeader unfolded, while the toolbar's header toggle stayed in the folded state.

The mechanism is the one of #660 (see `header-fold-on-review-mark.md`): CodeMirror
drops a fold whose range is replaced without dispatching an unfold effect. The `tei-tools` plugin
syncs the toggle only from fold/unfold effects, so it does not notice. The exact transaction that
dropped the fold in this case could not be reproduced in the E2E setup (the "Clear reviews" flow,
auto-enabled review mode, a large document and a read-only original all kept the fold), so the fix
does not depend on the trigger.

## Fix

`app/src/plugins/tei-tools.js`: after any transaction that changes the document or reconfigures the
editor without a fold/unfold effect, while the toggle shows the header as folded, the plugin checks
the teiHeader's fold on the syntax tree (which, unlike the DOM tree, is current right after an
edit) and folds it again if the fold is gone (`TEI_HEADER_REFOLDED` test log). A deliberate unfold
via the gutter or another plugin dispatches an unfold effect, which checks the toggle first, so
it is not undone.

## Tests

`tests/e2e/tests/unit-review.spec.js` checks after "Clear reviews" that the new version opens with
the header folded and the toggle unchecked, and that replacing the whole document text folds the
header again.

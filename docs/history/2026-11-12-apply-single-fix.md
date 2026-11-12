# One-click "Apply fix" in the diagnostics drawer

Christian (2026-11-12): diagnostics with a "Propose fix" button get an "Apply fix" button that applies just that fix, without checking it and clicking the footer's Apply.

## Implementation

- `diagnostics-drawer.js`: every entry whose diagnostic has a `replacement` (the LLM Reviewer's suggestions, which carry "Propose fix") gets an "Apply fix" button after its actions. It is disabled while the editor is read-only.
- The public `applyFix(key)` switches off the merge view, waits for pending re-merges like `applyChecked()`, and applies the one fix. Both share `#applyFixes(view, diagnostics)`: the protected-text test per fix, dismissing the applied diagnostics and dispatching the changes. The checks of the other diagnostics stay as they are.
- The reviewer auto-accept of PR #736 needs no change: `unit-review` detects applied LLM fixes from the document change (`appliedFixRange()`), so a reviewer applying a fix with "Apply fix" marks the unit OK and removes the LLM Reviewer's marks, like Apply and the merge view.
- The button is only in the drawer, not in the editor's lint tooltip, whose actions come from the diagnostic sources (the LLM Reviewer in pte-plugins).

## Tests

- `tests/e2e/tests/diagnostics-drawer.spec.js`: an unchecked diagnostic is applied with "Apply fix" while the merge view is shown; a diagnostic without a fix has no such button.
- `tests/e2e/tests/unit-review.spec.js`: a reviewer applying an LLM fix with "Apply fix" marks the unit OK.

# Auto-accept applied LLM fixes

Requested 2026-11-11: when a reviewer applies a fix suggested by the LLM Reviewer, the unit should count as accepted instead of raising "Changed after a not-OK review", which the reviewer then had to confirm by hand. Only for the reviewer role (admins included, as everywhere else in unit review); annotators' fixes keep the diagnostic. Christian added that the LLM Reviewer's mark must then be removed: the reviewer agreed with it, and its not-OK mark next to the reviewer's OK would read as a dispute.

## Implementation

- `lint-utils.js` `appliedFixRange(changes, startDoc, newDoc, fix)`: whether a change applied a diagnostic's `replacement`. It widens the fix range to all changes touching it and compares the new text with the expected one, ignoring whitespace between tags. This covers the diagnostics drawer (one change per fix) and the merge view of "Propose fix" (chunks that are split up, widened to whole lines, or re-indented).
- `unit-review.js`:
  - `#trackLlmFixes()` keeps the fixes of `annotation-review` diagnostics. They are kept after the diagnostics disappear, because the drawer dismisses a diagnostic just before it applies its fix. Each local change is checked against them, and the ranges of applied fixes are kept (mapped through later changes).
  - `#acceptAppliedFixes()` runs at the end of each refresh. For reviewers it marks units OK and removes the LLM reviewers' marks from them, also from the fingerprint before the edit, from which `reconcileReviewData()` would carry them over again (`markUnits(fps, 'ok', { removeLlmMarks: true })`). It does so for units that overlap an applied range, would need a recheck (stale with a not-OK `was` mark, computed with the carry-over not yet written), and have no other LLM finding left outside the applied ranges. While the document cannot be written (merge view open), the ranges wait; closing the merge view triggers a refresh.
- Two fixes found while testing:
  - The carried-over marks were only written by the delayed refresh after an edit. Any earlier refresh (e.g. `getSummary()`, `getUnits()`) cancelled it, so the marks of the edited unit were lost until the next edit. `#carryPending` now lets whichever refresh comes first write them.
  - `#updateCarry()` lost the marks of a unit whose start was replaced (a merge view chunk replacing the whole line including the indentation). It now falls back to the only unit within the replacement of the old unit.

## Tests

- Unit: `tests/unit/js/lint-utils.test.js` (`appliedFixRange`).
- E2E: `tests/e2e/tests/unit-review.spec.js`, a reviewer applying a fix from the drawer and from the merge view, and an annotator applying one (diagnostic stays).

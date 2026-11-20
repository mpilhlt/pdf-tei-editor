# Review marks lost after an edit across units

Reported after "Transfer annotations from another version…": an accidental change in the text made the not-OK marks (with the model's comments) disappear, and undoing the change did not bring them back.

## Cause

The marks are not deleted on purpose. After an edit, `UnitReviewPlugin.#updateCarry()` maps each unit of the previous scan to a unit of the new one and records `carry` (new fingerprint → original fingerprint). `reconcileReviewData()` then writes the carried-over `was-` marks and drops the marks of units that no longer exist, except those whose fingerprint is a carry source, so that undo can restore them.

`carry` holds one original per new unit. An edit that merges two units (typing over a selection from one unit into the next) or deletes a unit while another is carried over leaves the other unit without a carry entry: its marks were dropped in a write that is not part of the undo history (`addToHistory` false), so Ctrl+Z restored the text but not the marks. After the undo, the restored first unit even received the second unit's comment as a `was-` mark.

Reproduced in an E2E test: three not-OK marks with comments, replace the text from "Alpha" into "Beta" with a character, undo: one mark lost, a wrong `was-not-ok` mark added.

## Fix

- `UnitReviewPlugin.#gone`: fingerprints of units an edit in this session changed or removed (not units created by an edit, which hold only carried-over marks). Reset when a document is loaded or replaced by another user's save.
- `reconcileReviewData(data, units, carry, keep)` keeps the marks of these fingerprints like those of carry sources.
- A unit whose fingerprint comes back (undo) is removed from `#gone` and from `carry`, so it has its own marks again instead of a `was-` mark of another unit.

Tests: `tests/e2e/tests/unit-review.spec.js` ("restores the marks of two units when an edit across both is undone", fails without the fix) and a unit test of the `keep` parameter.

Not verified with a segmentation (page unit) document; the mechanism is the same for page units.

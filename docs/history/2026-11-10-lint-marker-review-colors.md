# Lint gutter marker colors for reviewed lines

Date: 2026-11-10

## Request

A line whose unit has a combined "Not OK" review showed the LLM finding on it with the neutral purple square of CodeMirror's `info` lint marker. The marker should show the negative review in red.

## Implementation

- Unit review diagnostics are drawer-only and have no lint gutter marker of their own; the marker seen on such lines belongs to other diagnostics, usually the LLM Reviewer's findings (severity `info`).
- `app/src/modules/lint-utils.js` adds `markClassGutterLines()`: a state field providing `gutterLineClass` markers `cm-lint-line-<class>` for the `markClass` classes of all diagnostics on a line, drawer-only ones included. It is recomputed whenever the diagnostic set is replaced and mapped through document changes otherwise.
- `app/src/plugins/unit-review.js` installs it next to `drawerOnlyDiagnostics(SOURCE)`; its diagnostics already carry `cm-unit-review-not-ok`, `-disputed` or `-changed` as `markClass`.
- `app/web/app.css` replaces the `info`/`hint` lint marker on those lines with a square in the review gutter colors: red (`#d64545`) for not OK, red/green split for disputed, grey (`#8a8f98`) for changed after a not-OK review. Error and warning markers keep their own shape and color.

## Tests

- `tests/unit/js/lint-utils.test.js`: line classes from `markClass`, mapping, removal.
- `tests/e2e/tests/unit-review.spec.js`: the lint gutter element of a not-OK unit's line has the class.

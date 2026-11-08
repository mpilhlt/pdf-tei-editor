# Review diagnostics stripe colors

Date: 2026-11-05

## Request

In the diagnostics drawer, the colored stripe on the left of each entry was grey for all unit review diagnostics (they have severity `info`). The stripe should mirror what the entry represents: red for negative reviews (distinguishable from the red of validation errors), grey dotted for "changed after a not-OK review". Comments stay grey.

## Implementation

- `app/src/plugins/unit-review.js` sets `markClass` on its diagnostics: `cm-unit-review-not-ok`, `cm-unit-review-disputed` or `cm-unit-review-changed`.
- `app/src/plugins/diagnostics-drawer.js` adds a diagnostic's `markClass` classes to its list item, so that any diagnostic source can style its entries' stripe.
- `app/web/app.css` styles the stripe like the review gutter strip (`app/src/modules/codemirror/unit-review-gutter.js`): solid `#d64545` for not OK (validation errors use `#d11`), dotted grey `#8a8f98` for changed, and the red/green split for disputed.

## Tests

`tests/e2e/tests/unit-review.spec.js` checks the classes of the not-OK and changed entries.

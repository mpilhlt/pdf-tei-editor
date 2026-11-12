# Disputed reviews shown dotted red/green

Disputed units (as many OK as not-OK marks) were shown half red, half green. They now use an alternating red/green pattern, in line with the dotted grey of units changed after a review:

- Review gutter strip (`app/src/modules/codemirror/unit-review-gutter.js`, `.cm-ur-disputed`): repeating 3px red/green segments.
- Diagnostics drawer entry (`app/web/app.css`, `.diagnostics-drawer-item.cm-unit-review-disputed`): repeating 4px red/green segments on the left stripe.
- Lint gutter marker of LLM findings on a disputed unit (`app/web/app.css`): a red square outline with green dashes on a pale fill.
- User manual (`unit-review.md`, `review-workflow.md`) describes the dotted strip.

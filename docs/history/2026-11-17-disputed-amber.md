# Disputed units shown in amber (#794)

The review gutter showed disputed units as a dotted red/green strip, and the diagnostics drawer and lint marker used the same red/green mix. At normal zoom the dots blur into a brownish red that is hard to tell from *not OK*.

Following the traffic-light analogy (green OK, red not OK), disputed units now use amber (`#e0a020`), the colour the review progress meter already used for them:

- `app/src/modules/codemirror/unit-review-gutter.js`: `.cm-ur-disputed` is solid amber. The rare *uncertain* state (several units with different states on one line), which was solid amber before, is now striped amber so the two stay distinguishable.
- `app/web/app.css`: the diagnostics drawer entry *Review disputed* has a solid amber left border; the lint gutter marker of a disputed line is an amber square.
- User manual (`unit-review.md`, `review-workflow.md`) and the screenshot `review-workflow-15-dispute.png` updated. The screenshot was recoloured in place (strip, drawer border, lint marker), since it shows real review data that the demo instance does not have.

# Annotation guide table of contents

Requested 2026-10-22: a TOC navigator in the Annotation Guide drawer that lists the guide's Markdown headings, indented by level, as a drop-up from a button at the left of the drawer footer. Clicking an entry scrolls to the heading. The list shows the whole TOC and only scrolls if it would be taller than the guide container.

## Implementation

- `app/src/modules/markdown-utils.js`
  - `headingAnchor(text)`: the slug algorithm that `createMarkdownRenderer()` uses to `id`-tag headings, now shared by the renderer, `generateTOC()` and `findHeadingLineForAnchor()`.
  - `extractHeadings(md, markdown)`: returns `{ level, text, anchor, occurrence }` for each heading, using `md.parse()` rather than a line regex, so setext headings are found and `#` lines in code blocks are ignored. `text` drops inline markup; `anchor` is computed from the heading's source, like the renderer does. `occurrence` counts headings sharing an anchor (the renderer does not deduplicate ids).
- `app/src/templates/annotation-guide-drawer.html`: the footer holds an `sl-dropdown` (`placement="top-start"`, `hoist`) with a "Contents" button and an `sl-menu` on the left, and the existing buttons on the right.
- `app/src/plugins/annotation-guide.js`
  - After rendering a Markdown guide, the menu is rebuilt from `extractHeadings()`. Entries are indented by `1.25rem` per level below the topmost level present; topmost entries are bold if there are deeper levels. The trigger is hidden when there are no headings (no document, HTML-only guide, error, or a guide without headings).
  - Selecting an entry scrolls to the `occurrence`-th element with the entry's anchor id.
  - On `sl-show`, the menu is limited to the drawer body's height and width. `sl-dropdown` sizes a slotted `sl-menu` with `::slotted(sl-menu) { max-height: var(--auto-size-available-height) !important }` from its shadow root, which beats any `!important` inline style on the menu, so the plugin overrides the `--auto-size-available-height`/`-width` custom properties on the menu instead. The space above the footer trigger is always at least the body's height, so this never exceeds the viewport.

## Tests

- `tests/unit/js/markdown-utils.test.js`: `extractHeadings()` (levels, setext headings, code blocks, inline markup vs. anchor, duplicate anchors, no headings).
- `tests/e2e/tests/annotation-guide-toc.spec.js`: serves a Markdown guide for all variants by adding it to the `/api/v1/extract/list` response, then checks entries and indentation, that the menu opens above the trigger without scrolling for a short guide, that clicking an entry scrolls the guide, that a 120-heading TOC is limited to the body height and scrolls, and that the trigger is hidden for a guide without headings.

# User Manual Navigation and Links

Requested 2026-11-10: the access tokens dialog said that scripts can use a token, but not how. Embedded in a larger improvement of the user manual drawer.

## Changes

- **Manual links** (`app/src/modules/manual-links.js`): a link to a manual section is the GitHub blob URL of a Markdown file under `docs/`, e.g. `https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/user-manual/access-tokens.md#using-a-token`. The `info` plugin listens for clicks in the capture phase on `document`, finds the link in `event.composedPath()` (so links in shadow DOM work too) and opens the section in the drawer instead of GitHub. A link in an open `sl-dialog` hides the dialog, which is shown again when the drawer closes. Clicks with a modifier key are left to the browser. Blob URLs of files outside `docs/` (e.g. `README.md`) are not intercepted, since the manual only renders `docs/`.
- **TOC drop-up**: the drawer footer has the "Contents" drop-up of the annotation guide on the left. Its code moved from `annotation-guide.js` to `app/src/modules/markdown-toc.js` (`populateTocMenu`, `fitTocMenu`, `scrollToHeading`), used by both drawers.
- **Header**: the version label and an icon-only "Edit on GitHub" button (Shoelace tooltip) are in the drawer header's `header-actions` slot.
- **Heading links**: each heading gets a "Copy link" button (`addHeadingLinkButtons`) shown on hover. It copies the manual link of the section, with the tag of the running version (`v<version>`, `main` if unknown) as ref.
- **Access tokens**: the dialog intro links to "Programmatic API Access" in `docs/development/api-reference.md`, which now explains the token-to-session exchange and has Node.js and Python examples that use only the token. Both examples were run against a local server. `docs/user-manual/access-tokens.md` links there too.

## Fixes found on the way

- The manual stayed empty if the config had no `docs.from-github` key (as in the E2E test environment): `config.get()` throws for missing keys without a default.
- "Forward" re-resolved the stored (already resolved) path relative to the current page and cleared the remaining forward history.
- Links to a section of a page (`page.md#anchor`, `#anchor`) now scroll to the heading instead of loading `page.md#anchor` without scrolling or changing the location of the app.
- The login dialog was shown again when any component in the drawer (e.g. a dropdown) emitted `sl-hide`, not only the drawer itself.

## Tests

- `tests/unit/js/manual-links.test.js`
- `tests/e2e/tests/user-manual-navigation.spec.js`: clicks the dialog link, checks the drawer, the TOC, the copied heading link and that the dialog comes back.

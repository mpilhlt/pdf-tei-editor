# User manual screenshots

## Images missing in the in-app manual

The user manual pages reference their images relative to the markdown file (`../images/x.png`), which works on GitHub. The in-app manual (`app/src/plugins/info.js`) inserts the rendered HTML into the app page and only rewrote `src="images/…"` and `src="./images/…"`, which no page uses. The browser therefore resolved `../images/x.png` against the app's URL (`/images/x.png`), which the server does not serve, and every image of the manual failed to load, not only those of the bookmarks page.

Fix: `resolveRelativeSources()` in `app/src/modules/markdown-utils.js` resolves each relative `src` against the path the markdown file was loaded from: `../../docs/<page>` locally (relative to the app page, like the fetch), or the raw GitHub URL when the docs come from GitHub. The page path is escaped, since it can come from the app URL. Absolute, root-relative and `data:` URLs are kept. Unit tests in `tests/unit/js/markdown-utils.test.js`.

CodeQL reported the removal of the comment markers (`<!--`, `-->`) from the rendered HTML as incomplete sanitization once the expression was touched. The removal turned HTML comments in the markdown into visible text; the manual has no such comments (all `<!--` in the docs are in code, which markdown-it escapes), so it was removed. HTML comments in the markdown stay hidden.

## Screenshots for all pages

Christian asked for screenshots like those of the bookmarks page on the other user manual pages, with alt text and captions. Tracked in a GitHub issue with one checkbox per page. Conventions:

- Screenshots are taken from the demo container (`docker/demo-data`) with Playwright, logged in as `admin`, at a viewport of 1400×900 and device scale factor 1, cropped to the relevant part of the UI.
- Files are named `docs/images/<page>-<subject>.png`.
- Each image has an alt text describing what it shows, followed by an italic caption paragraph:

```markdown
![The context menu of the XML editor with the entry "Bookmark…" at the top](../images/bookmarks-context-menu.png)

*Adding a bookmark from the context menu of the XML editor.*
```

- Pages about the command line, deployment and configuration files get screenshots only where there is UI to show.

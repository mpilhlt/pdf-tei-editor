# User Manual Window and Full-Text Search

Issue: [#875](https://github.com/mpilhlt/pdf-tei-editor/issues/875)

## Goal

1. Show the user manual in its own browser window at a shareable URL that opens the formatted page and section outside the drawer.
2. Search the manual, including the pages that plugins contribute.

## Decisions (Christian, 2026-11-20)

1. "Copy link" on headings copies the manual window URL, not the GitHub blob URL. Links in code and docs stay GitHub blob URLs.
2. No access control for the window. Roles of plugin manual pages only keep the in-app manual free of pages that do not concern the user, so the window lists the pages of all active plugins (`all_roles=true`).
3. The manual opens in a separate window (`window.open` with a fixed name, so it is reused), not a tab.
4. Full-text search, with page titles and headings weighted higher: the client fetches every page for the index anyway, so indexing the text costs nothing extra.
5. Search in the drawer: a search button in the header that replaces the title with the search field (concept B of four mockups: field in the header, expanding button, field in the footer, sticky bar).
6. The GitHub Pages site of `docs/` stays, since it works independently of a deployment.

## Implementation

- Backend: `GET /manual/` and `/manual/{path}` serve `app/web/manual.html` (`fastapi_app/main.py`); `GET /api/v1/manual/pages` lists the core manual pages (`fastapi_app/lib/utils/manual_pages.py`: `index.md`, `about.md`, `user-manual/**`, in link order from `index.md`); `GET /api/v1/manual/contributions?all_roles=true`.
- Rendering moved from `app/src/plugins/info.js` into `ManualViewer` (`app/src/modules/manual-viewer.js`), shared by the drawer and the window.
- Window: `app/web/manual.html`, `app/web/manual.css`, entry point `app/src/manual.js`, loaded by `app/web/bootstrap.js` (`data-entry="manual"`, absolute paths and importmap) and bundled as `app/web/manual.js` (second Rollup input). Without `?dev`, the window sets the Shoelace base path to `/`, since the page is served below `/manual/`.
- URLs: `/manual/<path without .md>#<anchor>`, `/manual/plugins/<plugin id>/<file without .md>`, `?lang=` for plugin pages (`manualWindowUrl()` / `parseManualWindowUrl()` in `app/src/modules/manual-links.js`). A URL ending in `.md` is replaced by its clean form.
- Search: `app/src/modules/manual-search.js` (sections, matching, weights title 8 / heading 5 / description 3 / body 1, exact word +1, phrase in heading +5 or text +2, snippets) and `app/src/modules/manual-search-box.js` (field, results, keyboard, index loading, highlighting in the opened section).
- Drawer: search button and `Ctrl+K`, `Esc` closes the search before the drawer, "Open in new window" opens the heading nearest the top of the drawer.

## Not done

- Stemming, fuzzy matching, translations of core pages, searching the developer documentation.
- The window always reads the local `docs/`; `docs.from-github` only applies to the drawer.

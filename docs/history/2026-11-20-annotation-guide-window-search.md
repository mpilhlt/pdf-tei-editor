# Annotation Guide Window and Search

Issue: [#879](https://github.com/mpilhlt/pdf-tei-editor/issues/879), follow-up to [#875](https://github.com/mpilhlt/pdf-tei-editor/issues/875)

## Goal

Give the annotation guide drawer the pattern of the user manual: full-text search in the header (`Ctrl+K`), an "Open in new window" icon button in the header, and a standalone guide window with shareable links.

## Decisions (Christian, 2026-11-20)

1. Shareable links only for the guide files the extractors declare (`/guide/<id>`), not for any URL. A guide URL from a document's editorialDecl that is not one of them opens on its own site, as before.
2. The window shows the upstream guide only (it is public, like the manual window); reviewers see their personal version of a section in the drawer, and the window says so.
3. Separate window entry and bundle (`guide.js`), reusing the modules of the manual.

## Implementation

- Shared base `MarkdownPageViewer` (`app/src/modules/markdown-page-viewer.js`): rendering, relative image sources, link rewriting, scrolling to anchors, `sanitizeHtml()` (DOMPurify, new dependency). `ManualViewer` and `GuideViewer` (`app/src/modules/guide-viewer.js`) extend it.
- The guide is always sanitized, in the drawer too: it comes from another site, and a document's editorialDecl can point to any URL. Raw HTML used for formatting (e.g. `<sup>` in the fossil guidelines) stays.
- Relative images resolve against the raw URL of the guide (they did not load in the drawer before); relative links open the file on the forge.
- Backend: `GET /api/v1/annotation-guides` (no authentication) lists the Markdown guides of the available extractors, one entry per file (`fastapi_app/lib/utils/annotation_guides.py`), with a readable id (repository and file name), a `url_template` with `{ref}` from the forge adapter, and the sections the extractors point to. `/guide/` and `/guide/{path}` serve `app/web/guide.html`.
- URLs: `/guide/<id>?ref=<commit>#<anchor>` (`app/src/modules/guide-links.js`). Documents pin guide refs to commits, so `ref` is a commit SHA (7-40 hex digits); `findGuide()` maps a ref URL to the guide and commit with the template. `/guide/` lists the guides and their sections.
- Search: `ManualSearchBox` options `groupByPage: false` (one page, no page rows, up to 10 sections) and `subject`; index from the one guide shown, including the personal version in the drawer. `attachDrawerSearch()` connects search button, `Ctrl+K` and `Esc` for both drawers.
- Heading link buttons in the drawer copy the guide window URL (only for guides the window shows).
- `sl-badge[hidden]` and `sl-icon-button[hidden]` get `display: none` in app.css: their own `display` overrode the attribute, so the "Personal version" badge was always visible.

## Not done

- Searching several guides at once (there is one guide file today).
- Admonitions such as `> [!NOTE]` are rendered as plain blockquotes, as before.

# Manual pages contributed by plugins

Implements issue #871: installed plugins add pages, such as tutorials, to the user manual. First use case: "How to use the LLM Reviewer with GROBID" in the GROBID plugin (pte-plugins), listed only if the LLM Reviewer (`annotation-review`) is active too.

## Decisions (Christian, 2026-11-20)

- A tutorial that needs two plugins belongs to one of them, with `requires` naming the other. Christian chose the GROBID plugin as host of the first tutorial, in a `docs` folder.
- Slots list links; plugin content is not embedded in core pages.
- Administrators see the pages of plugins that are not enabled, marked as such.
- Fixed slot list in core: `tutorials`, `extraction`, `review`, `admin`.
- Declared in the manifest only; a registration function can follow.
- One page per language (`file` as a map from language code to path).

## Implementation

- `fastapi_app/lib/plugins/plugin_manifest.py`: `manual` field (`ManualPage`), validated when the manifest is read; an invalid entry marks the plugin as failed, like other manifest errors.
- `fastapi_app/lib/plugins/plugin_manual.py`: `MANUAL_SLOTS`, `list_contributions()` (roles, requires, inactive pages for admins), `resolve_manual_file()` (types, directories of the declared files, no path traversal or symlinks out).
- `fastapi_app/routers/manual.py`: `GET /api/v1/manual/contributions`, `GET /api/v1/manual/plugins/{plugin_id}/{path}` (no authentication, like `docs/`; images cannot send the session header).
- `app/src/modules/manual-slots.js` and `app/src/plugins/info.js`: slots replaced by link lists (text only), plugin pages under `plugins/<id>/<file>`, rendered with `createMarkdownRenderer({ html: false })`, a "Provided by" line, no heading link buttons and no "Edit on GitHub". Links in all manual pages are now rewritten in the DOM instead of by a regex that built `onclick` attributes from the `href`, which would have let a quote in a plugin page's link inject script.
- Slots in `index.md`, `user-manual/plugins.md`, `extraction-workflow.md`, `review-workflow.md` and `admin-guide.md`, with `hide-heading`.

## Not done

- No registration function in `plugin_api`.
- Manual links ("Copy link") for plugin pages.
- Rendering the plugin pages on the pte-plugins overview site.

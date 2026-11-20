# Manual slot `inference` and anchors in plugin manual entries

Follow-up to [2026-11-20-plugin-manual-pages.md](2026-11-20-plugin-manual-pages.md), first step of the plan in mpilhlt/pte-plugins#66 (moving the user-facing parts of plugin READMEs into manual pages).

## Decisions (Christian, 2026-11-20, in pte-plugins#66)

- A core manual page "Choosing a language model" with a slot `inference`, for the pages of the LLM provider plugins, the inference endpoints, the MPCDF endpoints and the LLM Reviewer's model settings.
- A manual entry's `file` may name a heading (`docs/page.md#heading`), so one page can be listed in two slots and open at the right section.
- No manual pages for the small plugins (local sync, edit history, etc.); their docs stay in the README.

## Implementation

- `fastapi_app/lib/plugins/plugin_manifest.py`: `_read_files()` splits `path#anchor`; `ManualPage.anchors` holds the anchor per language. Anchors must match the ids `headingAnchor()` creates (`[a-z0-9_-]+`).
- `fastapi_app/lib/plugins/plugin_manual.py`: `inference` in `MANUAL_SLOTS`, between `review` and `admin`.
- `fastapi_app/routers/manual.py` and `api-client-v1.js`: `anchors` in `ManualContributionItem`; `files` keeps plain paths, so file serving and the "Provided by" lookup are unchanged.
- `app/src/modules/manual-slots.js`: `pickManualLanguage()`, `contributionPagePath()` (path plus the anchor of the chosen language); `info.js` opens contributions with it.
- `docs/user-manual/language-models.md`: the Default Model menu, default vs. session model, which models a user sees, own API keys, and the slot. Linked from `docs/index.md`, `plugins.md` and `extraction-workflow.md`.

## Plugins

Plugins that use the slot or anchors have to raise their minimum editor version to the release with this change: an older editor lists an `inference` page nowhere (unknown slot, logged), and rejects a `file` with an anchor as an invalid manifest, which marks the plugin as failed.

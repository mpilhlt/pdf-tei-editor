# Sync prompt and undo fixes for sync diagnostics

Issue #968; general text layer drift is the follow-up #970.

## Decisions (Christian, 2026-11-28)

- After a page-scoped "Write text corrections to PDF", the GROBID feature file still has the old text of these pages. The feature file check replaces the word diagnostics of these pages by one note per page (info) instead of reporting them, until the next whole-document write updates the feature file.
- Annotators get no prompt; they undo unintended changes with the fixes or dismiss the diagnostics. The annotation guide, which says never to change the text, is updated once the feature is released.
- The cancel button is labelled "Not now". "Show changes" opens the diagnostics drawer filtered to the sync diagnostics.
- "Don't ask again" is stored client-side only (UIStorage, by doc_id).

## Implementation

- core: `pending_text_correction_pages()` in `fastapi_app/lib/ocr/provenance.py` (plugin API 1.11); `registerSyncSource()`, `syncSourceOptions()`, `syncSourceNames()` in `lint-utils.js`; `DiagnosticsDrawerPlugin#showSources()`; `app/src/plugins/sync-prompt.js` with the pure helpers in `app/src/modules/sync-prompt.js`. "Synchronize" calls `TextCorrectionsPlugin#writePages()` with the pages of the new diagnostics.
- grobid plugin (pte-plugins): `replacement` on the `Sync:` diagnostics (replaced, extra and missing tokens; only replaced first words for segmentation), `page` on segmentation diagnostics, `pending_pages` from `GET /api/plugins/grobid/feature-tokens`, tokens fetched again when the PDF changes.

## Prompt rules

The prompt considers the error and warning diagnostics of sync sources with a `page`, keyed by `diagnosticKey()` (source, severity, message, covered text). Keys present before the first user edit since loading, and keys it already asked about, do not open it. It runs two seconds after the last edit or diagnostics change.

# Segmentation documents reviewed by page

Issue #808: LLM review and auto-annotation of `grobid.training.segmentation` documents, whose `<text>` children are zones that partition one text stream. Zones are not stable review units (correcting the document moves their boundaries), so the review unit is the page, taken from the layout in GROBID's segmentation feature file. Models see numbered lines with zone labels and layout hints instead of XML and answer with label changes.

## Core

- `fastapi_app/lib/tei/zone_lines.py` (pure): reads `<text>` as lines (content up to and including `<lb/>`) and pieces (the parts of a line in different zones, label `-` outside any zone); refuses zones that contain other elements than `<lb/>`. Pages from the line layout, page fingerprints (SHA-256 of the canonical form `[label]text` per piece, first 8 hex characters, `.n` for repeated pages), page windows (`max_pages`, `max_chars` of the listing), the listing with context lines and hints, the answer forms (`0413-0420 body`, `0412 | [page]12 [note:headnote]...`), checks (outside the window, unknown label, changed text, no-op, overlap) and `apply_labels()`, which rebuilds only the affected zone elements and keeps text, `<lb/>`, comments and tag spelling byte for byte.
- `app/src/modules/zone-lines.js`: the reading and page part in JavaScript. `tests/unit/fixtures/zone-lines/` has a sample with a line shared by `<page>` and `<note place="headnote">`, character references, text outside zones and a comment; both implementations are tested against `segmentation-sample.expected.json` (regenerate with `UPDATE_FIXTURES=1`).
- `fastapi_app/lib/tei/layout.py`: layout provider registry per variant (`LineLayout`: page index and hints per line), `get_zone_labels()` from the extractors' `zoneLabels`, and `GET /api/v1/files/{stable_id}/layout` (`ok`, `missing`, `unsupported`). Plugin API 1.5.
- Unit review: unit scheme `pages` (text-range units named `page`, labelled "Page N"); a variant declaring `pages` ignores stored unit paths, so old `./*` zone marks are dropped at the next write. Without layout the meter shows a warning and a notification suggests a fresh extraction. The layout is (re)loaded when the document, its variant or the review config becomes known, since any of them may arrive after the editor loaded the document.
- The message indexer computes page excerpts through the same registry.

## Plugins (pte-plugins)

- grobid: layout provider from the cached `training.zip` feature file. Rows are mapped to lines by first token with the forward scan of `grobid-sync.js`; columns are found by value (block, page and font size status) and by offset from the font size column (`FeaturesVectorSegmentation.printVector()`), so flavors that append columns are read too. Declares `zoneLabels` and `reviewUnits = "pages"` for segmentation; falls back to `./*` on editors without the layout API.
- annotation-review: page windows (`pages:2`), JSON findings with `lines`/`label` or `line`/`pieces`, converted into the existing `{old, new, rationale}` contract by widening the changed span to zone tag boundaries until `old` is unique; touching findings are merged. Pages of a window are marked by range. Focus mode reviews the pages a zone lies on.
- auto-annotation: pages are the units of the correction routes (`pages:4` default, `pages:N`, `pages:all`); answers in the plain line form, checks per page (`text_changed`, new `bad_labels`), split by pages, then a page by lines; all changes applied in one `apply_labels()` call. Probe scoring per text character (label accuracy, stretch edits, zone boundary F1, exact pages). The A/B pipeline refuses zone documents.

## Not done

- Auto-annotation does not record unit review marks for any variant, so pages are not marked by it either.
- Documents extracted before the grobid plugin kept the feature file have no layout and cannot be reviewed by page.
- The probe has not been run on the gold segmentation documents yet; window size and output mode defaults (`pages:2` for the reviewer, `pages:4` and mode `all` for the correction) are to be tuned with it.

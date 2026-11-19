# Page breaks from the GROBID feature file

Issue: [#860](https://github.com/mpilhlt/pdf-tei-editor/issues/860)

## Goal

Segmentation documents (`grobid.training.segmentation`) mark the start of every PDF page with `<pb n="…"/>`, reconstructed from the `PAGESTART` rows of GROBID's feature file, so that page breaks are explicit and documents keep their pages without the extraction cache.

## Verified before implementing

- GROBID's `TEISegmentationSaxParser` turns `<pb>` into `+PAGE+` and removes it before tokenizing; the citation and reference segmenter parsers skip it too. Training data is unchanged.
- The feature-file sync lint and the layout alignment use the first word of each `<lb/>` line; `<pb/>` has no text.
- Page fingerprints use the text of the pieces only, so review marks survive the insertion.
- `zone_lines.py` and `zone-lines.js` refused any element in zones except `<lb/>`, which would have disabled the page layout, page units and the segmentation LLM review.

## Implementation

| Repository | Change |
| --- | --- |
| pdf-tei-editor | `zone_lines.py`: `<pb/>` is an atom without text (kind `pb`, kept byte for byte by `apply_labels()` like comments); `ZoneDocument.page_breaks`, `line_pages_from_page_breaks()`, `insert_page_breaks()` with `PAGE_BREAK_VICINITY` (3); `zone-lines.js` reads `<pb/>` the same way; fixture `segmentation-sample-pb.tei.xml`; plugin API 1.6.0 |
| fossil | `pb` (optional `@n`) in `common-elements.rng`, allowed in `<text>` and every segmentation zone; "Page breaks" section in the guidelines |
| pte-plugins (grobid) | insertion after every segmentation extraction; layout provider takes pages from `<pb/>` when present, hints from the feature file; lint for page starts without `<pb/>`, misplaced `<pb/>` and wrong `n`; TEI Wizard enhancement "Insert page breaks" (`POST /api/plugins/grobid/insert-page-breaks`) |

## Rules

- A page start gets no `<pb/>` if an existing `<pb/>` lies within 3 lines of it; each existing `<pb/>` counts for the nearest page start only. This covers GROBID emitting `<pb/>` itself and running the enhancement again.
- The `<pb/>` goes before the first character of the page's first line, inside the zone that character is in.
- Without a matching feature file (fewer than half the lines aligned), nothing is inserted.
- When a document has `<pb/>` elements, they define its pages; the feature file only provides the layout hints.
- The plugin inserts `<pb/>` only on editors with plugin API 1.6, since older editors refuse `<pb/>` in zone documents.

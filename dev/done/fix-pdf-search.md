# PDF Text Search — Current State and Next Steps

## How the System Works (after refactoring)

### Pipeline

1. **Term extraction** (`services.js:searchNodeContentsInPdf`): Extracts text from all text nodes of the selected XML node, splits on whitespace only (hyphenated compounds kept intact), deduplicates. Footnote numbers prepended if `source="fnNN"` attribute present.

2. **Page scoring** (`pdfviewer.js:_scoreAllPages`): For each page, extracts text content items via PDF.js `getTextContent()` API and scores each item using `pdfTextSearch.scoreSpan()`. Returns `{page, matchCount, totalScore}` per page.

3. **Page selection** (`pdfviewer.js:_getBestMatches`): Filters pages with `matchCount >= max(2, round(terms.length * 0.5))`, sorts by `totalScore` descending, returns top 5.

4. **Navigation** (`pdfviewer.js:scrollToBestMatch`): Calls `goToPage(pageNumber)` to navigate to the best page.

5. **Text layer highlighting** (`pdfviewer.js:_highlightTermsInTextLayer`): Queries DOM for the page's `.textLayer`, calls `pdfTextSearch.findBestCluster()` which:
   - Scores each `<span>` in the text layer against search terms (exact=10, prefix=7, containment=5, suffix=3)
   - Groups matching spans by spatial proximity using union-find
   - Returns the best cluster passing `minClusterSize` (auto-calculated: `max(2, min(terms.length, 5))`) and height constraints

6. **Visual highlight** (`pdfviewer.js:_createClusterHighlight`): Creates a `.span-highlight` div per matched span + a dashed `.cluster-highlight` boundary around the cluster.

7. **Zoom persistence** (`textlayerrendered` event): When PDF.js re-renders the text layer (zoom/navigation), clears old highlights, waits one `requestAnimationFrame`, then re-runs highlighting with stored terms/page/minClusterSize.

### Key Files

| File | Role |
|------|------|
| `app/src/plugins/services.js` | Term extraction from XML node |
| `app/src/modules/pdfviewer.js` | `search()`, `_scoreAllPages()`, `_getBestMatches()`, `_highlightTermsInTextLayer()`, `_createClusterHighlight()` |
| `app/src/modules/pdf-text-search.js` | `buildTermLookups()`, `scoreSpan()`, `calculateSpanNoise()`, `findMatchingSpans()`, `clusterSpansByProximity()`, `findBestCluster()`, `traceFootnoteFromAnchor()` |
| `app/web/pdfjs-viewer.css` | `.span-highlight`, `.cluster-highlight` styles |

## Implementation Summary

### Issues Fixed

**1. Text layer timing** — `search()` now checks if the text layer already exists
for the target page. If it does, highlights are applied directly. If not, the
`textlayerrendered` event handler applies them when the text layer becomes available.

**2. Noise filtering** — Added `calculateSpanNoise()` to measure the fraction of
words in a span that don't match any search term. Spans with high noise ratio
(>0.7 for anchor searches, >0.6 for non-anchor) are rejected in `findMatchingSpans()`.
Single-word spans that score > 0 are always kept.

**3. Term-length-adjusted scoring** — `scoreSpan()` now reduces exact-match scores
for short common words (2-3 chars → 3 points, vs 10 for 6+ chars). This limits
false positives from words like "und", "die", "in".

**4. Cross-column clustering** — `clusterSpansByProximity()` now splits clusters at
column gaps (120px center-to-center distance). `findBestCluster()` applies tighter
horizontal thresholds for non-anchor searches (25 avg char widths vs 60) and
width constraints (18× line height vs 30× for anchor searches).

**5. Term coverage ranking** — Clusters are re-sorted by unique term coverage
(fraction of distinct search terms matched) before density. This prevents
high-scoring noise clusters from outranking the actual reference.

**6. Footnote tracing** — New `traceFootnoteFromAnchor()` function for
`source="fnNN"` searches. Instead of clustering, it finds the anchor span (footnote
number followed by content) and traces forward in reading order, stopping at the
next footnote number or a line gap > 2× line height. Scores traces by
`uniqueTermsMatched * 20 + spanScoreSum`, with noise penalty only when term
coverage < 30%.

**7. Standalone anchor detection** — `_scoreAllPages()` and `traceFootnoteFromAnchor()`
now handle PDF.js rendering footnote numbers as standalone spans separated from
content by whitespace items. The page scorer looks ahead up to 5 items for
non-whitespace content starting with a letter. The tracer finds standalone anchors
and pairs them with the next non-empty span.

**8. Same-line continuation** — Footnote tracing tracks `rightmostX` to allow
same-line spans to flow right without column-alignment constraints, while new-line
spans still check column alignment with the anchor position.

### Remaining Optimization Opportunities

- **Pre-DOM clustering**: PDF.js `getTextContent()` returns items with `transform`
  arrays encoding position. These could enable page-level spatial clustering
  during `_scoreAllPages()` before the text layer DOM exists.

- **Single-term fast path**: Very short nodes producing only 1 term can't pass the
  `minMatchCount >= 2` filter. Could use PDF.js's built-in find controller as fallback.

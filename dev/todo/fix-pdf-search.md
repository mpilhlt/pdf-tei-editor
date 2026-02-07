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
| `app/src/plugins/services.js:420-441` | Term extraction from XML node |
| `app/src/modules/pdfviewer.js:578-614` | `search()` — orchestration |
| `app/src/modules/pdfviewer.js:625-648` | `_scoreAllPages()` — page scoring |
| `app/src/modules/pdfviewer.js:746-759` | `_getBestMatches()` — page ranking |
| `app/src/modules/pdfviewer.js:819-857` | `_highlightTermsInTextLayer()` — DOM highlighting |
| `app/src/modules/pdfviewer.js:864-907` | `_createClusterHighlight()` — visual overlay |
| `app/src/modules/pdf-text-search.js:54-81` | `buildTermLookups()` — term normalization |
| `app/src/modules/pdf-text-search.js:97-126` | `scoreSpan()` — span scoring |
| `app/src/modules/pdf-text-search.js:192-290` | `clusterSpansByProximity()` — spatial clustering |
| `app/src/modules/pdf-text-search.js:327-379` | `findBestCluster()` — cluster selection |
| `app/web/pdfjs-viewer.css:191-206` | `.span-highlight`, `.cluster-highlight` styles |

## Known Issue: "Text layer not found for page N"

The primary remaining bug. After `goToPage(N)` in `search()`, the code immediately queries the DOM for `.textLayer`. But PDF.js renders the text layer **asynchronously** — the page div exists but its text layer hasn't been created yet when `_highlightTermsInTextLayer` runs.

**Root cause**: `goToPage()` sets `pdfViewer.currentPageNumber` which triggers page rendering, but there's no await on text layer completion. The `textlayerrendered` event fires later, but at that point the initial `_highlightTermsInTextLayer` call has already failed and logged the warning.

**Irony**: The `textlayerrendered` handler would re-highlight correctly, but only if `_highlightTerms` and `_highlightPageNumber` are set. They ARE set (lines 827-829 run before the text layer check), so the re-highlight should fire when the text layer eventually renders. However, line 821 calls `_clearClusterHighlights()` first, and the handler at line 248 also calls it — this may create a race condition clearing state set by the handler itself.

## Next Steps for Debugging/Optimization

### 1. Fix text layer timing (critical)

The `_highlightTermsInTextLayer` call in `search()` at line 613 should wait for the text layer to actually render. Options:
- **Option A**: Listen for the `textlayerrendered` event for the target page instead of calling `_highlightTermsInTextLayer` directly from `search()`. Remove the direct call and rely entirely on the event handler.
- **Option B**: Add a utility that waits for the text layer: poll for `.textLayer` existence with a timeout, or wrap the `textlayerrendered` event in a Promise.
- **Option C**: Use `pdfViewer.getPageView(pageIndex)` to check if the text layer is ready via the PDF.js internal API.

Option A is simplest — set `_highlightTerms`/`_highlightPageNumber` from `search()`, remove the direct `_highlightTermsInTextLayer` call, and let the `textlayerrendered` handler do the work.

### 2. Add diagnostic logging

Add temporary `console.log` statements (prefixed with `DEBUG`) to:
- `_highlightTermsInTextLayer`: Log the number of spans found in the text layer, number of matching spans, and cluster details before filtering
- `_scoreAllPages`: Log per-page scores for the top 5 pages to verify page selection
- `findBestCluster`: Log cluster count, sizes, and why clusters were rejected (size vs height constraint)

### 3. Investigate `scoreSpan` false positives with many terms

With all terms passed through (no length filter), common 2-3 letter words like "in", "of", "an" will generate many prefix/containment matches. Verify that:
- These don't inflate page scores enough to select wrong pages
- These don't create noise clusters that outscore the real match
- Consider adding a minimum term length of 2 back if noise is problematic (but only in `buildTermLookups`, not in `services.js`)

### 4. Test cluster scoring with multi-column layouts

The horizontal threshold (`horizontalThresholdChars=8`, ~4.8x line height) may incorrectly merge matches from adjacent columns. If a PDF has a two-column layout with matching terms in both columns, they could form one large cluster that gets rejected by the height constraint.

### 5. Consider using `textContent.items` positions for page-level clustering

PDF.js `getTextContent()` returns items with `transform` arrays that encode position. These could be used for page-level spatial clustering (before the DOM is available), which would allow computing the best cluster during `_scoreAllPages` rather than waiting for the text layer DOM.

### 6. Handle edge case: node text that produces 0-1 search terms

Very short nodes (e.g., a single abbreviation) may produce only 1 term. `_getBestMatches` requires `minMatchCount >= 2`, so these would never match. Consider a single-term fast path that uses PDF.js's built-in find controller.

# Testing PDF Viewer Code with Node

How to test code that touches the PDF Viewer (`app/src/modules/pdfviewer.js`,
`app/src/modules/pdf-text-matcher.js`) without a browser. This pattern came
out of building the PDF text lookup feature (the Autosearch switch) and its
offline pipeline in `tests/pdf-match/`.

## The core idea: keep the algorithm DOM-free

`pdf-text-matcher.js` (the module that locates a TEI node's text inside a
PDF) never touches the DOM. It takes plain data — the array PDF.js's
`page.getTextContent()` returns — and returns plain data (page number,
bounding box, matched text). The identical module runs unmodified in the
browser and in a Node test.

This is the single most important design choice for testability here: push
DOM/browser-only concerns (finding `<span>` elements in the rendered text
layer, scrolling, drawing the highlight box) into a thin adapter
(`pdfviewer.js`'s `_mapItemsToSpans`/`_highlightMatchInTextLayer`), and keep
everything else — normalization, alignment, scoring — as pure functions over
data. Only the thin adapter needs a real browser to test; the algorithm does
not.

When adding new PDF-viewer-adjacent logic, ask: does this need the rendered
DOM (a `<span>`, a scroll position, a zoom-triggered re-render), or does it
only need the data PDF.js already extracted? If the latter, write it
DOM-free so it can be tested the way described below.

## Getting PDF data in Node

`pdfjs-dist` runs in Node via its `legacy` build:

```js
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await getDocument({ data, standardFontDataUrl }).promise;
const page = await doc.getPage(pageNumber);
const viewport = page.getViewport({ scale: 1 });
const textContent = await page.getTextContent();
```

`textContent.items` is exactly what the browser's text layer is built from
— the same data `pdf-text-matcher.js` consumes at runtime. Page rendering to
a PNG (for human review, not required for the algorithm) uses
`@napi-rs/canvas`:

```js
import { createCanvas } from '@napi-rs/canvas';
const canvas = createCanvas(viewport.width, viewport.height);
await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
```

See `tests/pdf-match/extract-fixtures.js` for the full working version.

### Gotchas

- **`@napi-rs/canvas` must be deduplicated.** `pdfjs-dist` pulls in its own
  nested copy of `@napi-rs/canvas`. If the top-level and nested copies
  diverge, rendering fails with `Value is none of these types 'String',
  'Path'` — pdf.js builds a `Path2D` from a different copy of the native
  binding than the canvas context uses. Fixed by an `overrides` entry in
  `package.json`:

  ```json
  "overrides": { "@napi-rs/canvas": "$@napi-rs/canvas" }
  ```

  If page rendering breaks after a dependency bump, check this override
  first before debugging further.

- **`standardFontDataUrl` needs a real trailing `/`, not just any path
  separator.** pdf.js validates this value with `val.endsWith("/")` and then
  passes it straight to `fs.promises.readFile()`. On Windows,
  `path.join(...)` produces backslash-separated paths — `\` fails that
  check even though `fs.readFile` itself accepts forward slashes fine on
  Windows. Normalize explicitly:

  ```js
  const standardFontDataUrl =
    `${path.join(baseDir, '../../node_modules/pdfjs-dist/standard_fonts').split(path.sep).join('/')}/`;
  ```

- **Derive a script's own directory with `fileURLToPath`, not
  `new URL(import.meta.url).pathname`.** The latter yields `/C:/Users/...`
  on Windows (leading slash before the drive letter); `path.dirname()` on
  that produces a malformed drive-relative path that Node resolves against
  the *current working directory's* drive, silently doubling `C:\` in the
  final path. Always use:

  ```js
  import { fileURLToPath } from 'node:url';
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  ```

## Building a fixture-based test pipeline

For an algorithm that needs real PDFs to validate against, extracting once
and testing against committed fixtures avoids needing PDFs (which are often
too large or not freely redistributable to commit) on every checkout or CI
run. The pattern used in `tests/pdf-match/` (see
[tests/pdf-match/README.md](../../tests/pdf-match/README.md) for the full
workflow):

1. **Fetch source PDFs on demand**, not into git. A provenance manifest
   (`sources/sources.json`) records how to obtain each one — a local path,
   a direct URL, and/or a DOI resolved via Unpaywall/Crossref as a
   fallback, checksum-verified once fetched. `fetch-sources.js` does the
   fetching; nothing else in the pipeline needs it to have run.
2. **Extract fixtures once, commit them.** `extract-fixtures.js` writes
   `fixtures/<docid>.items.json` — the per-page `getTextContent()` items
   and viewport, nothing else. Small, deterministic, and enough to run the
   algorithm and the regression suite with zero PDFs and no network on a
   fresh clone.
3. **Generate test cases from real usage**, not hand-written examples.
   `generate-cases.js` walks the project's own TEI output (e.g. every
   `<biblStruct>`) to produce one case per real query the algorithm will
   actually see in production, each as its own small JSON file (small
   per-case diffs, one file per human review decision).
4. **Run the algorithm against fixtures.** `run-cases.js` calls the same
   matcher function the browser calls, over the committed fixtures, and
   writes a static HTML report.
5. **Human review for geometric correctness.** A page/bbox result can't be
   judged correct from text alone — you have to look at the highlighted
   region on the actual page. `review-server.js` + `review-ui.html` is a
   small local (zero external dependency) app: render each proposed match
   as a crop of the page image with the bbox overlaid, and accept/reject
   with a keystroke. Accepting freezes `expected: {page, bbox}` into the
   case file as the pinned gold answer.
6. **Pin gold cases in a real regression suite** (a `node:test` file, not
   the HTML report) that runs via the same command as the rest of the unit
   suite (`npm run test:unit:js`), so future changes can't silently regress
   a previously-correct case. See
   `tests/unit/js/pdf-match-regression.test.js`.

This whole loop — extract, generate, run, review, regress — never opens a
browser. It's an order of magnitude faster to iterate on matching-algorithm
changes this way than through the running app.

### Decoupling "is this correct" from "does this clear the runtime threshold"

If the production code accepts/rejects a result via a score threshold, do
not bake that threshold into the regression suite's pass/fail. Run gold
cases with the algorithm's most permissive mode (find the best candidate
regardless of score) and assert on *correctness* (right page, region
overlap) — then separately report how many cases would also clear the
runtime threshold, as a metric, not a gate. A confirmed-correct match that
scores just under the production cutoff is a real, accepted characteristic
of the algorithm, not a test regression; conflating the two makes the gold
set unable to hold a case like that at all. See the `RUNTIME_THRESHOLD`
handling in `tests/unit/js/pdf-match-regression.test.js`.

## When you still need the browser

The Node pipeline validates the algorithm, not the DOM adapter. It does not
exercise:

- Finding the actual rendered `<span>` elements in PDF.js's text layer
  (`_mapItemsToSpans`)
- Scrolling to and drawing the highlight overlay
  (`_highlightMatchInTextLayer`)
- Re-running the highlight after a zoom change (`textlayerrendered`)

Verify these by loading a real document in the running app, enabling
Autosearch, and selecting a node — see
[Testing Guide § Isolated Component Harness Tests](../code-assistant/testing-guide.md#isolated-component-harness-tests)
for the general pattern (a standalone HTML harness served by the dev
server, no login or app state) if this ever needs repeatable cross-browser
coverage rather than a manual check.

# PDF Text Lookup — Sequence-Alignment Redesign

Date: 2026-07-19
Status: Approved

## Problem

The "autosearch" switch locates the currently selected TEI node's text in the
PDF viewer (`searchNodeContentsInPdf` in `app/src/plugins/services.js`). The
current implementation (`app/src/modules/pdf-text-search.js`) treats the node
text as a bag of words and reconstructs the location via per-span scoring,
noise ratios, union-find spatial clustering, column-gap splitting, and
footnote tracing. Despite a documented eight-fix repair round
(`docs/history/fix-pdf-search.md`), it fails in almost all real cases. The
failure is structural: word order — the strongest available signal — is
discarded, and ~15 interacting thresholds make the heuristics untunable.
Existing unit tests use synthetic JSDOM spans and cannot detect real-world
failures.

## Constraints (from design discussion)

- **Precision**: region-level. Correct page plus a highlight box that visibly
  covers the source region (a bibliography entry). Edge over/undershoot is
  acceptable (IoU ≥ 0.3 against gold regions).
- **Text fidelity**: TEI node text is near-verbatim PDF text (GROBID-style
  extraction; whitespace/hyphenation cleanup only).
- **Target nodes**: bibliography entries (`bibl`/`biblStruct`), typically 1–4
  lines of dense, distinctive text.
- **Runtime**: client-only. The matcher is a pure, DOM-free JS module so the
  identical code runs in the browser and in Node for testing.
- **Gold data**: built semi-automatically — the harness proposes matches, the
  user confirms or rejects them via an HTML review report.

## Approach

Replace bag-of-words clustering with fuzzy sequence alignment of the node
text against a reconstructed per-page text stream. The existing spatial
machinery survives only in two roles: geometric reading-order sorting on the
input side and bounding-box construction on the output side.

## 1. Matcher core — `app/src/modules/pdf-text-matcher.js`

Pure module, no DOM and no PDF.js dependency. Operates on plain
JSON-serializable data extracted from PDF.js `getTextContent()`.

### Types

- `TextItem` — `{ str, transform, width, height }` (subset of the PDF.js text
  content item).
- Query — the selected node's text as an ordered string (not a term bag).

### Pipeline

1. **`buildPageModel(items)`** — filter empty items; derive (x, y) from
   `transform`; group items into lines by y-proximity; detect columns from
   the x-gap distribution; sort lines into reading order (column-major).
   Output: one normalized text stream per page plus a char-index →
   item-index map so any character range maps back to items. Imposing our
   own reading order neutralizes the unpredictable placement order of
   fragments in the PDF content stream.
2. **`normalizeWithMap(s)`** — lowercase; Unicode NFKD with ligature folding
   (ﬁ → fi); collapse whitespace; join line-end hyphenations ("Gian-" + line
   break + "na" → "gianna"); strip soft hyphens. Implemented as a
   char-emitting transform so the index map survives normalization. The same
   normalizer runs on the query, guaranteeing symmetry.
3. **`findBestMatch(pageModels, query, options)`** —
   - *Seeding*: extract rare 4-grams from the query and find their
     occurrences in each page stream; cluster hits into candidate offsets.
     Pages without seeds are skipped cheaply.
   - *Extension*: at each candidate offset, compute banded edit-distance
     similarity between the query and a window of query length ± 15%,
     trimming window ends for the best local score.
   - *Result*: `{ page, score, charRange, itemIndices, bbox }` with
     `score = 1 − editDistance / queryLength`. Acceptance threshold is
     configurable (initial value 0.6). With `debug: true`, returns the top-k
     candidates with aligned snippets.

Page selection is not a separate heuristic: the page containing the best
alignment wins.

### Footnote anchor handling

The `source="fnXX"` attribute is an ad-hoc, non-standard convention that may
change. It must NOT appear in generic matcher or service code. A dedicated
module-level function `getSourceFootnoteId(node)` in
`app/src/plugins/services.js` encapsulates the convention: it inspects the node and
its ancestors and returns the text to prepend to the query (the printed
footnote number) or `null`. `searchNodeContentsInPdf` calls it and, when
non-null, prepends the returned text to the query string — the printed
footnote physically starts with that number, and alignment handles the rest.
No anchor-specific logic exists anywhere else.

## 2. Runtime integration

- `app/src/plugins/services.js` — `searchNodeContentsInPdf`: replace term-bag
  construction with ordered text extraction (`getNodeText(node).join(' ')`);
  prepend the result of `getSourceFootnoteId(node)` when non-null.
- `app/src/modules/pdfviewer.js` — `search()`: replace `_scoreAllPages`,
  `_getBestMatches`, and the `findBestCluster` call with: build page models
  once per document (cached); run `findBestMatch`; `goToPage`; map
  `itemIndices` to text-layer spans. PDF.js text-layer spans mirror text
  content items in order; a small adapter verifies the correspondence by
  string comparison and falls back to string search within the layer if it
  drifts. Highlight rendering (`_createClusterHighlight`, scroll-into-view,
  re-render on `textlayerrendered`) is reused as-is with the matched spans'
  rects.
- **Below-threshold result**: no navigation; a quiet
  `notify('No sufficiently similar text found in PDF', ...)`; debug log of
  top candidates.

## 3. Offline test pipeline — `tests/pdf-match/`

All algorithm iteration happens in Node against real PDFs; no browser in the
loop.

- **Fixture extraction** — `tests/pdf-match/extract-fixtures.js`, using
  `pdfjs-dist` (new devDependency, pinned to the vendored viewer's major
  version): dumps per-page `TextItem` JSON for each selected PDF to
  `tests/pdf-match/fixtures/<doc>.items.json`; renders page PNGs via
  `@napi-rs/canvas` for the review report. Run once per document.
- **Case generation** — `tests/pdf-match/generate-cases.js`: given PDF+TEI
  pairs selected from `data/` (~5–10 documents), extracts bibliography-entry
  nodes from the TEI and emits `cases/<id>.json`:
  `{ pdf, xpath, queryText, expected: null }`. Cap ~10 entries per document
  (50–100 cases total).
- **Review report (semi-automatic gold)** — `tests/pdf-match/run-cases.js`
  runs the matcher on every case and writes `report.html`: per case, the
  page image with the proposed region overlaid, a query-vs-matched-text
  diff, the score, and top-5 candidates for low-confidence cases. Then
  `node tests/pdf-match/confirm.js --accept id1,id2 --reject id3` writes
  confirmed locations into the case files as frozen gold
  (`expected: { page, bbox }`). Rejected cases stay open and form the
  failure set to debug.
- **Regression runner** — `tests/pdf-match/regression.js`, wired into the
  unit-test runner: for every gold case, assert correct page and bbox
  overlap (IoU ≥ 0.3). Prints a metrics block each run (page accuracy,
  region hit rate, mean score) so every tweak shows a measurable delta and
  cannot silently regress solved cases.
- **Pure unit tests** — `tests/unit/js/pdf-text-matcher.test.js`:
  normalization, index mapping, hyphenation joins, seeding, banded
  alignment. Small deterministic inputs, TDD-friendly.

Iteration loop: run regression → open report for failures → adjust algorithm
→ rerun (seconds; fixtures are cached JSON) → accept newly correct cases
into gold.

### Fixture policy

JSON fixtures are committed to the repository — they are the test substrate
and allow CI and future sessions to run the regression suite without the
source PDFs (which live only in machine-local `data/files`). Page PNGs are
gitignored and regenerable; they are needed only at review time.

## 4. File layout and migration

- **New**: `app/src/modules/pdf-text-matcher.js`; `tests/pdf-match/`
  (scripts, `fixtures/`, `cases/`); `tests/unit/js/pdf-text-matcher.test.js`.
- **Modified**: `app/src/modules/pdfviewer.js` (search path);
  `app/src/plugins/services.js` (query construction, `getSourceFootnoteId`).
- **Deleted once the regression suite is green**:
  `app/src/modules/pdf-text-search.js` and
  `tests/unit/js/pdf-text-search.test.js`. No parallel-operation period; the
  new path replaces the old wholesale.
- **devDependencies**: `pdfjs-dist`, `@napi-rs/canvas` (test-only).

## 5. Edge cases and known limits

- **Entry split across a page break** — v1 limitation: alignment is
  per-page, so a split entry matches the page holding the larger fragment
  (still useful). A page-boundary overlap stream is a straightforward v2 if
  this occurs in practice.
- **Duplicate or near-duplicate text** (same reference printed twice):
  highest score wins; near-ties are logged in debug output.
- **Very short entries** (under ~25 normalized characters): low seeding
  specificity; the matcher lowers confidence and the below-threshold path
  applies rather than guessing.

## Success criteria

- Regression suite: ≥ 90% page accuracy and ≥ 80% region hit rate
  (IoU ≥ 0.3) on the confirmed gold set.
- In-app behavior: selecting a bibliography entry with autosearch on scrolls
  to and highlights the correct region for gold-verified documents.
- All heuristic clustering code removed; the matcher has one primary tunable
  (acceptance threshold).

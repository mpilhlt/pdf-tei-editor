# pdf-match: PDF Text Lookup Test Pipeline

Offline test pipeline for the PDF text matcher
(`app/src/modules/pdf-text-matcher.js`). All algorithm iteration happens in
Node against real-PDF fixtures - no browser required.

Design spec: `docs/superpowers/specs/2026-07-19-pdf-text-lookup-design.md`

## Layout

| Path | Committed | Purpose |
| --- | --- | --- |
| `fixtures/<docid>.items.json` | yes | Per-page PDF.js text items + viewports |
| `cases/<id>.json` | yes | One lookup case; `expected` holds the frozen gold location |
| `pages/<docid>/page-N.png` | no | Page renders for review |
| `results.json`, `report.html` | no | Latest static run output |
| `rejected.json` | no | Diagnostics for rejected cases (matcher debugging) |
| `sources/*.tei.xml`, `sources/sources.json` | yes | TEI inputs and PDF provenance manifest |
| `sources/*.pdf` | no | Source PDFs; fetched on demand, see below |

## Workflow

Fetch the source PDFs (not committed — see `sources/README.md`). Each
document in `sources/sources.json` can come from a local path
(`sourcePath`), a direct download URL (`downloadUrl`), and/or a DOI used to
re-resolve a download URL:

    npm run pdf-match:fetch

Then extract fixtures and generate cases for every document in
`sources/sources.json` in one go:

    npm run pdf-match:prepare

Fixture extraction (and page PNG rendering — gitignored, so absent on a
fresh clone) always runs. Case generation is skipped by default for a
document whose `cases/<docid>-*.json` already exist, since regenerating
would discard recorded review state (`expected`/`rejected`). Pass
`--overwrite` to force case regeneration anyway.

(`--id <docid>` to limit to one document, `--max <n>` to change the per-doc
case cap, `--no-render` to skip page PNGs, `--overwrite` as above.)

To add a new document (PDFs/TEIs live in `data/files/`, mapping in
`data/db/metadata.db`), run the two steps individually instead:

    npm run pdf-match:extract -- --pdf <pdf-path> --id <docid> --render
    npm run pdf-match:generate -- --tei <tei-path> --pdf-id <docid> --max 10

Run the matcher over all cases (writes `results.json`, consumed by both the
review app and `confirm.js`):

    npm run pdf-match:run

### Interactive review (preferred)

    npm run pdf-match:review
    # open http://127.0.0.1:8899/

A local, zero-dependency review app (`review-server.js` + `review-ui.html`)
that replaces `report.html` for interactive use. Sidebar lists all cases with
a colour-coded review state (unreviewed / accepted / rejected) and a filter;
the main panel shows the page image with the proposed bounding box overlaid,
score, query/matched text, and top candidates.

Keyboard shortcuts:

| Key | Action |
| --- | --- |
| `a` | Accept the selected case |
| `r` | Reject the selected case (uses the note field's current text, if any) |
| `j` / `↓` | Next case |
| `k` / `↑` | Previous case |

Accepting writes `expected` (page + bbox) into the case file. Rejecting sets
`rejected: true` on the case file and appends/updates a diagnostic entry
(score, texts, bbox, candidates, note) in `rejected.json`, keyed by case id,
for later matcher debugging.

Use `--port <n>` to run on a different port (default 8899).

### Scriptable alternative

    node tests/pdf-match/confirm.js --accept id1,id2 --reject id3

Freezes verdicts from `results.json` the same way the review app does
(`confirm.js` and the server both call the same `acceptCase`/`rejectCase`/
`recordRejection` helpers in `lib.js`). Useful for batch-accepting after a
matcher fix, or scripting review from CI logs. `report.html` remains
available as a static, no-server fallback if needed.

Regression (runs automatically with `npm run test:unit:js`):

    node tests/unit-test-runner.js tests/unit/js/pdf-match-regression.test.js

The regression suite needs no PDFs at all — the committed fixtures carry the
per-page text data the matcher operates on, so it runs fine on a fresh clone
before `fetch-sources.js` has ever been run.

## Iteration loop

1. `run-cases.js` -> open `report.html`, look at failing/rejected cases.
2. Diagnose via the top-candidates table and matched-vs-query text.
3. Fix `pdf-text-matcher.js`, re-run (seconds - fixtures are cached JSON).
4. Newly correct cases: accept via `confirm.js`. The regression suite
   pins them so later changes cannot silently regress.

## Regenerating PNGs

PNGs are gitignored. To re-render for review, run `fetch-sources.js` first
(the source PDF path is recorded in each fixture's `sourcePath` field, e.g.
`tests/pdf-match/sources/gruber.pdf`), then re-run `extract-fixtures.js`
with `--render`.

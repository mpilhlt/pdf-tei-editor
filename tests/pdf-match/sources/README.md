# PDF-Match Test Sources

This directory holds the inputs used by the `tests/pdf-match/` pipeline
(`extract-fixtures.js` / `generate-cases.js` / `run-cases.js`):

- `*.tei.xml` — committed. This project's own TEI extraction output for each
  source PDF; not downloadable from anywhere else, so it must live in git.
- `sources.json` — committed. Hand-maintained provenance manifest (local path
  and/or DOI and/or direct download URL, sha256, description) for each source
  PDF.
- `*.pdf` — **not committed**. Fetched on demand from the URLs in
  `sources.json`:

      node tests/pdf-match/fetch-sources.js

  Run with no arguments to fetch every PDF missing from this directory. See
  `tests/pdf-match/README.md` for the full workflow and other flags
  (`--id`, `--force`).

## Documents

| docid | doi | description |
| --- | --- | --- |
| gruber | 10.26031/2023.001 | Gruber, "Futurities of Law. Toward the Legal Design of the Next Society" (Ancilla Iuris) — two-column parallel German/English text, footnotes split across columns, heavy hyphenation; the deliberate hard case |
| ijple | 10.19164/ijple.v6i1.1294 | "The Journey To Legal Capability: Challenges for Public Law from Public Legal Education" |
| napoli | 10.6093/2284-0184/11598 | Priscilla Bavieri, "Tra filosofia e teatro. A proposito di un libro di Rosario Diana" |
| slr | 10.30722/slr.19653 | "Act of Grace Payments and the Constitution" (Sydney Law Review) |
| zjs | 10.53300/001c.5220 | "Legal Aspects of Australia's Commercial Relationship With Taiwan" |
| limbach | 10.3249/1868-1581-1-1-limbach | Jutta Limbach, "Human Rights in Times of Terror: Is Collective Security the Enemy of Individual Freedom?" (GoJIL) |

All six are open access; the direct PDF URL is recorded per-document in
`sources.json` (DOI-based auto-resolution via Crossref/Unpaywall does not
cover every one of them, so the working URL is pinned explicitly rather than
re-resolved on every fetch).

## Adding your own document

`sources.json` entries support any mix of `sourcePath`, `downloadUrl`, `doi`
and `sha256` — only `description` is required. `fetch-sources.js` resolves
each docid in this order: existing verified file on disk -> `sourcePath` ->
`downloadUrl` -> `doi` (via Unpaywall, then Crossref).

**Local PDF you already have** (not published/downloadable, or just
convenient): add an entry with `sourcePath` pointing at the file, absolute or
relative to the repo root:

    "mydoc": {
      "sourcePath": "/Users/you/Downloads/mydoc.pdf",
      "description": "..."
    }

Running `fetch-sources.js` copies it into `tests/pdf-match/sources/mydoc.pdf`.

**Downloadable PDF**: add `downloadUrl` and/or `doi`:

    "mydoc": {
      "doi": "10.xxxx/yyyy",
      "downloadUrl": "https://example.org/mydoc.pdf",
      "description": "..."
    }

`sha256` is optional in both cases but recommended once the file is settled —
`fetch-sources.js` prints the computed hash after a successful fetch
(`hint: add "sha256": "..." to sources.json ...`); paste it into the manifest
to enable integrity checking on future runs.

## Checksum verification

`sources.json` records a sha256 for each of the six curated PDFs.
`fetch-sources.js` verifies every fetch (and every already-present file)
against it when present; entries without a `sha256` are reported as
`ok (no checksum recorded)` instead. This guards against the publisher
silently replacing the file at a `downloadUrl` — a changed PDF would shift
page layout and invalidate the committed gold cases in `fixtures/` and
`cases/` without anyone noticing.

If you see `CHECKSUM MISMATCH`:

1. Do not use the downloaded file — the script does not write it to disk on
   mismatch.
2. Check whether the publisher genuinely republished the article (compare the
   PDF manually via the URL, or check the DOI landing page).
3. If the file legitimately changed, the fixtures and cases built from the
   old version are now stale and need to be regenerated (see the main
   `tests/pdf-match/README.md` workflow) and `sources.json`'s `sha256`
   updated to match.
4. If it looks like a transient/wrong download (redirect to a paywall page,
   truncated response, etc.), retry, or use the `doi` field to find a fresh
   working URL by hand and update `sources.json`.

## Notes

- For `limbach` and `napoli` the TEI `<title level="a">` element is empty (no
  metadata was extracted); the description above was read from the first page
  of the PDF instead.
- `gruber` is a deliberately hard case: a two-column parallel German/English
  translation with footnotes at the page bottom also split into two columns
  sharing the same footnote numbers, plus heavy line-break hyphenation. It
  stresses the matcher's column detection and dehyphenation.
- Running the regression suite (`npm run test:unit:js`) needs none of the
  PDFs — the committed fixtures already carry the text data the matcher
  operates on. The PDFs are only needed to regenerate fixtures/cases or to
  re-render review-app page images (`extract-fixtures.js --render`).

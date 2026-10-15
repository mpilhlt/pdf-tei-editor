# Metadata Extraction Plugin

Retrieves bibliographic metadata for documents and adds it to their TEI headers.

- **TEI wizard enhancement** "Enrich TEI Header from PDF Metadata" ([enrich-tei-header.js](enhancements/enrich-tei-header.js)): fills missing `teiHeader` fields of the open document, using `GET /api/plugins/metadata-extraction/extract` (DOI lookup, LLM extraction as fallback).
- **Collection backfill** (admin only): fills missing metadata for all documents of a collection, see below.

The plugin's `required_roles` is `["admin"]`, which only restricts the menu entry: the enhancement and the `/extract` route remain available to all logged-in users.

## Collection backfill

Admins start it from the plugin menu with **Backfill Missing Metadata** (in the "Collection" section). It opens a dialog for the currently selected collection with the options below (dry run and report download are preselected) and shows the report as a table. The dialog page is [static/backfill.html](static/backfill.html), served by `GET /api/plugins/metadata-extraction/backfill/options?collection=<id>`.

```text
POST /api/plugins/metadata-extraction/backfill?collection=<collection-id>
```

| Parameter | Default | Description |
| --- | --- | --- |
| `collection` | (required) | ID of the collection whose documents are processed |
| `dry_run` | `false` | Report what would be added without saving anything |
| `use_grobid` | `true` | Use GROBID header extraction as fallback (if available) |
| `limit` | none | Maximum number of documents to process |

The session is passed as `X-Session-ID` header or `session_id` query parameter. Non-admin users get `403`, unknown collections `404`.

### What is written

Only data points that **do not exist yet** are added; existing values are never overwritten or removed.

| Data point | Written to | Counts as existing if present in |
| --- | --- | --- |
| title | `sourceDesc/biblStruct/analytic/title[@level="a"]` | `biblStruct/analytic/title`, `titleStmt/title[@level="a"]` |
| authors | `biblStruct/analytic/author` | `biblStruct/analytic/author`, `biblStruct/monogr/author` |
| journal | `biblStruct/monogr/title[@level="j"]` | same |
| ISSN, ISBN | `biblStruct/monogr/idno[@type]` | any `sourceDesc//idno` of that type |
| volume, issue, pages | `biblStruct/monogr/imprint/biblScope[@unit]` | same |
| date | `biblStruct/monogr/imprint/date` | same, `publicationStmt/date[@type="publication"]` |
| publisher | `biblStruct/monogr/imprint/publisher` | same, `publicationStmt/publisher` |
| DOI | `biblStruct/idno[@type="DOI"]` | any `idno[@type="DOI"]` in the `teiHeader` |
| URL | `biblStruct/ptr/@target` | same, `publicationStmt/ptr` |
| language | `profileDesc/langUsage/language/@ident` | a declaration other than `und` |

The "counts as existing" locations include the legacy places read by `extract_tei_metadata()`, so values are not duplicated. Missing structure (`sourceDesc`, `biblStruct`, `analytic`, `monogr`, `imprint`, `profileDesc`) is created. The rest of the document keeps its formatting.

All TEI files of a document (gold standard, versions, variants) are processed. Files locked by another session are skipped and reported. Missing keys of the PDF's `doc_metadata` (title, authors, date, journal, volume, issue, pages, publisher, DOI, URL) are filled from the retrieved metadata as well.

### Strategies

Per document:

1. **CrossRef/DataCite** if a DOI is known: from any TEI header, the PDF's `doc_metadata`, or a DOI-encoded `doc_id`.
2. **GROBID** header extraction (`/api/processHeaderDocument`, without consolidation) if no DOI is known or the lookup returned nothing. Requires the `grobid` plugin to be active and its server to be ready (checked once per request, including the Hugging Face Space state). If GROBID finds a DOI, it is looked up in CrossRef/DataCite and GROBID's values only fill the remaining gaps.
3. **Language**: `predict_document_language_with_source()` from [language_detection.py](../../lib/services/language_detection.py), the prediction path used for new extractions: detection from the PDF text layer, then from the TEI text; only if the text is too short for detection, the registry language, then `TEI/@xml:lang` or `text/@xml:lang`. Detection comes first because GROBID declares `text/@xml:lang="en"` regardless of the document language. If nothing can be determined and the document has no declaration, `und` is declared. The report gives the source of each added language (`pdf-text`, `tei-text`, `registry`, `xml-lang`, `undetermined`).

Metadata is only retrieved if a TEI file misses a bibliographic data point or the PDF has no title, authors or date. Documents that only lack a language need no network access. Since registries often do not provide every field (e.g. no issue for a book chapter), such documents are looked up again on every run.

### Response

```json
{
  "collection": "my-collection",
  "dry_run": false,
  "grobid_available": true,
  "summary": {
    "documents": 120,
    "documents_updated": 37,
    "tei_files_updated": 52,
    "tei_files_locked": 1,
    "pdfs_updated": 30,
    "errors": 2
  },
  "sources": { "crossref": 28, "grobid": 9, "language-detection": 41 },
  "documents": [
    {
      "doc_id": "10.1234__example",
      "pdf_stable_id": "abc123",
      "doi": "10.1234/example",
      "sources": ["crossref"],
      "files": [
        {
          "stable_id": "def456",
          "filled": { "journal": "Journal of Examples", "pages": "1-20", "language": "de" },
          "language_source": "pdf-text",
          "locked": false,
          "error": null
        }
      ],
      "pdf_filled": { "journal": "Journal of Examples", "pages": "1-20" },
      "errors": []
    }
  ]
}
```

`documents` only lists documents with changes, locked files or errors. `filled` and `pdf_filled` map each added data point to its value; in a dry run, they list what would be added. With **Download report** checked (default), the dialog saves this response as `metadata-backfill-<collection>-<dry-run|applied>-<timestamp>.json` when the run is finished. A progress bar is shown via SSE while the request runs; for large collections, use `limit` or a dry run first, as the request runs until all documents are processed.

Example with the development helper:

```bash
node scripts/dev/debug-api.js POST "/api/plugins/metadata-extraction/backfill?collection=my-collection&dry_run=true"
```

## Tests

The tests in [tests/backfill_tests.py](tests/backfill_tests.py) are not part of the general test suites (the file name deliberately does not match `test_*.py`). Run them during development with:

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/metadata_extraction/tests/backfill_tests.py
```

They mock CrossRef, GROBID and the locks database; no server or network access is needed.

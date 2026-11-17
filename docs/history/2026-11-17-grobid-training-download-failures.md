# GROBID training download: documents GROBID cannot process (#504)

## Problem

When GROBID's `/api/createTraining` returned HTTP 500 for a PDF (an internal GROBID error such as `tokens got dissynchronized with tokenizations`), the training data download of the GROBID plugin:

- retried the request five times with exponential backoff (about a minute per document), although the error repeats for the same PDF;
- skipped the document and logged a warning, but told the user only "N skipped" in the success toast;
- answered with a 404 when no document succeeded, which the editor showed as `Download failed:` followed by an empty status text (HTTP/2 has no reason phrase), so the user saw no reason.

## Changes

GROBID plugin (mpilhlt/pte-plugins#54):

- `handlers/training.py`: `_fetch_training_package` retries only 429, 502, 503 and 504. An HTTP 500 fails at once with the reason "GROBID could not process this PDF (HTTP 500)".
- `routes.py`: the download records each document GROBID failed on. With at least one processed document, the ZIP gets a top-level `skipped-documents.txt` (document id and reason per line) and a warning toast names the skipped documents. With none processed, the route returns HTTP 502 with a `detail` naming them; the 404 for collections without gold training data stays.
- Tests: `tests/test_training_download_failures.py`.

Editor (this repository):

- `app/src/plugins/backend-plugins.js`: a failed plugin download or export shows the response's `detail` message, falling back to `HTTP <status>`.
- Tests: `tests/unit/js/backend-plugins-download-error.test.js`.

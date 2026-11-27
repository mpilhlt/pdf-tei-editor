# Cancel button for "Write text corrections to PDF"

The progress widgets of "Write text corrections to PDF" (whole document and per-node write-back) had no cancel button, although reading and comparing the text layer of a long PDF and the GROBID update take minutes.

## Backend

- `fastapi_app/lib/ocr/cancel_requests.py`: `CancelRequests` stores cancel requests as marker files in `tmp_dir/text-corrections-cancel`, keyed by a hash of session id and progress widget id, so a request handled by one uvicorn worker can be cancelled through another (production runs 4 workers).
- `POST /api/v1/ocr/text-corrections/cancel/{progress_id}` (reviewer or admin) records the request for the caller's session; it answers `{"requested": true}`.
- `_CorrectionProgress` is a context manager that clears a stale request when the preview/apply route starts and when it ends. `step()` and the page callbacks of reading and comparing the text layer raise `_CorrectionsCancelled`; the routes answer it with 409 `{"code": "cancelled", "message": ...}`.
- Points of no return: page write: the step "Saving the document" before the corrected PDF is stored. Whole document: the step "Saving the new version of the document", reported after the corrected-PDF handler returned and before the PDF record and the version are created. The handler (GROBID) cannot be interrupted; a cancel during it takes effect when it returns, and the PDF blob stored only for the handler is deleted again.

## Frontend

- `text-corrections.js`: preview and write widgets are cancellable; `onCancel` calls `apiClient.ocrTextCorrectionsCancel()`. A 409 with code `cancelled` (or a preview that finished after the click) shows "Writing the text corrections was cancelled. The PDF and the document are unchanged." A write that finished anyway is loaded as usual, with a note that it was too late to cancel.

## Tests

- `tests/unit/fastapi/test_ocr_text_corrections.py`: cancel during preview, page write and the handler; stale and foreign-session requests; role check.
- `tests/e2e/tests/ocr-text-corrections.spec.js`: the widget's cancel button sends the cancel request, the dialog closes and the document stays open.

# OCR corrections in the revision history

Corrections of the OCR text in a TEI document are recorded in `teiHeader/revisionDesc`, and the version created by writing text corrections to the PDF gets a label of its own instead of the label of its source (usually "Extraction").

## Write text corrections to PDF

`POST /api/v1/ocr/text-corrections/apply` (`fastapi_app/routers/ocr.py`, `_prepare_version_xml()`) adds a change to the TEI returned by the corrected-PDF handler before the new version is created:

- `who` = the user, `status` = the status of the last change of the source (`draft` if none), the user's full name in a `respStmt` if the document has a `fileDesc`
- `note[@type="label"]` = `Corrected text layer` (`TEXT_CORRECTIONS_LABEL`), which becomes the version label
- `desc` = "Wrote N text corrections into the text layer of a new PDF and attached this version to it"

The handlers (GROBID plugin) do not need to change: the change is added in core for every handler.

## Find OCR errors (LLM)

Accepted suggestions change the open version, so they add a change without a label (`app/src/plugins/ocr-review.js`, `recordOcrCorrections()` in `tei-utils.js`):

- through the merge view ("Propose fix"): the plugin remembers the document text when it opens the merge view; if the text differs when the merge view is closed (not replaced), the fix was accepted
- through "Apply fix" or "Apply" in the diagnostics drawer: new `lint-utils.js` `addFixListener()`, notified by the drawer before it dispatches the fixes
- the findings carry the label of the model (`Finding.model`), which the change's `desc` names: "Accepted N OCR corrections suggested by <model>"
- while the change is the last change of the document, later accepted corrections update its count instead of adding changes (per document, per page session)

## Extraction after text recognition

An extraction from a PDF whose text layer was made by text recognition (the PDF's file metadata has an `ocr` record) gets " after OCR" appended to the label of its extraction change, e.g. "Extraction after OCR", and a sentence appended to its `desc`: engine, languages and date, plus the models and the number of LLM corrections recorded in `text_corrections` after the OCR run (`fastapi_app/lib/ocr/provenance.py`, `amend_last_revision_change()` in `tei_utils.py`, `_note_text_layer_provenance()` in `routers/extraction.py`). The extractor's change is amended instead of adding a change, since the text recognition belongs to the extraction and a second change would make the version count as edited (pte-plugins auto-annotation `is_extraction()`). This applies to every extractor and also to later extractions from the same PDF.

## Not covered

- "Correct OCR errors in PDF without review (LLM)" and text recognition on their own change only the PDF; they are recorded in the PDF's file metadata (`ocr`, `text_corrections`), not in a TEI version (Christian: PDF changes belong in the PDF metadata).
- LLM fixes of the annotation review (pte-plugins annotation-review) are not recorded in the revision history either.

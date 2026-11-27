# Unit-by-unit OCR correction (#954)

## Goal

Make the LLM-supported correction of OCR errors iterative: review a unit (a page of a segmentation document), accept the fixes, write them into the PDF, continue with the next unit.

## Changes

- Focus action "OCR auto-corrections" starts without confirmation. Only the whole-document review (Tools > OCR > Find OCR errors (LLM)) asks.
- After a node review with findings, `ocr-review.js` remembers the node (stable_id, xpath) with its pages (from the new `pages` of `POST /api/v1/ocr/llm-review/plan`) and shows the focus action "Write text corrections to PDF" for it. It calls `TextCorrectionsPlugin#writePages(pages)`; afterwards, or if there is nothing to write, the node gets "OCR auto-corrections" again.
- `TextCorrectionsRequest.pages`: preview and apply read and compare only these pages. A page-scoped apply
  - creates the corrected PDF as before (PDFs never change, #944),
  - does not create a version (Christian, 2026-11-27: "do not save each in a new version, just document changes"): the given version is attached to the corrected PDF (`FileUpdate.pdf_stable_id`) and gets an unlabelled `revisionDesc/change` "Wrote N text corrections on page(s) … into the text layer of a new PDF and attached this version to it",
  - does not call the corrected-PDF handler (GROBID refetches the feature file of the whole PDF, the slowest step). The PDF record gets `pages`, which marks the document as not updated for its PDF.
- A whole-document apply after page-scoped writes calls the handler even without remaining corrections (`update_pending` in the preview) and creates the "Corrected text layer" version on the same PDF.
- Frontend: the editor is updated with `applyRemoteContent()` (keeps position and folds), the viewer with the new `services.showPdf()` (keeps the page).
- User manual: new page `docs/user-manual/llm-editing-workflow.md`.

## Open point

Whether page-scoped writes should skip the GROBID feature-file refresh was put to Christian as a decision; the implementation skips it and refreshes on the next whole-document write.

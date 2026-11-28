# PDF information dialog

Request (Christian, 2026-11-28): an "Info" button in the PDF viewer toolbar that shows all metadata of the PDF in a modal, in particular what the OCR plugin adds.

## Where the OCR information lives

Text recognition (`POST /api/v1/ocr`) and the text-layer corrections (LLM correction, "Write text corrections to PDF") do not write their records into the PDF file. They store them in the editor's file record of the PDF (`file_metadata`):

- `ocr`: engine, languages, method, models, fallback reason, applied_at, applied_by (`fastapi_app/routers/ocr.py`)
- `text_corrections`: list of runs, LLM runs with `source`, `provider_id`, `model_id`; TEI write-backs with `tei_stable_id` and, for page-scoped writes, `pages`; each with its `corrections`

OCRmyPDF itself writes its tool name into the PDF's Info `/Creator` and XMP `xmp:CreatorTool`.

## Implementation

Frontend only, no new endpoint:

- `app/src/modules/pdf-info.js`: `buildPdfInfoSections()` (pure) combines PDF.js `PDFDocumentProxy.getMetadata()` (Info dictionary, parsed XMP, raw XMP) with the file record from `GET /api/v1/files/{stable_id}/metadata`; `renderPdfInfoSections()` renders the sections.
- Sections: "Text recognition (OCR)" and "Text corrections in the text layer" (highlighted, shown only when present), "Document information", "XMP metadata" (with raw packet), "Stored file" (remaining `file_metadata` keys listed generically). Info/XMP values naming an OCR tool (ocrmypdf, Tesseract, hOCR) are highlighted.
- `app/src/templates/pdf-info-dialog.html`, button `infoBtn` (`info-circle`) in `PdfViewerPlugin`, left of the download button.
- Unit tests: `tests/unit/js/pdf-info.test.js`.
- Manual: "PDF information" in `docs/user-manual/interface-overview.md`, link from the OCR section of `extraction-workflow.md`.

The screenshots were taken from a local instance with the demo PDF, whose `file_metadata` was given `ocr`/`text_corrections` records and whose Info/XMP creator was set to the values OCRmyPDF writes (no Tesseract in the cloud session).

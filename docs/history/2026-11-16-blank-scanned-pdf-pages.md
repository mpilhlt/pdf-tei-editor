# Blank scanned PDF pages in the PDF viewer

## Problem

Some PDFs showed blank pages in the PDF viewer while their text layer could still be selected. Example: a journal article whose pages 3 to 12 are 300 dpi scans (one 1-bit CCITT G4 image per page) with an invisible OCR text layer.

## Cause

PDF.js 6 (pdfjs-dist 6.5.438) decodes CCITT and JBIG2 images with `wasm/jbig2.wasm` and converts ICC colours with `wasm/qcms_bg.wasm`. It loads these from the `wasmUrl` parameter of `getDocument()`. The viewer called `getDocument({ url })` without it, so the worker logged `Unable to decode image "img_p3_1": "Jbig2Error: JBig2 failed to initialize"` and skipped the image. The pages rendered without their only image.

## Fix

- `app/src/modules/pdfviewer.js` passes `wasmUrl`, `iccUrl`, `cMapUrl` and `standardFontDataUrl`, all relative to the pdfjs-dist base (`/node_modules/pdfjs-dist/` in development, `/pdfjs/` in production).
- `scripts/build/copy-pdfjs.js` copies `wasm`, `iccs`, `cmaps` and `standard_fonts` into `app/web/pdfjs/` for the production build.

## Verification

Rendering all pages of the example with the app's pdf.js in Chromium: without the URLs, pages 3 to 12 have no dark pixels; with them, all pages render and the worker fetches `jbig2.wasm`, `qcms_bg.wasm` and the ICC profile.

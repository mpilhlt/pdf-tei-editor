# Autosearch no-match message in the PDF viewer statusbar

When Autosearch finds no sufficiently similar text for the selected node (and no `pdfSearch.fallback` handler supplies a page), the message "No sufficiently similar text found in the PDF" is no longer shown as a toast. It appears in the PDF viewer statusbar next to the Autosearch switch and is removed after 5 seconds.

- `PdfViewerPlugin.showStatusMessage(text, {variant, timeout})` (`app/src/plugins/pdfviewer.js`) adds a `status-text` widget (name `statusMessage`, priority 9, right of the switch at priority 10) and removes it after `timeout` ms (default 5000). A new message replaces the current one and restarts the timer. The method is also exposed through `getApi()`.
- `searchNodeContentsInPdf()` in `app/src/plugins/services.js` calls it instead of `notify()`.
- Follow-up (2026-11-19): `PdfViewerPlugin.clearStatusMessage()` removes the message early; `searchNodeContentsInPdf()` calls it when a search finds a match or a `pdfSearch.fallback` handler returns a page.

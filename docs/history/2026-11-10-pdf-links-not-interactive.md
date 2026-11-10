# PDF links no longer interactive

The pdf.js annotation layer (links, including plain-text URLs that pdf.js auto-links) showed through the diagnostics drawer that overlays the PDF viewer: hovering highlighted the link areas in yellow over the drawer, and clicking them opened the links.

Links in the PDF do not need to be clickable, so the layer was removed instead of fighting the stacking order:

- `app/src/modules/pdfviewer.js`: `annotationMode: 1` (annotation appearances are still drawn on the canvas, but no interactive form fields) and `enableAutoLinking: false`. The `title` stripping workaround for link tooltips and `externalLinkTarget` are gone, since there are no links left.
- `app/web/pdfjs-viewer.css`: `.pdfViewer .annotationLayer { display: none; }`, since pdf.js still builds the layer for any mode other than `0`. Mode `0` would also drop annotation appearances (e.g. highlights or stamps in the PDF) from the canvas.

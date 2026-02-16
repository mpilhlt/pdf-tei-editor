# Fix: Allow Copy from PDF Viewer

## Problem

Text selected in the PDF viewer cannot be copied via Ctrl+C or Edit > Copy.

## Investigation Results

### PDF.js Version

pdfjs-dist 5.4.449 (PDF.js v5)

### Key Files

- `app/src/modules/pdfviewer.js` - PDFJSViewer class (PDFViewer component wrapper)
- `app/src/plugins/pdfviewer.js` - PDF viewer plugin (toolbar, events, state)
- `app/web/pdfjs-viewer.css` - Custom CSS overrides
- `app/web/pdfjs/web/pdf_viewer.css` - PDF.js base CSS
- `app/web/pdfjs/web/pdf_viewer.mjs` - PDF.js viewer components

### Root Cause Analysis

#### Finding 1: `textLayerMode` value meaning changed in PDF.js v5

The `TextLayerMode` enum in PDF.js v5 (`pdf_viewer.mjs:142-146`):

```javascript
const TextLayerMode = {
  DISABLE: 0,
  ENABLE: 1,
  ENABLE_PERMISSIONS: 2
};
```

The PDFViewer was initialized with `textLayerMode: 2`, which was incorrectly commented as "enabled+enhanced". In PDF.js v5, mode 2 = `ENABLE_PERMISSIONS`, which respects PDF copy-restriction flags.

**Changed to `textLayerMode: 1`** but this alone did not fix the issue.

#### Finding 2: Copy event handler in TextLayerBuilder

In `pdf_viewer.mjs:6015-6021`, the text layer has a `copy` event handler:

```javascript
div.addEventListener("copy", event => {
  if (!this.#enablePermissions) {
    const selection = document.getSelection();
    event.clipboardData.setData("text/plain",
      removeNullCharacters(normalizeUnicode(selection.toString())));
  }
  stopEvent(event); // Always called - prevents native browser copy
});
```

- `stopEvent(event)` is **always** called, which prevents the browser's default copy behavior.
- When `enablePermissions` is `false` (textLayerMode=1), it manually writes to the clipboard before stopping. This should work.
- When `enablePermissions` is `true` (textLayerMode=2), it skips the clipboard write but still blocks native copy.

With `textLayerMode: 1`, this handler should properly copy text. If it still doesn't work, the issue is elsewhere.

#### Finding 3: Annotation editor layer overlay

In PDF.js v5, each page gets an `.annotationEditorLayer` (position: absolute, inset: 0). The default `annotationEditorMode` is `AnnotationEditorType.NONE` (0), not `DISABLE` (-1).

CSS rules:
- `.annotationEditorLayer` has no explicit `pointer-events` (defaults to `auto`)
- `.annotationEditorLayer.disabled` has `pointer-events: none`

If the annotation editor layer is present but does NOT have the `.disabled` class, it sits on top of the text layer and intercepts mouse events, preventing text selection entirely.

The `AnnotationEditorType` constants (`pdf.mjs:75-85`):
```javascript
const AnnotationEditorType = {
  DISABLE: -1,  // Fully disables annotation editor
  NONE: 0,      // Created but inactive
  FREETEXT: 3,
  HIGHLIGHT: 9,
  STAMP: 13,
  INK: 15,
  POPUP: 16,
  SIGNATURE: 101,
  COMMENT: 102
};
```

#### Finding 4: CSS text selection rules

Custom CSS (`pdfjs-viewer.css`) properly sets:
- `.pdfViewerContainer.text-select-mode` has `user-select: text`
- `.pdfViewerContainer.text-select-mode .textLayer` has `pointer-events: auto`
- `.pdfViewerContainer.hand-tool-mode .textLayer` has `pointer-events: none`

PDF.js base CSS:
- `.textLayer :is(span,br)` has `cursor: text` (correct)
- `.textLayer ::selection` has highlight styling (correct)
- No `user-select: none` on `.textLayer` itself

#### Finding 5: No interfering event handlers

- No `copy` event listeners in application code
- The `keydown` handler on the PDF viewer container only intercepts Ctrl+S
- No `selectstart` event listeners
- Mouse `preventDefault()` calls are only in hand-tool mode handlers

### Possible Remaining Causes

1. **Annotation editor layer blocking selection**: Even though `annotationEditorMode` defaults to `NONE`, the layer might not have the `.disabled` class, blocking mouse events from reaching the text layer. Fix: set `annotationEditorMode: -1` (DISABLE) or add CSS `pointer-events: none` on `.annotationEditorLayer`.

2. **`stopEvent()` in copy handler**: If `stopEvent()` calls `event.preventDefault()` before `clipboardData.setData()` takes effect, the clipboard write may fail in some browsers. This is inside PDF.js internals and can't be easily patched.

3. **Focus issue**: The text layer div might not receive focus properly within the split-panel layout, causing the copy event to not fire on the correct element.

4. **`content-box` reset interference**: The global reset `.pdfViewerContainer, .pdfViewerContainer * { box-sizing: content-box; }` shouldn't affect selection but could potentially affect text layer span positioning.

### Suggested Next Steps

1. **Inspect live DOM**: Use browser DevTools to check:
   - Whether `.annotationEditorLayer` exists on rendered pages and whether it has `.disabled` class
   - Whether text can be selected at all (blue highlight appears on drag)
   - Whether the `copy` event fires on the text layer div (add breakpoint in `pdf_viewer.mjs:6015`)
   - Check `document.getSelection().toString()` after selecting text in the PDF

2. **Try disabling annotation editor entirely**: In `pdfviewer.js` constructor, add `annotationEditorMode: -1`:
   ```javascript
   this.pdfViewer = new pdfjsViewer.PDFViewer({
     container: this.pdfViewerContainer,
     viewer: this.viewer,
     eventBus: this.eventBus,
     linkService: this.linkService,
     findController: this.findController,
     textLayerMode: 1,
     annotationMode: 2,
     annotationEditorMode: -1, // AnnotationEditorType.DISABLE
     removePageBorders: false
   });
   ```

3. **CSS fallback - force annotation editor layer to pass through events**:
   ```css
   .annotationEditorLayer {
     pointer-events: none !important;
   }
   ```

4. **If text IS selectable but copy fails**: The issue is in PDF.js's `copy` event handler. Workaround: add a `keydown` listener for Ctrl+C that manually reads the selection and writes to clipboard:
   ```javascript
   pdfViewerContainer.addEventListener('keydown', (evt) => {
     if ((evt.ctrlKey || evt.metaKey) && evt.key === 'c') {
       const selection = document.getSelection();
       const text = selection?.toString();
       if (text) {
         navigator.clipboard.writeText(text);
       }
     }
   });
   ```

5. **Check the specific PDF**: Some PDFs have copy protection flags. Test with a known-good PDF that allows copying (e.g., one generated without restrictions).

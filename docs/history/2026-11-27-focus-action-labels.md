# Focus-mode button labels

Christian found "LLM Review" unclear (2026-11-27). The focus-mode buttons are now:

- "Annotation auto-review" (annotation-review plugin, pte-plugins), formerly "LLM Review"
- "OCR auto-corrections" (`app/src/plugins/ocr-review.js`), formerly "LLM OCR review"

User manual and code-assistant docs use the new labels. The GROBID tutorial's `images/focus-page.png` (pte-plugins) was retaken with the demo document. The demo data has no `grobid.training.references` document, so in `docs/images/review-workflow-03b-focus-mode.png` only the button was replaced with one rendered by the current editor.

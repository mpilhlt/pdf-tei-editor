# Document Editing

The right panel of the PDF-TEI Editor contains a CodeMirror-based XML editor. This page describes the editor UI and the main editing workflows.

## Editor Layout

The XML editor panel has three chrome areas around the editing surface:

**Headerbar** (top strip)
Shows the artifact type prefix (**Gold:** or **Version:**), the artifact label, and the last revision date and author. Clicking the label copies it to the clipboard; double-clicking opens an inline rename prompt. When the editor has unsaved changes that cannot be auto-saved (e.g. because the XML is malformed), a warning badge appears here. When the document is read-only, a lock icon appears.

**Toolbar** (below the headerbar)
Contains action buttons grouped by function. What buttons are visible depends on the document state and your role (see [Toolbar buttons](#toolbar-buttons)).

**Statusbar** (bottom strip)
Left side: the XML / Visual annotation mode toggle (only visible for variants that define annotation tags). Center: the XPath navigation controls. Right side: indentation style and cursor position.

---

## Toolbar Buttons

| Button / Control | When visible | What it does |
| --- | --- | --- |
| ← diff / → diff | Merge view active | Navigate between changed chunks |
| Current / Incoming (reject/accept all) | Merge view active | Accept or discard all incoming annotation changes at once |
| **Wrap** switch | Always | Toggle soft line-wrapping in the editor |
| **Header** switch | When document has a `<teiHeader>` | Fold or unfold the TEI header section |
| Validate (✓ icon) | Always | Trigger a schema validation run and show errors inline |
| Undo / Redo | Always | Undo or redo editor changes |
| TEI Wizard (wand icon) | Always | Run TEI-specific utilities (currently: pretty-print) |
| Revision history (clock icon) | When document has `<revisionDesc>` | Open the revision history panel |
| XSL viewer | When XSL viewer plugin is active | Preview the document rendered via XSLT |
| Save revision (floppy disk) | Document loaded, annotator role | Record the current state in the document's revision history |
| Delete (trash) | Document loaded, permitted | Delete the current version, all versions, or the PDF and all XML |
| Upload / Download | Annotator role | Replace the current XML from a local file, or download a copy |

Buttons that are greyed out are disabled for the current document state or your role.

---

## Editing the XML

You can type directly in the editor at any time the document is not read-only. The editor provides:

- Syntax highlighting with colour-coded tags and attributes
- Real-time well-formedness checking (red underlines for structural errors)
- Bracket and tag matching
- Line folding (click the gutter triangle to collapse a section)
- Find/Replace via **Ctrl/Cmd+F** / **Ctrl/Cmd+H**

**Auto-save:** The editor saves to the server automatically after each edit once the XML is well-formed. While the XML is malformed, edits are buffered locally as a draft and the headerbar shows a warning. The draft is restored the next time you open the document if the server save never completed.

**Right-click context menu:**

| Item | What it does |
| --- | --- |
| Undo / Redo | History buttons at the top of the menu |
| Current / Incoming | Accept or discard one diff chunk (only shown inside a changed chunk in merge view) |
| Copy / Cut / Paste / Select All | Standard clipboard operations |
| Remove tag | Unwrap the tag at the cursor, preserving its text content |
| Insert `</tag><tag>` | Insert a tag boundary at the cursor position using the tag from the current XPath navigation selection |

In annotation mode the context menu additionally shows the annotation chip palette and a "Remove annotation" item — see [Visual Annotation Mode](#visual-annotation-mode).

---

## XPath Navigation

The center of the statusbar contains node navigation controls. These are only shown once a document is loaded and the active variant provides navigation XPath expressions.

1. Use the dropdown to select an XPath expression (the list is variant-specific).
2. Use the **‹** / **›** buttons to move between matching nodes; the counter (e.g. `3/15`) shows the current position.
3. Click the counter to jump to a specific node by number.

The current node is highlighted and scrolled into view each time you navigate. Your XPath selection is remembered per-variant across sessions.

---

## The TEI Header

The `<teiHeader>` block is folded by default to keep the annotation text in view. Use the **Header** toggle in the toolbar to expand or collapse it. Your preference is saved and restored the next time you open a document.

---

## Validation

Click the **Validate** button to run a full schema validation against the TEI schema. Errors appear as red underlines in the editor; hovering over an underline shows the error message. The total error count appears in a notification. If continuous validation is enabled by an administrator, validation runs automatically on each change.

---

## Saving a Revision

Auto-save keeps the document up to date silently. To record a named checkpoint in the document's revision history, click the **Save revision** button (floppy disk icon). A dialog opens with:

- **Change description** — a short note describing what changed or the current annotation state. This is stored in the TEI `<revisionDesc>`.
- **Status** — the annotation lifecycle stage (e.g. *draft*, *annotation*, *review*, *done*). Available options depend on your role.
- **Save to a new personal version** — creates a copy so you can work without touching the original. Required if you are not the document owner in owner-based access control mode.
- **Save as gold version** — marks this document as the authoritative Gold Standard (reviewers only).

---

## Revision History

Click the clock icon in the toolbar to open the revision history panel. It lists all `<change>` entries from the TEI `<revisionDesc>` in reverse chronological order, showing date, description, status, and the responsible person. The button is hidden when the document has no `<revisionDesc>`.

---

## Merge View (Comparing Versions)

When a diff document is selected in the toolbar, a side-by-side merge view activates. The diff navigation buttons and reject/accept controls highlight in the toolbar. You can:

- Use **← diff / → diff** to jump between changed chunks.
- Click **Current** (orange) in the context menu or toolbar to keep the editor text for a chunk.
- Click **Incoming** (blue) to apply the diff version for a chunk.
- Use **Reject all** / **Accept all** to resolve all chunks at once.

---

## Visual Annotation Mode

The XML editor includes a visual annotation mode that hides raw XML markup and lets you annotate text spans using a point-and-click chip palette. This is the recommended way to create GROBID training data for extraction variants that define annotation tags.

### Availability

The annotation mode toggle only appears in the editor statusbar when the active extraction variant provides annotation tag definitions. The following GROBID variants currently support it:

| Variant | Tag set |
| --- | --- |
| `grobid.training.segmentation` | body, listBibl, front, titlePage, note, page, div (acknowledgement, toc, annex, funding, conflict, contribution, availability) |
| `grobid.training.references.referenceSegmenter` | bibl, bibl[footnote], label |
| `grobid.training.references` | author, title (a/j/m/s), date, biblScope (pages/volume/issue), publisher, orgName, pubPlace, editor, ptr (URL), idno, note |

### Activating annotation mode

Click the **XML / Visual** toggle switch in the bottom-left of the XML editor statusbar. When it switches to **Visual**:

- Raw XML tags are replaced by colored inline badges (e.g. `AUTHOR`, `TITLE[A]`).
- Direct text editing is disabled — the editor is read-only for free-form changes.
- The XPath navigation header is hidden to keep the view clean.
- The editor scrolls to the start of the `<text>` element.

Click the toggle again (back to **XML**) to return to the standard XML view.

### Wrapping a text span

1. Select the text you want to annotate by clicking and dragging.
2. Right-click to open the context menu. A chip palette appears at the top, showing one colored chip per available annotation tag.
3. Hover over a chip to see its description in a tooltip.
4. Click the chip to wrap the selection. The tag is inserted with any mandatory default attributes (e.g. `<note place="footnote">`) automatically.

The editor rebuilds its decoration layer immediately after each wrapping operation.

### Editing annotation attributes

Click any colored badge in the annotation view to open an attribute popup:

- Attributes with a fixed list of values (e.g. `level` on `<title>`) appear as dropdown selects.
- Free-form attributes (e.g. `when` on `<date>`) appear as text inputs.

Changes are applied to the underlying XML as you make them. Click outside the popup or press **Escape** to dismiss it.

### Removing an annotation

- **Via context menu:** Right-click anywhere inside the annotated span, then choose **Remove annotation**.
- **Via popup:** Click the badge to open the attribute popup, then click the **Remove annotation** link at the bottom.

Both methods unwrap the element and restore its text content.

### Saving

Annotation mode operates on the live document content. Save the document normally (e.g. with the Save revision button) — annotation mode does not affect the save workflow.

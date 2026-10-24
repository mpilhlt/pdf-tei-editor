# Document Editing

The right panel of the PDF-TEI Editor contains a CodeMirror-based XML editor. This page describes the editor UI and the main editing workflows.

## Editor Layout

The XML editor panel has three chrome areas around the editing surface:

**Headerbar** (top strip)
Shows the artifact type prefix (**Gold:** or **Version:**), the artifact label, and the last revision date and author. Clicking the label copies it to the clipboard; double-clicking opens an inline rename prompt. When the editor has unsaved changes that cannot be auto-saved (e.g. because the XML is malformed), a warning badge appears here. When the document is read-only, a lock icon appears.

**Toolbar** (below the headerbar)
Contains action buttons grouped by function. What buttons are visible depends on the document state and your role (see [Toolbar buttons](#toolbar-buttons)).

**Statusbar** (bottom strip)
Left side: the XML / Visual annotation mode toggle (only visible for variants that define annotation tags). Center: the XPath navigation controls and the **Focus** toggle. Right side: indentation style and cursor position.

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
| TEI Wizard (wand icon) | Always | Run TEI-specific utilities (e.g. pretty-print, convert XML comments into [unit comments](unit-comments.md)) |
| Review (clipboard icon) | Always | Switch [unit review](unit-review.md) mode on or off |
| Revision history (clock icon) | When document has `<revisionDesc>` | Open the revision history panel |
| XSL viewer | When XSL viewer plugin is active | Preview the document rendered via XSLT |
| Save revision (floppy disk) | Document loaded, annotator role | Record the current state in the document's revision history |
| Delete (trash) | Document loaded, permitted | Delete the current version, all versions, or the PDF and all XML |
| Upload / Download | Annotator role | Replace the current XML from a local file, or download a copy |
| Theme (palette icon) | Always | Open the theme picker dropdown. Available themes: **Default (light)**, **Dark**, **Color-blind friendly**, **High contrast**. The selection is saved per user and restored on the next visit. |

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

---

## XPath Navigation

The center of the statusbar contains node navigation controls. These are only shown once a document is loaded and the active variant provides navigation XPath expressions.

1. Use the dropdown to select an XPath expression (the list is variant-specific).
2. Use the **‹** / **›** buttons to move between matching nodes; the counter (e.g. `3/15`) shows the current position.
3. Click the counter to jump to a specific node by number.

Each time you navigate, the node is scrolled to the vertical center of the editor and highlighted. Your XPath selection is remembered per-variant across sessions.

Node navigation is on while an XPath expression is selected in the dropdown. The **×** button at the end of the navigation group turns it off: the node loses its highlight or focus, the XPath selection is cleared, the **‹** / **›** buttons and the focus toggle are disabled, and the node is removed from the URL. Selecting an XPath expression in the dropdown turns navigation on again.

While node navigation is on, **Tools → Review Annotations** reviews only the current node instead of the whole document. In focus mode, the same review can be started with the **LLM Review** button in the bottom right corner of the focused node. The suggestions of a review are kept for the browser tab: after an accidental reload, or when you return to the document, they are shown again without a new review, except those whose text you have changed in the meantime.

The current node is part of the page URL (as the `xpath` parameter, next to the open document). After reloading the page you continue at the same node, and a copied URL opens the same document at the same node once the recipient has logged in.

### Focus Mode

The magnifier button (**Focus**) next to the navigation controls, available while node navigation is on, turns on a distraction-free focus mode for working on one node at a time:

- Navigating centers the node vertically, as above, but instead of highlighting it, everything outside the node is dimmed. In the Visual annotation mode, the tag labels outside the node are dimmed as well.
- The focused node gets extra space above and below it.
- Line wrapping is turned on when focus mode is switched on. You can turn it off again with the **Wrap** switch; this does not change your saved wrapping preference.
- Moving the cursor into another node (for example by clicking) moves the focus to that node.

Turn focus mode off by clicking the button again or by pressing **Esc**. The button is only available while the navigation controls are shown. Focus mode is on by default; whether you turned it on or off is remembered in your browser, so the choice is kept after reloading the page. Turning navigation off disables the focus toggle without changing this setting; focus mode applies again when navigation is turned back on.

---

## Leaving Focus and Merge Mode with Esc

Pressing **Esc** ends the current special editing mode:

1. If focus mode is on, Esc turns it off.
2. Otherwise, if a merge view is active, Esc closes it and returns to normal editing (the same as clearing the diff selection).

Esc is ignored while a dialog, drawer or dropdown is open, and when it is used to close the editor's search panel or autocomplete popup.

---

## The TEI Header

The `<teiHeader>` block is folded by default to keep the annotation text in view. Use the **Header** toggle in the toolbar to expand or collapse it. Your preference is saved and restored the next time you open a document.

---

## Validation

Click the **Validate** button to run a full schema validation against the TEI schema. Errors appear as red underlines in the editor; hovering over an underline shows the error message. All diagnostics (validation errors and annotation review suggestions) are also listed in the diagnostics drawer, see [Diagnostics drawer](#diagnostics-drawer). The total error count appears in a notification. If continuous validation is enabled by an administrator, validation runs automatically on each change.

---

## Diagnostics drawer

While the document has diagnostics, they are listed in a drawer on the left side, over the PDF. The drawer is fully shown while you work in the XML editor; when you click into the PDF viewer it slides out so the whole PDF is visible, leaving a **Diagnostics** button with the number of diagnostics in the top-left corner. Click the button to show the drawer again.

- Click a diagnostic to select the text it applies to in the XML editor.
- **Propose fix** (on annotation review suggestions) shows the change in the merge view, as in the editor tooltip.
- Check diagnostics, or use **Select all**, then click **Apply** to apply their fixes at once, without confirmation, or **Dismiss** to remove them. Both close the merge view. Diagnostics without a fix (such as validation errors) are kept by Apply.

---

## Saving a Revision

Auto-save keeps the document up to date silently. To record a named checkpoint in the document's revision history, click the **Save revision** button (floppy disk icon). A dialog opens with:

- **Change description** — a short note describing what changed or the current annotation state. This is stored in the TEI `<revisionDesc>`.
- **Status** — the annotation lifecycle stage (e.g. *draft*, *annotation*, *review*, *done*). Available options depend on your role.
- **Save to a new personal version** — creates a copy so you can work without touching the original. Required if you are not the document owner in owner-based access control mode.
- **Clear reviews** — shown with *Save to a new personal version* to reviewers when the document has [unit review](unit-review.md) marks; the new version starts without them.
- **Keep comments** — shown with *Save to a new personal version* when the document has [unit comments](unit-comments.md); uncheck it to start the new version without them.
- **Save as gold version** — marks this document as the authoritative Gold Standard (reviewers only).

### Superseded versions

As soon as a new version is saved from a version, the source version is superseded and becomes read-only for everyone, including administrators. This also applies to the Gold Standard. The status bar shows *Read-only (superseded by a newer version)*. To change a superseded version, use **Save revision** with *Save to a new personal version*, which is preselected for such versions. Deleting the newer version makes the source version editable again.

The XML version dropdown and the file drawer list only the latest version of each line of versions. The **Compare with version** menu still lists superseded versions, so they can be compared with the current one. It groups the versions by line: the current versions that were copied from the same version come first, followed by the versions they descend from, greyed out, and a divider separates one line from the next.

Each saved revision records a short hash of the document text in its `<change xml:id="h-…">`, chained to the hash of the previous revision. This makes it possible to check that the text of a recorded revision has not been changed afterwards.

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
2. Release the mouse. A popup appears near the cursor showing one colored chip per available annotation tag.
3. Hover over a chip to see its description in a tooltip.
4. Click the chip to wrap the selection. The tag is inserted with any mandatory default attributes (e.g. `<note place="footnote">`) automatically.

The editor rebuilds its decoration layer immediately after each wrapping operation.

### Editing annotation attributes

Click any colored badge in the annotation view to open an attribute popup:

- Attributes with a fixed list of values (e.g. `level` on `<title>`) appear as dropdown selects.
- Free-form attributes (e.g. `when` on `<date>`) appear as text inputs.

Changes are applied to the underlying XML as you make them. Click outside the popup or press **Escape** to dismiss it.

### Changing a tag

The attribute popup includes a **Change to** chip palette at the bottom. Click any chip to retag the annotated element to a different annotation type. The element's content is preserved; mandatory default attributes for the new tag type are applied automatically.

### Merging annotations

The attribute popup includes two merge operations for consolidating adjacent annotated spans of the same type:

- **« Merge with previous** — absorbs the current element's content into the nearest preceding sibling element, including any intermediate text, preserving reading order.
- **» Merge with next** — same, targeting the nearest following sibling element.

If no element sibling exists in the given direction, the element is unwrapped in place (equivalent to **Remove annotation**).

Use these commands when a single logical annotation has been split across two spans, for example after correcting a word boundary or combining two separately tagged author names into one.

### Removing an annotation

Click the badge to open the attribute popup, then click the **Remove annotation** link at the bottom. The element is unwrapped and its text content is restored.

### Saving

Annotation mode operates on the live document content. Save the document normally (e.g. with the Save revision button) — annotation mode does not affect the save workflow.

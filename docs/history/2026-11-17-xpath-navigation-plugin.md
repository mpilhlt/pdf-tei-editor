# XPath navigation plugin and editable navigation XPaths

Issue: [#803](https://github.com/mpilhlt/pdf-tei-editor/issues/803)

## Goal

- Move the node navigation out of the `xmleditor` frontend plugin into its own plugin `xpath-navigation`, which depends on `xmleditor` and adds its widgets to the XML editor statusbar.
- Add an "Edit..." entry to the navigation dropdown that opens a dialog with the XPath/label pairs of the variant.
- The defaults of the extractors cannot be deleted; users add, edit and delete their own entries. The XPath syntax is checked.
- Store the list in `data/db/navigation_xpath.json` in the shape of `NAVIGATION_XPATH` of the GROBID plugin, with the extractors' defaults merged in and marked as not editable.

## Implementation

### Backend

- `fastapi_app/lib/utils/navigation_xpath.py`
  - `extractor_defaults()` collects the `navigation_xpath` of all extractors by variant (first extractor wins on duplicate expressions) and marks them `"edit": false`.
  - `merge_navigation_xpath()` puts the defaults first and keeps the stored user entries. Stored entries with `"edit": false` are replaced by the current defaults, so the defaults of removed extractors disappear. User entries that duplicate a default are dropped.
  - `load_navigation_xpath()` merges on every read and writes the file back when the merged list differs from it (atomic write via a temp file, guarded by a lock).
  - `save_custom_entries()` replaces the user entries of one variant. Labels arrive as plain text and are stored HTML-escaped, like the extractor labels; an empty label becomes the expression.
  - `validate_navigation_xpath()`: the expression must start with `/`, compile with lxml, use only the prefixes `tei` and `xml` (checked by evaluating it on an empty document) and return a node-set.
- `fastapi_app/routers/navigation_xpath.py`
  - `GET /api/v1/navigation-xpath` (authenticated): `{variants: {<variant>: [{value, label, edit}]}}`.
  - `PUT /api/v1/navigation-xpath/{variant}` (annotator, reviewer, admin): `{entries: [{value, label}]}` replaces the user entries; 404 for variants that no extractor supports, 422 for invalid, duplicate or default expressions.
- The `edit` flag is a JSON boolean (`"edit": false`), not the string `"false"` that the issue text shows.

### Frontend

- `app/src/plugins/xpath-navigation.js` (new): the dropdown, ‹ › buttons, counter, focus toggle and × button; the `xpath` state ⇄ editor selection sync; restoring the stored XPath per variant after a document loads; focus mode and leaving it with Esc; the "Insert `</tag><tag>`" context menu item (now contributed through `ep.xmlEditor.contextMenuItems`); the "Navigation XPaths" dialog.
  - The entries come from the new endpoint instead of `getExtractorList()`. The "Edit..." entry is shown to annotators, reviewers and admins for variants that an extractor supports. For such users the dropdown is also shown for variants without entries, so that the first entry can be added.
  - Changes are saved immediately. Editing the selected expression moves the navigation to the new expression; deleting it turns the navigation off.
  - UI storage moved from `ui.xmleditor.*` to `ui.xpath-navigation.*` (`focusMode`, `xpath.<variant>`). The old keys are taken over on first use.
- `app/src/plugins/xmleditor.js`: the navigation code is removed. New plugin API method `wrapLinesTransiently()` (turning on focus mode turns on line wrapping without changing the stored preference). Esc in the editor now only ends the merge view, and only while focus mode is off.
- `app/src/modules/panels/widgets/status-dropdown.js`: item values are escaped (XPath predicates with quotes broke the menu), and items can be dividers or commands (`action`) that dispatch `widget-action` instead of changing the selection.
- `app/src/modules/navigation-xpath-utils.js`: client-side check of expressions (same rules as the backend) and decoding of HTML labels.

### Tests

- `tests/unit/fastapi/test_navigation_xpath.py`: validation, merging, storage and the endpoints.
- `tests/unit/js/navigation-xpath-utils.test.js`: client-side check.
- `tests/e2e/tests/xpath-navigation.spec.js`: add, navigate with, rename and delete an entry as an annotator, with the mock extractor's default.

### Documentation

- User manual: "Editing the Navigation XPaths" in `docs/user-manual/editing-workflow.md`, with two new screenshots.
- `docs/code-assistant/architecture-backend.md`, `docs/code-assistant/ui-storage.md`.

## Review fix: the dropdown no longer switches by itself

Choosing `/tei:TEI/tei:text/*[normalize-space()]` while `//tei:listBibl` was active selected the `<listBibl>` and then switched the dropdown back to `//tei:listBibl`: the selection → `xpath` state sync dispatched the xpath of the node at the cursor, computed for the previous expression.

- `#onSelectionChange()` only updates the index: it dispatches only while the editor's navigation path is the expression selected in the dropdown.
- The navigation path (`NavXmlEditor.parentPath`) keeps the non-index predicates, so the index counts the same nodes as the counter (`[normalize-space()]` skips empty elements).
- `NavXmlEditor.handeSelectionChange()` bubbles up to the nearest ancestor that the path selects, instead of comparing tag names, so cursor moves also work for wildcards and predicates.

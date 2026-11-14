# Document status in the XML editor headerbar

The lifecycle status of a document (the `status` attribute of the last `teiHeader/revisionDesc/change`) was not visible in the UI. The XML editor headerbar now shows it after the artifact label: `Version: v2 (dfejzo)  Status: draft`.

## Implementation

- `app/src/templates/xmleditor-headerbar.html`: new `documentStatusWidget`.
- `app/src/modules/tei-utils.js`: `getRevisionStatus(xmlDoc)` returns the status of the last header change, or `null`. Stand-off `revisionDesc` elements are ignored, same as the backend's `extract_last_revision_status`.
- `app/src/plugins/xmleditor.js`:
  - On a file change, `onStateUpdate` shows the `status` of the file list entry until the document is loaded.
  - On `editorAfterLoad` and `editorUpdateDelayed`, the status is read from the editor's XML tree, so it updates as soon as a revision with a new status is added (the file list is not reloaded after an in-place revision save). While the XML is not well-formed, the last status stays.
  - Without a document or a status, the widget is hidden.
  - Logs `DOCUMENT_STATUS_SHOWN` (test log) when the shown status changes.

## Tests

- Unit: `getRevisionStatus` in `tests/unit/js/tei-utils.test.js`.
- E2E: `document-actions.spec.js` "should save status to change element" checks that the headerbar switches to the saved status.

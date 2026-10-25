# Incremental updates of read-only documents

A document that is read-only for the user follows other users' saves (`fileDataChanged`, see #629). It was reloaded completely, which closed popovers, reset folds and briefly hid the editor. It now applies only the changed ranges.

## Implementation

- `XMLEditor.applyRemoteContent(xml)` (`app/src/modules/xmleditor.js`) diffs the editor text against the new text with `diff()` of `@codemirror/merge` and dispatches the changes with the `remoteChange` annotation and without history. The editor stays clean, so no draft or autosave follows. It refuses (returns false) when the editor is dirty, the merge view is open, the new text is not well-formed or more than half of the characters changed; `#followSave` in `app/src/plugins/xmleditor.js` then reloads as before.
- `isRemoteUpdate(update)` tells update listeners whether an update applies another user's changes:
  - unit-review resets its carry map and the previous scan, as after a load, so that it does not carry marks over or renumber them again: the saved text already holds the result of the other user's edit, including "changed after a not-OK review".
  - unit-comments maps its anchor positions through the change but does not persist anchors.
- `XML_EDITOR_FOLLOWED_SAVE` has `incremental: true|false`.

## Tests

- `tests/unit/js/xmleditor-remote-content.test.js`
- `tests/e2e/tests/unit-review.spec.js`: the reviewer's view follows the annotator's save without a `XML_EDITOR_DOCUMENT_LOADED`.

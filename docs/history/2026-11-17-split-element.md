# Split element in the XML editor context menu

Issue: [#802](https://github.com/mpilhlt/pdf-tei-editor/issues/802)

## Problem

The context menu entry "Insert `</tag><tag>`" inserted a tag boundary at the cursor, with the tag name taken from the last step of the XPath selected in the navigation dropdown. It did not work for documents whose navigation XPath does not name the element around the cursor, such as `training.segmentation` documents, and it lost the attributes of the element.

## Change

- New module `app/src/modules/codemirror/split-element.js`: `findSplitTarget(state, pos)` finds the innermost element whose content contains the position in the CodeMirror XML syntax tree, and `splitElementAt(state, pos)` returns the transaction that splits it. The inserted text is the closing tag followed by a copy of the opening tag without its `xml:id` attribute. The cursor ends up at the start of the second element.
- Positions inside a tag, comment, processing instruction, CDATA section or entity, outside the root element, or directly in the root element (splitting it would produce two root elements) cannot be split.
- `XmlEditorContextMenu` has a built-in item "Split `<tag>`" below "Remove tag". It splits at the cursor and shows the name of the element, or is disabled as "Split element". The old item and `#tagNameFromXpath()` in the `xmleditor` plugin are removed.

## Tests

- `tests/unit/js/split-element.test.js`: splitting in text and between children, attribute copy, `xml:id` removal, refused positions.
- `tests/e2e/tests/xml-editor-split-element.spec.js`: the menu item is disabled inside a tag and splits a `<p>` at the cursor.

## Documentation

- `docs/user-manual/editing-workflow.md`: context menu table entry and two screenshots (`editing-workflow-split-element.png`, `editing-workflow-split-element-result.png`) of a segmentation document.
- `docs/images/bookmarks-context-menu.png` refreshed, since it showed the old entry.

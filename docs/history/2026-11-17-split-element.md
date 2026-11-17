# Split element in the XML editor context menu

Issue: [#802](https://github.com/mpilhlt/pdf-tei-editor/issues/802)

## Problem

The context menu entry "Insert `</tag><tag>`" inserted a tag boundary at the cursor, with the tag name taken from the last step of the XPath selected in the navigation dropdown. It did not work for documents whose navigation XPath does not name the element around the cursor, such as `training.segmentation` documents, and it lost the attributes of the element.

## Change

- New module `app/src/modules/codemirror/split-element.js`: `findSplitTarget(state, pos)` finds the innermost element whose content contains the position in the CodeMirror XML syntax tree, and `splitElementAt(state, pos)` returns the transaction that splits it. The inserted text is the closing tag followed by a copy of the opening tag without its `xml:id` attribute. The cursor ends up at the start of the second element.
- Positions inside a tag, comment, processing instruction, CDATA section or entity, outside the root element, or directly in the root element (splitting it would produce two root elements) cannot be split.
- `XmlEditorContextMenu` has a built-in item "Split `<tag>`" below "Remove tag". It shows the name of the element, or is disabled as "Split element". It splits at the right-clicked position, or at the cursor if the right-click is inside the selection: in the visual annotation mode a right-click does not move the cursor. The old item and `#tagNameFromXpath()` in the `xmleditor` plugin are removed.
- Visual annotation mode (review comment on the PR): the mode makes the editor read-only for typing (`XMLEditor.setReadOnly(true)`), which disabled the item. `XmlEditorContextMenu` now takes an `isDocumentEditable` option; the `xmleditor` plugin passes `!state.editorReadOnly`, so splitting works in the visual mode as long as the document is editable.
- Shift variants (requested in the project thread): menu items with `data-show-with="shift"` are only shown while Shift is held, items with `data-hide-with="shift"` are hidden then. The state is taken from the `contextmenu` event and follows `keydown`/`keyup` of Shift while the menu is open, since Firefox opens its native menu on Shift+right-click. Shoelace menu items set `display` on their host, so the items are hidden with `style.display`, not the `hidden` attribute. The first pair is "Split `<tag>`" / "Split `<tag>` in new line"; `splitElementAt(state, pos, { newLine: true })` inserts a line break and the indentation of the line on which the element starts before the new opening tag.

- Menu layout (requested in the project thread): "Remove tag" and the split items moved from the bottom of the menu to below the items that plugins prepend ("Bookmark…", "Comment…"), between two dividers. Dividers at the start or end of the menu or after another visible divider get the class `xml-editor-context-menu__divider--redundant` (`display: none`) when the menu is shown, so hidden plugin items leave no double dividers. Items with a Shift variant carry a "⇧" suffix. The "History" row (Undo/Redo) is hidden with `display: none`; its code is kept for now.


- `tests/unit/js/split-element.test.js`: splitting in text and between children, attribute copy, `xml:id` removal, refused positions, split in new line with indentation.
- `tests/e2e/tests/xml-editor-split-element.spec.js`: the menu item is disabled inside a tag, splits a `<p>` at the cursor, splits at the right-clicked position while the editor is read-only for typing (as in the visual mode), and swaps in "Split `<p>` in new line" while Shift is held.

## Documentation

- `docs/user-manual/editing-workflow.md`: context menu table entry and two screenshots (`editing-workflow-split-element.png`, `editing-workflow-split-element-result.png`) of a segmentation document; section "Splitting an annotation" in the visual annotation mode with two screenshots (`editing-workflow-split-element-visual.png`, `editing-workflow-split-element-visual-result.png`); the Shift variant with two screenshots (`editing-workflow-split-element-new-line.png`, `editing-workflow-split-element-new-line-result.png`).
- `docs/images/bookmarks-context-menu.png` refreshed, since it showed the old entry.

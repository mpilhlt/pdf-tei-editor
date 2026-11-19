# XPath switch keeps the position

Switching the expression in the XPath navigation dropdown used to select the first node of the new expression (`[1]`), which jumped back to the start of the document.

## Behavior

The dropdown handler in `app/src/plugins/xpath-navigation.js` (`#indexAtCurrentPosition`) computes the index of the new expression from the current node:

- The current node is the node of the `xpath` state, or the element at the cursor if navigation was off.
- The selected node is the first node of the new expression, in document order, that is the current node, contains it, or follows it (which includes its descendants), see `indexAtOrAfterNode` in `app/src/modules/navigation-xpath-utils.js`. The comparison uses `Node.compareDocumentPosition()` on the XML DOM, not editor positions.
- If no node follows, the navigation wraps around to the first node, like ‹ › do.
- If the current node cannot be determined (editor not ready), index 1 is used.

Loading a document with the stored expression of the variant and changing the selected expression in the dialog still start at `[1]`.

## Navigation index vs. XPath index

In the navigation and the `xpath` state, `path[n]` is the n-th of all nodes that `path` selects, in document order (this is how the counter and the cursor tracking count). Evaluated as XPath, `[n]` counts only the siblings within each parent: `//tei:listBibl[2]` selects nothing if every `<listBibl>` is the first in its parent. The first version of this feature resolved the current node with the plain XPath, did not find it for such expressions and fell back to the cursor; ‹ › also did not move the editor to such nodes.

`navigationNodeXpath()` in `app/src/modules/utils.js` turns `path[n]` into `(path)[n]`. It is used wherever a navigation xpath is evaluated: `NavXmlEditor` (`selectByIndex`, focus mode, focus realignment), the arrow keys and dropdown switch in the xpath-navigation plugin, the visual mode's scroll to the current node (`xml-annotation.js`) and the line wrapping toggle (`xmleditor.js`).

## Tests

- Unit: `tests/unit/js/navigation-xpath-utils.test.js` (`indexAtOrAfterNode`).
- E2E: `tests/e2e/tests/xpath-navigation.spec.js`, "switching the expression selects the next node of the new expression" and "switching the expression keeps the position among nodes with different parents" (both fail without the respective fix).

# XPath switch keeps the position

Switching the expression in the XPath navigation dropdown used to select the first node of the new expression (`[1]`), which jumped back to the start of the document.

## Behavior

The dropdown handler in `app/src/plugins/xpath-navigation.js` (`#indexAtCurrentPosition`) computes the index of the new expression from the current position:

- The position is the start of the current node (`xpath` state), or the cursor if navigation was off.
- The selected node is the first node of the new expression, in document order, that ends after the position, i.e. contains it or follows it (`indexAtOrAfterPosition` in `app/src/modules/navigation-xpath-utils.js`). Switching from a child expression to a parent expression therefore selects the parent containing the current node.
- If no node follows, the navigation wraps around to the first node, like ‹ › do.
- If the position cannot be determined (editor not ready, node not mapped), index 1 is used.

Loading a document with the stored expression of the variant and changing the selected expression in the dialog still start at `[1]`.

## Tests

- Unit: `tests/unit/js/navigation-xpath-utils.test.js` (`indexAtOrAfterPosition`).
- E2E: `tests/e2e/tests/xpath-navigation.spec.js`, "switching the expression selects the next node of the new expression" (fails without the fix).

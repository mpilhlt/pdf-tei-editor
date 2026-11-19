# XPath switch keeps the position

Switching the expression in the XPath navigation dropdown used to select the first node of the new expression, which jumped back to the start of the document.

## Navigation xpath state

The `xpath` state (and the `xpath` URL parameter) is `(path)[n]`: the n-th node, in document order, of all nodes that the navigation expression `path` selects. This is a valid XPath expression for the node, so it is evaluated as is everywhere (`NavXmlEditor`, xpath-navigation plugin, `xml-annotation.js`, `xmleditor.js`).

The former form `path[n]` is not accepted any more (discarded on load, no migration). As XPath, `[n]` counts only siblings within each parent, so `//tei:listBibl[2]` selected nothing when every `<listBibl>` was the first in its parent, although the counter showed two nodes (issue #859).

`navigationXpath(path, index)` and `parseNavigationXpath(xpath)` in `app/src/modules/navigation-xpath-utils.js` build and split the state value.

`UrlHash.serialize()` (`app/src/modules/browser-utils.js`) writes hash values without percent-encoding, apart from `%`, `&`, `+`, `#` (and `=` in keys) and control characters, so that the xpath stays readable in the address bar.

## Switching the expression

The dropdown handler (`#indexAtCurrentPosition` in `app/src/plugins/xpath-navigation.js`) takes the element at the cursor (the start of the selection) as the position if it is inside the current node, otherwise the current node. `indexAtOrAfterNode` then selects:

- the innermost node of the new expression that is the position element or contains it,
- else the first node of the new expression after the start of the position element in document order (which includes its descendants),
- else the first node (wrap around, like ‹ ›).

Starting from the cursor matters for large nodes such as the children of `<text>`: from the start of the current node, the first descendant matching the new expression would be selected, e.g. the first `<pb/>` of the `<body>`, which looks like starting from the beginning.

Loading a document with the stored expression of the variant and changing the selected expression in the dialog start at `[1]`.

## Tests

- Unit: `tests/unit/js/navigation-xpath-utils.test.js` (`indexAtOrAfterNode`), `tests/unit/js/browser-utils.test.js` (`UrlHash.serialize`).
- E2E: `tests/e2e/tests/xpath-navigation.spec.js`: switching keeps the position, nodes with different parents, starting from the element at the cursor (each fails without its fix), unencoded xpath in the URL.

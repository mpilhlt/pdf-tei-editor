# Arrow keys in focus mode (issue #835)

## Problem

In focus mode, the up/down arrow keys moved the cursor (or, without keyboard focus in the editor text, scrolled the page) instead of moving the focus to the previous/next node. Moving the cursor out of a node did move the focus along, but without centering the new node, so the page scrolled line by line.

## Change

`app/src/plugins/xpath-navigation.js`:

- A high-precedence CodeMirror keymap for `ArrowUp`/`ArrowDown` (`#onEditorArrowKey`). In focus mode, it checks where `view.moveVertically()` would put the cursor. If the cursor stays inside the focused range, the key moves the cursor as usual. If it would leave the range (first/last line of the node), or the cursor is outside it, the key navigates to the previous/next node through the `xpath` state, which centers the node like the ‹ › buttons.
- A document-level `keydown` listener (`#onDocumentArrowKey`) does the same while the keyboard focus is on the page body or in the XML editor's bars (e.g. after clicking ‹ ›), but not in form fields, overlays or other panels such as the PDF viewer. Modified keys are ignored.
- At the first and last node, the arrow keys do not wrap around in the XML mode (unlike the ‹ › buttons): `#changeNodeIndex()` got a `wrap` option, backed by the new `#adjacentXpath()`.
- In the visual annotation mode, the cursor has no function, so while node navigation is on (with or without focus mode), the arrow keys always go to the previous/next node, wrapping around like ‹ › (Christian's review, 2026-11-18).
- In focus mode, `#navigateByArrowKey()` focuses the target node synchronously before dispatching the `xpath` state, so the editor responds without waiting for the state propagation through all plugins (which made the XML mode feel laggy).

The autocomplete popup keeps its arrow keys, since its keymap has the highest precedence.

## Tests

`tests/e2e/tests/xpath-navigation.spec.js`: "in focus mode, the arrow keys move the focus to the previous/next node" covers single-line and multi-line nodes in the editor text, the keys after clicking › and the missing wrap-around at the first node. "in the visual mode, the arrow keys go to the previous/next node like the buttons" covers the visual mode without focus mode, including the wrap-around.

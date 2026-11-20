# Badge clicks in the annotation view keep the selection (#834)

## Problem

In the visual annotation mode, a click on the badge of an element other than the selected one first selected that element. The badge widget let CodeMirror handle the mouse press (`ignoreEvent()` returned `false`), so the press placed the cursor at the badge. With XPath navigation on, the `xpath-navigation` plugin turned the new cursor position into an `xpath` state change, and `xml-annotation` scrolled the element to the center of the editor. The click then landed on whatever had moved under the pointer instead of the badge, and the popup did not open.

## Fix

`BadgeWidget` in `app/src/modules/codemirror/xml-annotation-decorations.js`:

- `ignoreEvent(event)` returns `true` for `mousedown` on clickable badges, so CodeMirror does not place the cursor.
- A `mousedown` listener on the badge calls `preventDefault()`, so the browser does not place the caret in the contenteditable either (CodeMirror would read it back from the DOM selection).
- The `click` listener is unchanged and still dispatches `ann-badge-click`, which opens the popup.

Read-only badges (display-only elements such as `<text>`) keep the previous behavior and act like text. Selecting an element in annotation mode works by clicking its text.

## Tests

- `tests/unit/js/xml-annotation-decorations.test.js`: `ignoreEvent` per event type and badge kind; a dispatched press is default-prevented, leaves the selection unchanged, and the click still fires `ann-badge-click`. The test setup now uses jsdom's `CustomEvent`, without which the badge's event dispatch threw inside the listener.
- `tests/e2e/tests/xml-annotation-badge-click.spec.js`: places the cursor in one `<bibl>`, clicks the badge of another with the real mouse, and checks that the popup opens while cursor, `xpath` state and scroll position stay the same. The test fails without the fix (the cursor moves to the badge).

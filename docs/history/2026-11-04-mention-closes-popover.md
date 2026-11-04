# Picking an @-mention closed the comment popover (#697)

## Problem

In the unit review and unit comment popovers, typing `@` opens the mention autocomplete list. Clicking a name in that list closed the whole popover instead of inserting the mention.

## Cause

`show()` in `app/src/modules/unit-review-popover.js` closes the popover on any `mousedown` (capture phase) whose target is outside the popover element. The mention list (`app/src/modules/mention-autocomplete.js`) is appended to `document.body`, not to the popover, so a click on it counted as a click outside. Keyboard selection (Enter/Tab) was not affected.

## Fix

The outside-click handler ignores targets inside a `.mention-list`. The list stays attached to the body so that its fixed positioning is not affected by the popover's styles.

## Test

`tests/unit/js/mention-popover.test.js` opens a comment prompt in JSDOM, types `@j`, clicks the option and checks that the popover stays open with `@jdoe` inserted, and that a click elsewhere still closes it. It fails without the fix.

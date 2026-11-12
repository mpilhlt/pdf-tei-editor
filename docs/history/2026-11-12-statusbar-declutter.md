# Declutter the XML editor status bar

The status bar of the XML editor was too cramped once review mode and unit comments were active.

## Changes

- **Open comments counter** shows only the speech bubble and the number (`💬 7`). The full text is in its title.
- **Review progress meter** shows only the bar. The counts (`73 OK · 1 not OK · 21 disputed · 0 open`) and the click hint are in a Shoelace tooltip shown on hover. The counts stay in the meter's DOM (tooltip `content` slot), so the E2E assertions on the meter text are unchanged.
- **Overflow priorities** (lowest hidden first):

  | Widget | Priority |
  | --- | --- |
  | Cursor position (`Ln X, Col Y`) | -10 |
  | Theme picker | -3 |
  | Indentation | -2 |
  | Permissions info / dropdown, XML/Visual switch | 1 to 3 |
  | Review progress bar | 4 |
  | Node navigation (incl. focus and clear buttons) | 5 |
  | Open comments counter | 6 |

## Fixes found on the way

- The right-hand widgets of `xmleditor-statusbar-right.html` received their priorities by template index, which included the leading HTML comment. The priorities were shifted by one: the indentation got the separator's priority and the cursor position got 0. The widgets are now filtered to elements before the priorities are assigned.
- `StatusBar.syncSeparators()` hid a separator only when the widget before it was hidden. It now also hides it when the widget after it is hidden, so hiding the cursor position no longer leaves a dangling dot after the indentation.

## Verification

- `tests/unit/js/status-bar-overflow.test.js` covers the new hiding order and the separator rule.
- Screenshots of the status bar at several widths were taken with a temporary Playwright spec (the navigation xpaths of the segmentation variant mocked via `/api/v1/extract/list`).

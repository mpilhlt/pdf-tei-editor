# Refactor toolbar/menu population to use js-plugin endpoints

We want loose UI coupling - the toolbar and the toolbar menu should use plugin extension points to collect their content.

- The extension points should provide arrays of typed objects, `ToolbarElement` and `MenuElement`, which have `element` and `position`, and `priority` keys.

- `element` must be valid child elements of the respective container.
- `position` is either `null`, indicating that it is simply appended to the existing content. ... How to express relative positioning (start, end, center, something in between?)
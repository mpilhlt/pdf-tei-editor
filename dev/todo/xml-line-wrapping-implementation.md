# XML Editor Line Wrapping Toggle - Implementation Plan

## Overview

Add a toggle switch to the XML editor statusbar that allows users to enable/disable line wrapping. The XMLEditor module already has `setLineWrapping(value)` support; this task adds UI controls.

## Current State

- XMLEditor module (`app/src/modules/xmleditor.js`) has:
  - `#lineWrappingCompartment` (line 160)
  - `setLineWrapping(value)` method (lines 703-712)
- XML editor plugin hardcodes line wrapping to `true` on document load (line 269)
- Statusbar uses `status-switch` widget for toggle controls

## UI Components

### Add Line Wrapping Toggle Widget

**File:** `app/src/templates/xmleditor-statusbar.html`

Add after the teiHeader toggle widget:

```html
<!-- XML Editor statusbar widgets -->
<status-text
  name="teiHeaderToggleWidget"
  text=""
  icon="person-gear"
  variant="neutral"
  style="display: none">
</status-text>

<status-switch
  name="lineWrappingSwitch"
  text="Wrap"
  checked
  size="small">
</status-switch>
```

### Update Type Definitions

**File:** `app/src/plugins/xmleditor.js`

Update the `xmlEditorStatusbarPart` typedef (lines 58-62):

```javascript
/**
 * XML editor statusbar navigation properties
 * @typedef {object} xmlEditorStatusbarPart
 * @property {StatusText} teiHeaderToggleWidget - TEI header visibility toggle widget
 * @property {import('../modules/panels/widgets/status-switch.js').StatusSwitch} lineWrappingSwitch - Line wrapping toggle switch
 * @property {StatusText} indentationStatusWidget - The indentation status widget
 * @property {StatusText} cursorPositionWidget - The cursor position widget
 */
```

Add import for StatusSwitch type:

```javascript
/**
 * @import { ApplicationState } from '../state.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { StatusSwitch } from '../modules/panels/widgets/status-switch.js'
 * @import { UIPart } from '../ui.js'
 * @import { StatusBar } from '../modules/panels/status-bar.js'
 * @import { ToolBar } from '../modules/panels/tool-bar.js'
 */
```

## Plugin Implementation

**File:** `app/src/plugins/xmleditor.js`

### Add State Variable

After line 102, add:

```javascript
// State to track line wrapping (starts enabled)
let lineWrappingEnabled = true
```

### Add Event Listener in install()

In the `install()` function, after the teiHeader toggle event listener (after line 290), add:

```javascript
// Add click handler for line wrapping toggle
ui.xmlEditor.statusbar.lineWrappingSwitch.addEventListener('widget-change', (e) => {
  lineWrappingEnabled = e.detail.checked
  xmlEditor.setLineWrapping(lineWrappingEnabled)
  logger.debug(`Line wrapping ${lineWrappingEnabled ? 'enabled' : 'disabled'}`)
})
```

### Update Line Wrapping Initialization

Replace the hardcoded line wrapping call (line 269):

**Before:**
```javascript
// Restore line wrapping after XML is loaded
xmlEditor.setLineWrapping(true)
```

**After:**
```javascript
// Apply line wrapping state after XML is loaded
xmlEditor.setLineWrapping(lineWrappingEnabled)
```

### Update Visibility in update()

In the `update()` function (line 376), update the widget visibility logic (lines 380-382):

**Before:**
```javascript
[readOnlyStatusWidget, cursorPositionWidget,
  indentationStatusWidget, teiHeaderToggleWidget]
  .forEach(widget => widget.style.display = state.xml ? 'inline-flex' : 'none')
```

**After:**
```javascript
[readOnlyStatusWidget, cursorPositionWidget,
  indentationStatusWidget, teiHeaderToggleWidget, ui.xmlEditor.statusbar.lineWrappingSwitch]
  .forEach(widget => widget.style.display = state.xml ? 'inline-flex' : 'none')
```

## Implementation Steps

1. Add `status-switch` widget to `xmleditor-statusbar.html` template
2. Add `StatusSwitch` type import to xmleditor plugin
3. Update `xmlEditorStatusbarPart` typedef to include `lineWrappingSwitch`
4. Add `lineWrappingEnabled` state variable
5. Add `widget-change` event listener for the switch
6. Update hardcoded line wrapping initialization to use state variable
7. Update widget visibility logic in `update()` function
8. Test toggle functionality in browser

## Code Examples

### Event Listener Pattern

The implementation follows the existing teiHeader toggle pattern:

```javascript
// Pattern from teiHeader toggle (lines 288-290)
teiHeaderToggleWidget.addEventListener('click', () => {
  toggleTeiHeaderVisibility()
})

// Pattern for line wrapping switch
ui.xmlEditor.statusbar.lineWrappingSwitch.addEventListener('widget-change', (e) => {
  lineWrappingEnabled = e.detail.checked
  xmlEditor.setLineWrapping(lineWrappingEnabled)
})
```

### StatusSwitch Widget Usage

Reference from `status-switch.js`:

- Emits `widget-change` event with `detail.checked` property (lines 36-42)
- Attributes: `text`, `checked`, `disabled`, `size`, `help-text`
- Default size is `small`

## Testing

1. Load XML document in editor
2. Verify switch appears in statusbar with "Wrap" label
3. Verify switch is checked by default (line wrapping enabled)
4. Click switch to disable - verify long lines extend horizontally
5. Click switch to enable - verify lines wrap to viewport width
6. Load different document - verify wrapping state persists
7. Verify switch visibility toggles with document load/unload

## Files Modified

- `app/src/templates/xmleditor-statusbar.html` - Add switch widget
- `app/src/plugins/xmleditor.js` - Add toggle logic and state management

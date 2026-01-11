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

### Add Helper Functions for LocalStorage

Add after imports (around line 70):

```javascript
// LocalStorage key for line wrapping preference
const LINE_WRAP_STORAGE_KEY = 'pdf-tei-editor.xmleditor.lineWrapping'

/**
 * Get line wrapping preference from localStorage
 * @returns {boolean} Line wrapping enabled state (default: true)
 */
function getLineWrappingPreference() {
  const stored = localStorage.getItem(LINE_WRAP_STORAGE_KEY)
  return stored !== null ? stored === 'true' : true // Default to enabled
}

/**
 * Save line wrapping preference to localStorage
 * @param {boolean} enabled - Whether line wrapping is enabled
 */
function setLineWrappingPreference(enabled) {
  localStorage.setItem(LINE_WRAP_STORAGE_KEY, String(enabled))
}
```

### Initialize Switch State in install()

In the `install()` function, before the event listener setup (around line 280), add:

```javascript
// Initialize line wrapping switch from stored preference
const lineWrappingEnabled = getLineWrappingPreference()
ui.xmlEditor.statusbar.lineWrappingSwitch.checked = lineWrappingEnabled
```

### Add Event Listener in install()

In the `install()` function, after the teiHeader toggle event listener (after line 290), add:

```javascript
// Add change handler for line wrapping toggle
ui.xmlEditor.statusbar.lineWrappingSwitch.addEventListener('widget-change', (e) => {
  const enabled = e.detail.checked
  setLineWrappingPreference(enabled)
  xmlEditor.setLineWrapping(enabled)
  logger.debug(`Line wrapping ${enabled ? 'enabled' : 'disabled'}`)
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
// Apply user's line wrapping preference after XML is loaded
xmlEditor.setLineWrapping(getLineWrappingPreference())
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
4. Add localStorage helper functions (`getLineWrappingPreference`, `setLineWrappingPreference`)
5. Initialize switch state from localStorage in `install()` function
6. Add `widget-change` event listener that updates localStorage and editor
7. Update hardcoded line wrapping initialization to read from localStorage
8. Update widget visibility logic in `update()` function
9. Test toggle functionality and preference persistence in browser

## Code Examples

### LocalStorage Preference Pattern

This implementation stores the line wrapping preference in localStorage (not application state):

```javascript
// Store preference
function setLineWrappingPreference(enabled) {
  localStorage.setItem('pdf-tei-editor.xmleditor.lineWrapping', String(enabled))
}

// Retrieve preference with default
function getLineWrappingPreference() {
  const stored = localStorage.getItem('pdf-tei-editor.xmleditor.lineWrapping')
  return stored !== null ? stored === 'true' : true
}

// Apply on change
ui.xmlEditor.statusbar.lineWrappingSwitch.addEventListener('widget-change', (e) => {
  const enabled = e.detail.checked
  setLineWrappingPreference(enabled) // Persist to localStorage
  xmlEditor.setLineWrapping(enabled)  // Apply to editor
})
```

### Why LocalStorage, Not Application State

- **User preference**: Line wrapping is a UI preference, not document workflow state
- **Persistence**: Should survive page reloads and browser restarts
- **Separation of concerns**: Not related to pdf/xml/diff state management
- **No sync needed**: Preference is client-side only, no backend coordination

### StatusSwitch Widget Usage

Reference from `status-switch.js`:

- Emits `widget-change` event with `detail.checked` property (lines 36-42)
- Attributes: `text`, `checked`, `disabled`, `size`, `help-text`
- Default size is `small`
- Can be initialized programmatically: `switch.checked = true`

## Testing

1. **Initial load**: Load XML document in editor
2. **Widget visibility**: Verify switch appears in statusbar with "Wrap" label
3. **Default state**: Verify switch is checked by default (line wrapping enabled)
4. **Disable wrapping**: Click switch to uncheck - verify long lines extend horizontally
5. **Enable wrapping**: Click switch to check - verify lines wrap to viewport width
6. **Persistence across documents**: Load different document - verify wrapping state persists
7. **Persistence across page reloads**:
   - Set wrapping to disabled
   - Reload page (F5)
   - Load XML document
   - Verify wrapping is still disabled and switch is unchecked
8. **Widget visibility**: Verify switch visibility toggles with document load/unload
9. **LocalStorage inspection**: Open DevTools > Application > Local Storage - verify `pdf-tei-editor.xmleditor.lineWrapping` key exists with `"true"` or `"false"` value

## Files Modified

- `app/src/templates/xmleditor-statusbar.html` - Add switch widget
- `app/src/plugins/xmleditor.js` - Add toggle logic and state management

---

## Implementation Summary

The line wrapping toggle has been successfully implemented. All planned changes were completed:

### Template Changes
- Added `<status-switch>` widget to `xmleditor-statusbar.html` with "Wrap" label, checked by default, size small

### Plugin Changes (`xmleditor.js`)
- Added `StatusSwitch` type import
- Updated `xmlEditorStatusbarPart` typedef to include `lineWrappingSwitch` property
- Added localStorage helper functions:
  - `getLineWrappingPreference()` - Retrieves preference with default value `true`
  - `setLineWrappingPreference(enabled)` - Persists preference to localStorage
- Initialized switch checked state from localStorage in `install()` (lines 216-218)
- Added `widget-change` event listener that updates localStorage and calls `xmlEditor.setLineWrapping()` (lines 318-324)
- Updated line wrapping initialization in `editorAfterLoad` event to use `getLineWrappingPreference()` instead of hardcoded `true` (line 295)
- Added switch to widget visibility logic in `update()` function (line 415)

### Behavior
- Switch appears in statusbar only when XML document is loaded
- Preference persists across page reloads and browser sessions via localStorage
- Default state is enabled (checked)
- Toggle immediately applies wrapping change to editor
- Preference stored under key `pdf-tei-editor.xmleditor.lineWrapping`

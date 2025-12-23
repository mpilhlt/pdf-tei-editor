# Config-editor

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/136

Depends on `dev/todo/setting-menu.md` (completed - now toolbar menu in [app/src/plugins/toolbar.js](app/src/plugins/toolbar.js))

Implement a plugin providing an editor for configuration values similar to the Firefox one.

- It must only be accessible to the admin role
- The configuration editor is opened via an entry in the settings menu (toolbar menu).
- It works with the config API of the backend (`fastapi_app/api/config.py`)

## Implementation Plan

### Backend API (Already exists)

The backend API at [fastapi_app/api/config.py](fastapi_app/api/config.py:96-148) provides:
- `GET /api/config/list` - Returns all config key/value pairs
- `POST /api/config/set` - Sets a config value (authenticated, requires admin check in frontend)
- Config utilities in [fastapi_app/lib/config_utils.py](fastapi_app/lib/config_utils.py) handle validation and type constraints

Config format supports:
- Direct key/value pairs (e.g., `"heartbeat.interval": 30`)
- Type constraints (e.g., `"application.login-message.type": "string"`)
- Value constraints (e.g., `"application.mode.values": ["development", "production", "testing"]`)

### Frontend Components

#### 1. Plugin File: `app/src/plugins/config-editor.js`

Responsibilities:
- Register templates during module load
- Add menu item to toolbar menu during `install()`
- Show/hide menu item based on admin role in `update()`
- Manage dialog state (open/close)
- Load config data from `/api/config/list`
- Filter/search config entries
- Save modified values via `/api/config/set`
- Handle validation errors from backend

Key patterns:
```javascript
// Template registration (module level)
await registerTemplate('config-editor-dialog', 'config-editor-dialog.html')
await registerTemplate('config-editor-menu-item', 'config-editor-menu-item.html')

// Install phase
async function install(state) {
  createSingleFromTemplate('config-editor-dialog', document.body)
  createFromTemplate('config-editor-menu-item', ui.toolbar.toolbarMenu.menu)
  ui.toolbar.toolbarMenu.menu.configEditorMenuItem.style.display = 'none'
}

// Update phase - show/hide for admin
async function update(state) {
  const isAdmin = userIsAdmin(state.user)
  ui.toolbar.toolbarMenu.menu.configEditorMenuItem.style.display = isAdmin ? '' : 'none'
}
```

#### 2. Menu Item Template: `app/src/templates/config-editor-menu-item.html`

```html
<sl-menu-item name="configEditorMenuItem">
  <sl-icon slot="prefix" name="gear"></sl-icon>
  Configuration Editor
</sl-menu-item>
```

#### 3. Dialog Template: `app/src/templates/config-editor-dialog.html`

Structure:
- `<sl-dialog>` with `name="configEditorDialog"`
- Header with title and close button
- Search input (`<sl-input name="searchInput">`) for filtering keys
- Scrollable config list container
- Each config entry as a row with:
  - Key name (read-only text or label)
  - Value editor (input type depends on value type)
  - Modified indicator
  - Reset button (if modified)
- Footer with Save All and Reset All buttons

UI elements needed:
- `searchInput` - Filter config keys
- `configList` - Container for config entries
- `saveAllBtn` - Save all modified values
- `resetAllBtn` - Reset all to original values
- `closeBtn` - Close dialog

#### 4. UI Typedef Updates

Add to [app/src/plugins/toolbar.js](app/src/plugins/toolbar.js:29-37):
```javascript
@property {import('../ui.js').SlMenuItem} [menu.configEditorMenuItem] - Config editor menu item (added by config-editor plugin, admin only)
```

Create typedef in config-editor plugin:
```javascript
/**
 * @typedef {object} configEditorDialogPart
 * @property {SlInput} searchInput - Search/filter input
 * @property {HTMLElement} configList - Container for config entries
 * @property {SlButton} saveAllBtn - Save all button
 * @property {SlButton} resetAllBtn - Reset all button
 * @property {SlButton} closeBtn - Close dialog button
 */
```

Add to [app/src/ui.js](app/src/ui.js):
```javascript
@import { configEditorDialogPart } from './plugins/config-editor.js'
@property {UIPart<SlDialog, configEditorDialogPart>} [configEditorDialog] - Config editor dialog
```

### Implementation Steps

1. Create menu item template `app/src/templates/config-editor-menu-item.html`
2. Create dialog template `app/src/templates/config-editor-dialog.html`
3. Create plugin `app/src/plugins/config-editor.js`:
   - Register templates
   - Implement `install()` to add UI elements
   - Implement `update()` to show/hide based on admin role
   - Load config data from API
   - Implement search/filter functionality
   - Implement value editing with type-specific inputs
   - Handle save operation with API calls
   - Show validation errors
4. Add typedef to toolbar.js for menu item
5. Create typedef in config-editor.js for dialog
6. Add typedef import and property in ui.js
7. Register plugin in [app/src/plugins.js](app/src/plugins.js)
8. Test with admin and non-admin users

### Key Implementation Details

- Use `client.apiClient.config.configList()` to load config
- Use `client.apiClient.config.configSet({ key, value })` to save
- Display config keys in sorted order
- Show modified indicator (e.g., yellow background) for changed values
- Validate on client before sending to server
- Handle type constraints (`.type` suffix keys)
- Handle value constraints (`.values` suffix keys) - show as dropdown
- Skip displaying `.type` and `.values` keys as editable entries (they're metadata)
- Use appropriate input types: text, number, checkbox, select, textarea (for arrays/objects)

## Implementation Summary

Successfully implemented the configuration editor plugin with the following features:

**Files Created:**
- [app/src/templates/config-editor-menu-item.html](app/src/templates/config-editor-menu-item.html) - Menu item template with gear icon
- [app/src/templates/config-editor-dialog.html](app/src/templates/config-editor-dialog.html) - Dialog template with search, config list, and action buttons
- [app/src/plugins/config-editor.js](app/src/plugins/config-editor.js:1-389) - Plugin implementation with full config management

**Files Modified:**
- [app/src/plugins/toolbar.js](app/src/plugins/toolbar.js:36) - Added configEditorMenuItem to toolbarMenuPart typedef
- [app/src/ui.js](app/src/ui.js:54) - Added configEditorDialogPart import and property
- [app/src/plugins.js](app/src/plugins.js:45,64) - Registered config-editor plugin in toolbar menu items section

**Key Features Implemented:**
- Admin-only access control (menu item hidden for non-admin users)
- Search/filter functionality for config keys
- Read-only by default - values become editable only when edit button is clicked
- Type-aware value editors:
  - Dropdown select for constrained values (e.g., application.mode)
  - Checkbox for boolean values
  - Number input for numeric values
  - Read-only JSON display for complex objects
  - Comma-separated input for string arrays
  - Text input for strings
- Visual indicators for modified values (yellow background)
- Individual save/reset buttons per entry
- Pencil icon changes to check-circle when editing or modified
- Proper error handling and user notifications
- Automatic exclusion of metadata keys (`.type` and `.values` suffixes)

**API Integration:**
- Uses `client.apiClient.configList()` to load configuration
- Uses `client.apiClient.configSet({key, value})` to save individual values
- Backend validation ensures type and value constraints are enforced

**UI/UX:**
- Integrated into toolbar menu between "Manage Users & Roles" and "User Profile"
- Firefox-style table layout with three columns: Preference Name (40%), Value (50%), Actions (10%)
- Sticky table header for easy navigation
- Row hover effects for better visual feedback
- Individual save/reset buttons per entry
- Toast notifications for success/error feedback

**Value Handling:**
- String arrays converted to comma-separated format with automatic quoting when needed
- Complex objects (non-string arrays, nested objects) editable as JSON strings with validation on save
- Boolean values use checkboxes
- Numeric values use number inputs
- Constrained values use dropdown selects
- Regular strings use text inputs

**Implementation Details:**
- Read-only inputs styled with transparent borders/background and `pointer-events: none` to prevent focus
- Double-click on value cell enables editing mode
- Modified values tracked without re-rendering entire list to prevent focus loss (uses `updateRowState()`)
- JSON validation in `saveValue()` parses and validates object values before sending to API
- Uses `requestAnimationFrame()` to apply read-only styles after DOM insertion for proper Shoelace component initialization
- Comma-separated array parser handles quoted strings with escape sequences
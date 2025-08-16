# UI Panels Shoelace Web Components

A lightweight, VS Code-inspired UI panel implementation using web components. Provides horizontal layout containers including **StatusBar**, **ToolBar**, and **MenuBar** with responsive overflow management and specialized widgets. Built with, and thus requires Shoelace Components (https://shoelace.style).

## Features

- **Three Panel Types**: StatusBar (3-section), ToolBar (buttons), MenuBar (dropdowns)
- **Responsive Overflow**: Automatic priority-based hiding with overflow menus
- **Universal Widgets**: Reusable components that work across all panel types
- **Shoelace Integration**: Built on Shoelace Design System
- **Web Components**: Native custom elements with shadow DOM
- **TypeScript Ready**: Full type definitions included

## Quick Start

### Installation

```javascript
import { StatusBar, ToolBar, MenuBar, PanelUtils } from './modules/panels/index.js';
```

### Basic Usage

```javascript
// Create a status bar
const statusBar = document.createElement('status-bar');
document.body.appendChild(statusBar);

// Add widgets programmatically
const saveButton = PanelUtils.createButton({
  text: 'Save',
  icon: 'floppy',
  action: 'save'
});
statusBar.add(saveButton, 'right', 10);

// Create a toolbar
const toolBar = document.createElement('tool-bar');
toolBar.addButton({ text: 'New', icon: 'file-plus', action: 'new' }, 10);

// Create a menubar
const menuBar = document.createElement('menu-bar');
menuBar.addMenu('File', [
  { text: 'New', action: 'new' },
  { text: 'Open', action: 'open' },
  { text: 'Save', action: 'save' }
], 10);
```

## Smart Overflow Management

The ToolBar and MenuBar components support automatic overflow management that handles space constraints. Currently only works with SlButton and SlDropdown elememnts.

### Smart Overflow Attribute

Control overflow behavior using the `smart-overflow` attribute:

```html
<!-- Default: Standard flex layout -->
<tool-bar></tool-bar>
<tool-bar smart-overflow="off"></tool-bar>

<!-- Enable smart overflow with priority-based hiding -->
<tool-bar smart-overflow="on"></tool-bar>
```

**Values:**
- `"off"` (default): Uses standard CSS flexbox layout. Widgets grow/shrink naturally, with overflow clipped.
- `"on"`: Enables intelligent overflow management with priority-based hiding and dropdown menus.

### JavaScript Property

```javascript
const toolbar = document.querySelector('tool-bar');

// Check current mode
console.log(toolbar.smartOverflow); // "off" or "on"

// Change mode programmatically
toolbar.smartOverflow = "on";   // Enable smart overflow
toolbar.smartOverflow = "off";  // Revert to flex layout
```

### How Smart Overflow Works

When `smart-overflow="on"`:

1. **Priority-Based**: Widgets with lower priority values are hidden first
2. **Type-Specific**: Currently, only simple buttons and dropdown components can be moved to overflow dropdowns
3. **Complex Widgets**: Select boxes, button groups, and other complex widgets are simply hidden (not moved to dropdown)
4. **Overflow Indicators**: ToolBar shows `»` button, MenuBar shows `☰` hamburger menu
5. **Event Forwarding**: Clicks in overflow menus trigger original widget events

When `smart-overflow="off"` (default):
- Uses standard CSS flexbox layout with flexible sizing
- No JavaScript-based overflow management
- Widgets grow/shrink naturally based on available space
- Content that doesn't fit is clipped

## Panel Types

### StatusBar
Three-section horizontal panel for status information.

```javascript
const statusBar = document.createElement('status-bar');

// Add widgets to different sections
statusBar.add(fileWidget, 'left', 10);    // File info
statusBar.add(progressWidget, 'center', 5); // Build status  
statusBar.add(positionWidget, 'right', 8);  // Cursor position
```

### ToolBar  
Button-focused horizontal panel with '>>' overflow.

```javascript
const toolBar = document.createElement('tool-bar');

// Add buttons
toolBar.addButton({
  text: 'Save',
  icon: 'floppy', 
  action: 'save',
  variant: 'primary'
}, 10);

// Add any widget
toolBar.add(customButton, 5);
```

### MenuBar
Menu dropdown panel with hamburger overflow.

```javascript
const menuBar = document.createElement('menu-bar');

// Add menus
menuBar.addMenu('Edit', [
  { text: 'Undo', action: 'undo' },
  { text: 'Redo', action: 'redo' },
  { text: 'Cut', action: 'cut' }
], 9);
```

The `add()` method returns an (opaque) ID which can be used to remove the child element using `removeById()` 

## HTML Usage

You can use the components directly in HTML:

```html
<!-- StatusBar -->
<status-bar>
  <status-text text="Ready" icon="check-circle" slot="left" data-priority="10"></status-text>
  <status-progress value="75" text="Building..." slot="center" data-priority="5"></status-progress>
  <status-button text="Format" action="format" slot="right" data-priority="8"></status-button>
</status-bar>

<!-- ToolBar -->
<tool-bar>
  <sl-button size="small" data-priority="10">
    <sl-icon name="file-plus"></sl-icon>
    New
  </sl-button>
  <sl-button size="small" data-priority="9">Save</sl-button>
</tool-bar>

<!-- MenuBar -->
<menu-bar>
  <sl-dropdown data-priority="10">
    <sl-button slot="trigger" variant="text" size="small">File</sl-button>
    <sl-menu>
      <sl-menu-item>New</sl-menu-item>
      <sl-menu-item>Open</sl-menu-item>
      <sl-menu-item>Save</sl-menu-item>
    </sl-menu>
  </sl-dropdown>
</menu-bar>
```

## Widget Types

The module includes various widget components:

### Text Widget
```javascript
const textWidget = PanelUtils.createText({
  text: 'Ready',
  icon: 'check-circle',
  variant: 'success',
  tooltip: 'Application is ready'
});
```

### Status Bar Button Widget 

A button optimized for use in a status bar

```javascript
const buttonWidget = PanelUtils.createButton({
  text: 'Save',
  icon: 'floppy',
  action: 'save',
  variant: 'primary'
});
```

### Progress Widget
```javascript
const progressWidget = PanelUtils.createProgress({
  value: 65,
  max: 100,
  text: 'Building...',
  variant: 'primary'
});
```

### Dropdown Widget

A dropdown optimized for the status bar 

```javascript
const dropdownWidget = PanelUtils.createDropdown({
  placeholder: 'Select Language',
  items: [
    { value: 'js', text: 'JavaScript' },
    { value: 'ts', text: 'TypeScript' }
  ]
});
```

### Badge Widget
```javascript
const badgeWidget = PanelUtils.createBadge({
  count: 3,
  variant: 'danger',
  icon: 'exclamation-triangle',
  tooltip: 'Errors'
});
```

## Responsive Overflow

All panels support priority-based responsive overflow:

```javascript
// Higher priority = stays visible longer
statusBar.add(importantWidget, 'left', 10);  // High priority
statusBar.add(lessImportant, 'left', 5);     // Lower priority

// When space is limited, lower priority widgets are hidden first
```

- ToolBar: When buttons don't fit, they move to a '>>' dropdown menu.
- MenuBar: When menus don't fit, they move to a hamburger menu with hierarchical structure.
- StatusBar Overflow: When widgets don't fit, lower priority widgets are hidden (no overflow menu).

## Event Handling

Listen for panel events:

```javascript
// Panel actions (from widgets with action attribute)
document.addEventListener('panel-action', (e) => {
  console.log('Action:', e.detail.action);
  console.log('Widget:', e.detail.widget);
});

// Panel changes (from interactive widgets)
document.addEventListener('panel-change', (e) => {
  console.log('Value:', e.detail.value);
  console.log('Widget:', e.detail.widget);
});

// StatusBar specific events
document.addEventListener('status-action', (e) => {
  console.log('Status action:', e.detail.action);
});
```

## Priority System

Widgets are assigned priorities (higher = more important):

- **Priority 10**: Critical information (always visible)
- **Priority 5-9**: Important features  
- **Priority 1-4**: Nice-to-have features (hidden first)

## Styling

The components inherit from Shoelace design tokens:

```css
:root {
  --sl-color-primary-600: #0066cc;
  --sl-font-size-small: 0.875rem;
  /* Customize as needed */
}
```

## Examples

See the [demo](demo/index.html) for comprehensive examples including:

- Basic component usage
- Interactive widgets  
- Responsive behavior testing
- HTML-only examples
- Event handling demonstrations

## Browser Support

- Modern browsers supporting Web Components
- ES6 modules support required
- Shoelace Design System compatibility

## Dependencies

- [Shoelace Design System](https://shoelace.style/) - UI components and styling

## Acknowledgements and License

This module was generated using Claude Code from prompts by @cboulanger. The code is therefore in the Public Domain.


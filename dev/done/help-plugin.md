# Help Plugin Implementation Plan

## Overview

Create an interactive help widget that displays contextual help topics in a radial menu. Plugins can register topics that appear when users click the help icon.

## Technical Requirements

### Plugin Structure

**File:** `app/src/plugins/help.js`

**Dependencies:** None (base plugin)

**Type:** Plugin class extending `Plugin` from `app/src/modules/plugin-base.js`

### Plugin-Specific State

State stored as class properties (not in application state):

```javascript
class HelpPlugin extends Plugin {
  /** @type {Array<{id: string, label: string, icon: string, callback: Function}>} */
  topics = [];

  /** @type {boolean} */
  menuVisible = false;
}
```

### Public API

```javascript
class HelpPlugin extends Plugin {
  /**
   * Register a help topic
   * @param {string} label - Topic display name
   * @param {string} icon - Shoelace icon name
   * @param {Function} callback - Handler when topic is selected
   * @returns {string} Topic ID for later removal
   */
  registerTopic(label, icon, callback) {}

  /**
   * Unregister a help topic
   * @param {string} topicId - ID returned from registerTopic
   */
  unregisterTopic(topicId) {}
}
```

Export singleton instance for other plugins:
```javascript
// In app/src/app.js
export const helpPlugin = HelpPlugin.getInstance();
```

## UI Components

### Help Icon

**Element:** `<sl-icon>` with tooltip wrapper
**Parent:** `#editors` container
**Position:** Fixed bottom-right
**Attributes:**
- `name`: `"helpIcon"`
- Shoelace icon: `"question-circle"`
- Tooltip: "Get help"

**Visibility:** Only shown if topics registered (`this.topics.length > 0`)

### Topics Menu

**Container:** Custom `<div>` with topic boxes
**Layout:** Quarter circle radiating top-left from help icon
**Animation:** Fade in with radial expansion

**Topic Box:**
- Rounded corners
- Drop shadow
- Contains icon + label
- Click triggers callback then hides menu

## CSS Styling

Add to `app/web/app.css`:

```css
/* Help icon */
#help-icon {
  position: fixed;
  bottom: 20px;
  right: 20px;
  font-size: 50px;
  filter: drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
  opacity: 0.5;
  transition: opacity 0.3s ease;
  cursor: pointer;
  z-index: 1000;
  display: none;
}

#help-icon:hover {
  opacity: 1;
}

/* Topics container */
#help-topics {
  position: fixed;
  bottom: 20px;
  right: 20px;
  pointer-events: none;
  z-index: 999;
}

#help-topics.visible {
  pointer-events: auto;
}

/* Individual topic */
.help-topic {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 15px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);
  cursor: pointer;
  opacity: 0;
  transform: scale(0);
  transition: all 0.3s ease;
  white-space: nowrap;
}

.help-topic.visible {
  opacity: 1;
  transform: scale(1);
}

.help-topic:hover {
  background: var(--sl-color-neutral-100);
}

.help-topic sl-icon {
  font-size: 20px;
}

.help-topic span {
  font-size: 14px;
  font-weight: 500;
}

/* Connection lines */
.help-topic-line {
  position: absolute;
  background: var(--sl-color-neutral-400);
  height: 2px;
  transform-origin: right center;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.help-topic-line.visible {
  opacity: 0.5;
}
```

## HTML Template

**File:** `app/src/templates/help-widget.html`

```html
<sl-tooltip content="Get help">
  <sl-icon name="helpIcon" library="default" class="question-circle"></sl-icon>
</sl-tooltip>
<div name="topicsContainer" class="help-topics"></div>
```

## Implementation Steps

### 1. Create Plugin Class

**File:** `app/src/plugins/help.js`

- Extend `Plugin` base class
- Initialize with `name: 'help'`, no dependencies
- Initialize class properties: `this.topics = []`, `this.menuVisible = false`
- Implement `install()` method:
  - Register template `help-widget.html`
  - Create widget from template
  - Append to `#editors` container
  - Set up click handler on icon
  - Initially hide icon (no topics yet)

### 2. Implement Topic Registration

```javascript
registerTopic(label, icon, callback) {
  const topicId = `topic-${Date.now()}-${Math.random()}`;
  this.topics.push({ id: topicId, label, icon, callback });
  this.updateIconVisibility();
  return topicId;
}

unregisterTopic(topicId) {
  this.topics = this.topics.filter(t => t.id !== topicId);
  this.updateIconVisibility();
}

updateIconVisibility() {
  ui.editors.helpIcon.style.display =
    this.topics.length > 0 ? 'block' : 'none';
}
```

### 3. Implement Menu Rendering

```javascript
renderTopicsMenu() {
  const container = ui.editors.topicsContainer;
  container.innerHTML = '';

  // Calculate positions in quarter circle
  const radius = 150;
  const angleStep = (Math.PI / 2) / (this.topics.length - 1 || 1);

  this.topics.forEach((topic, index) => {
    const angle = index * angleStep;
    const x = -Math.cos(angle) * radius;
    const y = -Math.sin(angle) * radius;

    // Create topic box
    const box = document.createElement('div');
    box.className = 'help-topic';
    box.style.bottom = `${80 - y}px`;
    box.style.right = `${80 - x}px`;

    box.innerHTML = `
      <sl-icon name="${topic.icon}"></sl-icon>
      <span>${topic.label}</span>
    `;

    box.addEventListener('click', () => {
      this.hideTopicsMenu();
      topic.callback();
    });

    container.appendChild(box);

    // Create connection line
    const line = document.createElement('div');
    line.className = 'help-topic-line';
    line.style.bottom = `${80 - y/2}px`;
    line.style.right = `${80 - x/2}px`;
    line.style.width = `${Math.sqrt(x*x + y*y) / 2}px`;
    line.style.transform = `rotate(${-angle}rad)`;
    container.appendChild(line);

    // Trigger animation
    requestAnimationFrame(() => {
      box.classList.add('visible');
      line.classList.add('visible');
    });
  });

  container.classList.add('visible');
  this.menuVisible = true;
}

hideTopicsMenu() {
  const container = ui.editors.topicsContainer;
  container.querySelectorAll('.help-topic, .help-topic-line')
    .forEach(el => el.classList.remove('visible'));

  setTimeout(() => {
    container.innerHTML = '';
    container.classList.remove('visible');
    this.menuVisible = false;
  }, 300);
}
```

### 4. Icon Click Handler

```javascript
async install(state) {
  await super.install(state);

  await registerTemplate('help-widget', 'help-widget.html');
  const widget = createFromTemplate('help-widget', ui.editors);

  // Initially hidden
  ui.editors.helpIcon.style.display = 'none';

  ui.editors.helpIcon.addEventListener('click', () => {
    if (this.menuVisible) {
      this.hideTopicsMenu();
    } else {
      this.renderTopicsMenu();
    }
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (this.menuVisible &&
        !ui.editors.helpIcon.contains(e.target) &&
        !ui.editors.topicsContainer.contains(e.target)) {
      this.hideTopicsMenu();
    }
  });
}
```

### 5. Register Plugin

**File:** `app/src/app.js`

Add to plugins array (before info plugin):
```javascript
const plugins = [
  // ... other plugins
  HelpPlugin,
  InfoPlugin,  // Now depends on help
  // ...
];

// Export singleton
export const helpPlugin = HelpPlugin.getInstance();
```

### 6. Update Info Plugin

**File:** `app/src/plugins/info.js`

```javascript
import { helpPlugin } from '../app.js';

class InfoPlugin extends Plugin {
  constructor(context) {
    super(context, {
      name: 'info',
      deps: ['help']  // Add dependency
    });
  }

  async install(state) {
    await super.install(state);

    // Register user manual topic
    this.helpTopicId = helpPlugin.registerTopic(
      'User Manual',
      'book',
      () => {
        ui.infoDrawer.show();
      }
    );

    // Rest of existing install code...
  }
}
```

### 7. UI Type Definitions

**File:** `app/src/plugins/help.js`

Add JSDoc typedef:
```javascript
/**
 * @typedef HelpWidgetElements
 * @property {import('../ui.js').SlIcon} helpIcon - Help question mark icon
 * @property {HTMLDivElement} topicsContainer - Container for topic boxes
 */
```

**File:** `app/src/ui.js`

Add import and extend editors typedef:
```javascript
/**
 * @import { HelpWidgetElements } from './plugins/help.js'
 */

/**
 * @typedef EditorsPart
 * @property {HTMLDivElement} editors
 * @property {PdfViewerElements} pdfViewer
 * @property {XmlEditorElements} xmlEditor
 * @property {HelpWidgetElements} helpWidget
 */
```

Update the property access pattern in typedef (help widget elements are direct children of editors):
```javascript
/**
 * @typedef EditorsPart
 * @property {HTMLDivElement} editors
 * @property {PdfViewerElements} pdfViewer
 * @property {XmlEditorElements} xmlEditor
 * @property {import('../ui.js').SlIcon} helpIcon
 * @property {HTMLDivElement} topicsContainer
 */
```

## Testing Checklist

- [ ] Help icon hidden when no topics registered
- [ ] Help icon visible with correct styling after topic registration
- [ ] Icon opacity changes on hover
- [ ] Topics menu shows on icon click
- [ ] Topics positioned in quarter circle
- [ ] Connection lines render correctly
- [ ] Topic boxes animate in/out
- [ ] Clicking topic executes callback and hides menu
- [ ] Clicking outside menu closes it
- [ ] Multiple topics can be registered
- [ ] Topics can be unregistered
- [ ] Info plugin's user manual topic works

## Future Enhancements

- Support for categorized topics (collapsible groups)
- Keyboard navigation (arrow keys, escape to close)
- Topic search/filter
- Persistent topic order preferences
- Animation customization options

## Implementation Summary

The help plugin has been implemented with the following changes:

**Files Created:**
- [app/src/plugins/help.js](app/src/plugins/help.js) - HelpPlugin class with topic registration and radial menu rendering
- [app/src/templates/help-widget.html](app/src/templates/help-widget.html) - HTML template for help icon and topics container

**Files Modified:**
- [app/web/app.css](app/web/app.css:352-432) - Added CSS styling for help icon, topics menu, connection lines, and animations
- [app/src/plugins.js](app/src/plugins.js:17,65,102) - Imported and registered HelpPlugin, exported for use by other plugins
- [app/src/app.js](app/src/app.js:18,50) - Imported HelpPlugin and exported helpPlugin singleton
- [app/src/plugins/info.js](app/src/plugins/info.js:15,36,204-209) - Added help dependency and registered "User Manual" topic
- [app/src/ui.js](app/src/ui.js:45,75-76) - Added type imports and UI element typedefs for helpIcon and topicsContainer

**Implementation Details:**
- Help icon displays at bottom-right with 50% opacity when not hovered, becoming fully visible on hover
- Icon only appears when at least one topic has been registered
- Clicking the icon shows topics in a quarter-circle layout radiating to the top-left
- Topics are connected to the help icon with animated lines
- Clicking a topic executes its callback and hides the menu
- Clicking outside the menu closes it
- Info plugin registers "User Manual" topic that opens the info drawer
- All state is stored in plugin class properties (not application state)

The plugin is fully functional and ready for other plugins to register their own help topics using `helpPlugin.registerTopic(label, icon, callback)`.

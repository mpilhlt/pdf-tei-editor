/**
 * Modern UI Panels Module
 * 
 * A lightweight, VS Code-inspired UI panel implementation using web components.
 * Provides horizontal layout containers including StatusBar, ToolBar, and MenuBar
 * with responsive overflow management and specialized widgets.
 * 
 * @example
 * ```javascript
 * import { StatusBar, ToolBar, MenuBar, StatusText, StatusButton } from './modules/panels/index.js';
 * 
 * // Create a status bar
 * const statusBar = document.createElement('status-bar');
 * document.body.appendChild(statusBar);
 * 
 * const textWidget = document.createElement('status-text');
 * textWidget.text = 'Ready';
 * textWidget.icon = 'check-circle';
 * statusBar.addWidget(textWidget, 'left', 10);
 * 
 * // Create a toolbar
 * const toolBar = document.createElement('tool-bar');
 * toolBar.addButton({ text: 'Save', icon: 'save', action: 'save' }, 10);
 * 
 * // Create a menubar
 * const menuBar = document.createElement('menu-bar');
 * menuBar.addMenu('File', [
 *   { text: 'New', action: 'new' },
 *   { text: 'Open', action: 'open' }
 * ], 10);
 * ```
 */

// Import all components
import { BasePanel } from './base-panel.js';
import { StatusBar } from './status-bar.js';
import { ToolBar } from './tool-bar.js';
import { MenuBar } from './menu-bar.js';
import { StatusText } from './widgets/status-text.js';
import { StatusButton } from './widgets/status-button.js';
import { StatusProgress } from './widgets/status-progress.js';
import { StatusBadge } from './widgets/status-badge.js';
import { StatusDropdown } from './widgets/status-dropdown.js';
import { StatusSeparator } from './widgets/status-separator.js';
import { StatusSwitch } from './widgets/status-switch.js';

/**
 * Helper function to create and configure a widget
 * Note: Should only be called after custom elements are defined
 */
function createWidget(tagName, options = {}) {
  const widget = document.createElement(tagName);
  
  // Apply options immediately after creation
  Object.keys(options).forEach(key => {
    const value = options[key];
    if (value !== undefined) {
      try {
        if (typeof value === 'boolean' && value) {
          const attrName = key === 'hideMobile' ? 'hide-mobile' : 
                          key === 'hiddenWhenZero' ? 'hidden-when-zero' : key;
          widget.setAttribute(attrName, '');
        } else if (typeof value !== 'boolean') {
          // Handle special attribute name mappings
          const attrName = key === 'helpText' ? 'help-text' : key;
          widget.setAttribute(attrName, value.toString());
        }
      } catch (e) {
        // Ignore setAttribute errors for unsupported operations
        console.warn(`Could not set attribute ${key} on ${tagName}:`, e.message);
      }
    }
  });
  
  return widget;
}

/**
 * Utility functions for creating panel widgets
 * Compatible with StatusBar, ToolBar, and MenuBar components
 */
const PanelUtils = {
  /**
   * Create a text widget with the given properties
   * @param {Object} options - Widget options
   * @param {string} options.text - Text to display
   * @param {string} [options.icon] - Optional icon name
   * @param {string} [options.tooltip] - Optional tooltip
   * @param {string} [options.variant] - Optional variant (error, warning, success)
   * @param {boolean} [options.clickable] - Whether the widget is clickable
   * @returns {StatusText}
   */
  createText(options = {}) {
    return createWidget('status-text', options);
  },

  /**
   * Create a button widget with the given properties
   * @param {Object} options - Widget options
   * @param {string} [options.text] - Button text
   * @param {string} [options.icon] - Button icon
   * @param {string} [options.tooltip] - Button tooltip
   * @param {string} [options.action] - Action identifier
   * @param {string} [options.variant] - Button variant
   * @param {boolean} [options.disabled] - Whether button is disabled
   * @returns {StatusButton}
   */
  createButton(options = {}) {
    return createWidget('status-button', options);
  },

  /**
   * Create a progress widget with the given properties
   * @param {Object} options - Widget options
   * @param {number} [options.value] - Current progress value
   * @param {number} [options.max] - Maximum progress value
   * @param {string} [options.text] - Progress text
   * @param {boolean} [options.indeterminate] - Whether progress is indeterminate
   * @param {string} [options.variant] - Progress variant
   * @returns {StatusProgress}
   */
  createProgress(options = {}) {
    return createWidget('status-progress', options);
  },

  /**
   * Create a badge widget with the given properties
   * @param {Object} options - Widget options
   * @param {number} [options.count] - Badge count
   * @param {string} [options.text] - Badge text (alternative to count)
   * @param {string} [options.variant] - Badge variant
   * @param {string} [options.icon] - Badge icon
   * @param {number} [options.max] - Maximum count display
   * @param {boolean} [options.clickable] - Whether badge is clickable
   * @param {boolean} [options.dot] - Show as dot instead of count
   * @param {boolean} [options.pulse] - Enable pulse animation
   * @param {boolean} [options.hiddenWhenZero] - Hide when count is zero
   * @returns {StatusBadge}
   */
  createBadge(options = {}) {
    return createWidget('status-badge', options);
  },

  /**
   * Create a dropdown widget with the given properties
   * @param {Object} options - Widget options
   * @param {string} [options.text] - Dropdown text
   * @param {string} [options.placeholder] - Placeholder text
   * @param {string} [options.selected] - Selected value
   * @param {Array} [options.items] - Dropdown items
   * @param {boolean} [options.disabled] - Whether dropdown is disabled
   * @returns {StatusDropdown}
   */
  createDropdown(options = {}) {
    const { items, ...attrs } = options;
    const widget = createWidget('status-dropdown', attrs);
    
    // Handle items specially
    if (items && Array.isArray(items)) {
      if (widget.setItems) {
        widget.setItems(items);
      }
    }

    return widget;
  },

  /**
   * Create a separator widget with the given properties
   * @param {Object} options - Widget options
   * @param {string} [options.variant] - Separator variant (vertical, horizontal, dotted, space)
   * @param {string} [options.spacing] - Separator spacing (tight, normal, loose)
   * @param {boolean} [options.hideMobile] - Whether to hide on mobile
   * @returns {StatusSeparator}
   */
  createSeparator(options = {}) {
    return createWidget('status-separator', options);
  },

  /**
   * Create a switch widget with the given properties
   * @param {Object} options - Widget options
   * @param {string} [options.text] - Switch label text
   * @param {string} [options.helpText] - Help text shown to the right
   * @param {boolean} [options.checked] - Whether switch is checked
   * @param {boolean} [options.disabled] - Whether switch is disabled
   * @param {string} [options.size] - Switch size (small, medium, large)
   * @param {string} [options.name] - Name attribute for UI element lookup
   * @returns {StatusSwitch}
   */
  createSwitch(options = {}) {
    return createWidget('status-switch', options);
  }
};

/**
 * Main status bar factory function
 * @returns {StatusBar} A new status bar instance
 */
function createStatusBar() {
  return document.createElement('status-bar');
}

/**
 * ToolBar factory function
 * @returns {ToolBar} A new toolbar instance
 */
function createToolBar() {
  return document.createElement('tool-bar');
}

/**
 * MenuBar factory function
 * @returns {MenuBar} A new menubar instance
 */
function createMenuBar() {
  return document.createElement('menu-bar');
}

// Export all components and utilities
export {
  BasePanel,
  StatusBar,
  ToolBar,
  MenuBar,
  StatusText,
  StatusButton,
  StatusProgress,
  StatusBadge,
  StatusDropdown,
  StatusSeparator,
  StatusSwitch,
  PanelUtils,
  createStatusBar,
  createToolBar,
  createMenuBar
};

// Default export for convenience
export default {
  BasePanel,
  StatusBar,
  ToolBar,
  MenuBar,
  StatusText,
  StatusButton,
  StatusProgress,
  StatusBadge,
  StatusDropdown,
  StatusSeparator,
  StatusSwitch,
  PanelUtils,
  createStatusBar,
  createToolBar,
  createMenuBar
};
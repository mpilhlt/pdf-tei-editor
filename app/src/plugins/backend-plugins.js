/**
 * Backend Plugins Integration Plugin
 *
 * Discovers and executes backend plugins through a toolbar dropdown.
 * Organizes plugins by category and manages execution UI.
 */

import { Plugin } from '../modules/plugin-base.js';
import { api } from './client.js';
import { notify } from '../modules/sl-utils.js';
import { registerTemplate, createFromTemplate, createSingleFromTemplate, updateUi, SlDropdown, SlButton, SlMenu } from '../ui.js';
import ui from '../ui.js';

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { BackendPlugin } from './client.js'
 */

/**
 * Backend plugins button group UI structure
 * @typedef {object} backendPluginsButtonPart
 * @property {SlDropdown} pluginsDropdown - The dropdown containing the plugins menu
 * @property {SlButton} pluginsBtn - The button that triggers the dropdown
 * @property {SlMenu} pluginsMenu - The menu containing plugin items
 */

// Register template
await registerTemplate('backend-plugins-button', 'backend-plugins-button.html');

export class BackendPluginsPlugin extends Plugin {
  constructor(context) {
    super(context, {
      name: 'backend-plugins',
      deps: ['client', 'authentication']
    });

    /** @type {BackendPlugin[]} */
    this.plugins = [];

    /** @type {boolean} */
    this.initialized = false;
  }

  async install(initialState) {
    await super.install(initialState);

    // Add button to toolbar before the logout button
    const buttonElement = createSingleFromTemplate('backend-plugins-button');
    ui.toolbar.insertBefore(buttonElement, ui.toolbar.logoutButton);
    updateUi();
  }

  async start() {
    // Discover available plugins
    await this.discoverPlugins();

    // Setup UI if plugins are available
    if (this.plugins.length > 0) {
      this.setupUI();
      this.initialized = true;
    }
  }

  async onStateUpdate(changedKeys) {
    // Show/hide plugin button based on login state
    if (changedKeys.includes('sessionId')) {
      await this.discoverPlugins();

      if (this.plugins.length > 0 && !this.initialized) {
        this.setupUI();
        this.initialized = true;
      } else if (this.plugins.length === 0 && this.initialized) {
        this.hideUI();
        this.initialized = false;
      } else if (this.plugins.length > 0 && this.initialized) {
        // Refresh plugin list
        this.populateMenu();
      }
    }
  }

  /**
   * Discover available backend plugins from the server
   */
  async discoverPlugins() {
    try {
      this.plugins = await api.getBackendPlugins();
    } catch (error) {
      console.error('Failed to discover backend plugins:', error);
      this.plugins = [];
    }
  }

  /**
   * Setup UI elements and event handlers
   */
  setupUI() {
    // Show the button group
    ui.toolbar.backendPluginsGroup.style.display = 'inline-flex';

    // Populate menu with plugins
    this.populateMenu();

    // Setup event handler for menu item clicks
    // Note: Using querySelector here because Shoelace components use Shadow DOM
    const pluginsMenu = ui.toolbar.backendPluginsGroup.querySelector('[name="pluginsMenu"]');
    pluginsMenu.addEventListener('sl-select', (event) => {
      this.handlePluginSelection(event);
    });
  }

  /**
   * Hide the plugin UI
   */
  hideUI() {
    ui.toolbar.backendPluginsGroup.style.display = 'none';
  }

  /**
   * Populate the dropdown menu with plugins organized by category
   */
  populateMenu() {
    // Note: Using querySelector here because Shoelace components use Shadow DOM
    const pluginsMenu = ui.toolbar.backendPluginsGroup.querySelector('[name="pluginsMenu"]');

    // Clear existing items
    pluginsMenu.innerHTML = '';

    // Group plugins by category
    const pluginsByCategory = this.groupPluginsByCategory();

    // Add menu items for each category
    const categories = Object.keys(pluginsByCategory).sort();

    categories.forEach((category, index) => {
      // Add category label
      const categoryLabel = document.createElement('small');
      categoryLabel.textContent = this.formatCategoryName(category);
      pluginsMenu.appendChild(categoryLabel);

      // Add plugins in this category
      pluginsByCategory[category].forEach(plugin => {
        const menuItem = document.createElement('sl-menu-item');
        menuItem.setAttribute('data-plugin-id', plugin.id);
        menuItem.setAttribute('data-plugin-category', plugin.category);
        menuItem.textContent = plugin.name;

        // Add description as tooltip if available
        if (plugin.description) {
          menuItem.title = plugin.description;
        }

        pluginsMenu.appendChild(menuItem);
      });

      // Add divider between categories (except after last one)
      if (index < categories.length - 1) {
        const divider = document.createElement('sl-divider');
        pluginsMenu.appendChild(divider);
      }
    });
  }

  /**
   * Group plugins by category
   * @returns {Record<string, BackendPlugin[]>}
   */
  groupPluginsByCategory() {
    const grouped = {};

    this.plugins.forEach(plugin => {
      const category = plugin.category || 'other';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(plugin);
    });

    // Sort plugins within each category by name
    Object.keys(grouped).forEach(category => {
      grouped[category].sort((a, b) => a.name.localeCompare(b.name));
    });

    return grouped;
  }

  /**
   * Format category name for display
   * @param {string} category
   * @returns {string}
   */
  formatCategoryName(category) {
    // Capitalize first letter and replace hyphens with spaces
    return category
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Handle plugin selection from dropdown
   * @param {CustomEvent} event
   */
  async handlePluginSelection(event) {
    const menuItem = event.detail.item;
    const pluginId = menuItem.getAttribute('data-plugin-id');

    if (!pluginId) {
      return;
    }

    // Find the plugin
    const plugin = this.plugins.find(p => p.id === pluginId);
    if (!plugin) {
      notify('Plugin not found', 'danger', 'exclamation-octagon');
      return;
    }

    // Execute the plugin
    await this.executePlugin(plugin);
  }

  /**
   * Execute a backend plugin
   * @param {BackendPlugin} plugin
   */
  async executePlugin(plugin) {
    try {
      // Show loading notification
      notify(`Executing ${plugin.name}...`, 'primary', 'hourglass');

      // For now, execute the default 'execute' endpoint with empty params
      // In the future, this could show a dialog to collect parameters
      const result = await api.executeBackendPlugin(plugin.id, 'execute', {
        text: 'This is a test text for the sample analyzer plugin.'
      });

      // Show result notification
      notify(`${plugin.name} completed successfully`, 'success', 'check-circle');

      // Display result (for now just log it, could show in modal)
      console.log('Plugin execution result:', result);

      // TODO: Show result in a modal dialog or side panel
      this.displayResult(plugin, result);

    } catch (error) {
      console.error(`Error executing plugin ${plugin.id}:`, error);
      notify(`Failed to execute ${plugin.name}: ${error.message}`, 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Display plugin execution result
   * @param {BackendPlugin} plugin
   * @param {any} result
   */
  displayResult(plugin, result) {
    // For now, just show an alert with JSON result
    // TODO: Create a proper result display modal/panel
    const resultText = JSON.stringify(result, null, 2);

    // Use browser alert for now (replace with proper modal later)
    alert(`${plugin.name} Result:\n\n${resultText}`);
  }
}

export default BackendPluginsPlugin;

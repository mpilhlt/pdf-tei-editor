/**
 * Backend Plugins Integration Plugin
 *
 * Discovers and executes backend plugins through a toolbar dropdown.
 * Organizes plugins by category and manages execution UI.
 */

import { Plugin } from '../modules/plugin-base.js';
import { api } from './client.js';
import { notify } from '../modules/sl-utils.js';
import { PluginSandbox } from '../modules/backend-plugin-sandbox.js';
import { registerTemplate, createSingleFromTemplate, updateUi, SlDropdown, SlButton, SlMenu } from '../ui.js';
import ui from '../ui.js';
import { logger } from '../app.js';

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

/**
 * Backend plugins result dialog UI structure
 * @typedef {object} backendPluginsResultDialogPart
 * @property {HTMLDivElement} icon - Icon container
 * @property {HTMLDivElement} content - Content container
 * @property {SlButton} openWindowBtn - Open in new window button
 * @property {SlButton} exportBtn - Export button
 * @property {SlButton} executeBtn - Execute button
 * @property {SlButton} closeBtn - Close button
 */

// Register templates
await registerTemplate('backend-plugins-button', 'backend-plugins-button.html');
await registerTemplate('backend-plugins-result-dialog', 'backend-plugins-result-dialog.html');

export class BackendPluginsPlugin extends Plugin {
  /**
   * Constructor
   * @param {PluginContext} context 
   */
  constructor(context) {
    super(context, {
      name: 'backend-plugins',
      deps: ['client','extraction']
    });

    /** @type {BackendPlugin[]} */
    this.plugins = [];

    /** @type {boolean} */
    this.initialized = false;

    /** @type {PluginSandbox|null} */
    this.pluginSandbox = null;
  }

  /**
   * Installs the plugin
   * @param {ApplicationState} initialState
   */
  async install(initialState) {
    await super.install(initialState);

    // Add result dialog to document body
    const dialogElement = createSingleFromTemplate('backend-plugins-result-dialog');
    document.body.appendChild(dialogElement);

    updateUi();

    // Create plugin sandbox once
    this.pluginSandbox = new PluginSandbox(this.context, ui.pluginResultDialog);
    window.pluginSandbox = this.pluginSandbox;

    // Setup close button handler
    ui.pluginResultDialog.closeBtn.addEventListener('click', () => ui.pluginResultDialog.hide());
  }

  async start() {

    // Add button to toolbar before the logout button
    const buttonElement = createSingleFromTemplate('backend-plugins-button');
    ui.toolbar.add(buttonElement, 0, -2)
    updateUi();

    // Discover available plugins
    await this.discoverPlugins();

    // Setup UI if plugins are available
    if (this.plugins.length > 0) {
      this.setupUI();
      this.initialized = true;
    }
  }

  /**
   * Reacts to state updates
   * @param {Array<String>} changedKeys 
   */
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
      // Skip if no plugins in a category
      if (pluginsByCategory[category].length === 0) {
        return;
      }

      // Add category label
      const categoryLabel = document.createElement('small');
      categoryLabel.textContent = this.formatCategoryName(category);
      pluginsMenu.appendChild(categoryLabel);

      // Add plugins in this category
      pluginsByCategory[category].forEach(plugin => {
        // Check if plugin defines endpoints
        const endpoints = plugin.endpoints || [
          { name: 'execute', label: plugin.name, state_params: [] }
        ];

        endpoints.forEach(endpoint => {
          const menuItem = document.createElement('sl-menu-item');
          menuItem.dataset.pluginId = plugin.id;
          menuItem.dataset.endpointName = endpoint.name;
          menuItem.dataset.stateParams = JSON.stringify(endpoint.state_params);
          menuItem.textContent = endpoint.label;

          // Add description as tooltip if available
          if (endpoint.description) {
            menuItem.title = endpoint.description;
          }

          pluginsMenu.appendChild(menuItem);
        });
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
   * Call a plugin API endpoint with authentication
   * @param {string} endpoint - Plugin endpoint path (e.g., '/api/plugins/my-plugin/custom')
   * @param {string} method - HTTP method (GET, POST, etc.)
   * @param {object|null} params - Query params (for GET) or request body (for POST/PUT/etc)
   * @returns {Promise<Response>} Fetch Response object
   */
  async callPluginApi(endpoint, method = 'GET', params = null) {
    const url = new URL(endpoint, window.location.origin);

    const options = {
      method,
      headers: {
        'X-Session-ID': this.state.sessionId || '',
      }
    };

    // Handle params based on method
    if (params) {
      if (method === 'GET') {
        // Add as query parameters
        Object.entries(params).forEach(([key, value]) => {
          if (value !== null && value !== undefined) {
            url.searchParams.append(key, String(value));
          }
        });
      } else {
        // Add as JSON body for POST/PUT/etc
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(params);
      }
    }

    const response = await fetch(url.toString(), options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Plugin API error (${response.status}): ${errorText}`);
    }

    return response;
  }

  /**
   * Handle plugin selection from dropdown
   * @param {CustomEvent} event
   */
  async handlePluginSelection(event) {
    const menuItem = event.detail.item;
    const pluginId = menuItem.dataset.pluginId;
    const endpointName = menuItem.dataset.endpointName;
    const stateParams = JSON.parse(menuItem.dataset.stateParams || '[]');

    if (!pluginId || !endpointName) {
      return;
    }

    // Find the plugin
    const plugin = this.plugins.find(p => p.id === pluginId);
    if (!plugin) {
      notify('Plugin not found', 'danger', 'exclamation-octagon');
      return;
    }

    // Extract required state values
    const params = {};
    stateParams.forEach(param => {
      if (this.state[param] !== undefined) {
        params[param] = this.state[param];
      } else {
        console.warn(`Required state parameter '${param}' not available`);
      }
    });

    // Execute the plugin with the specified endpoint
    await this.executePlugin(plugin, endpointName, params);
  }

  /**
   * Execute a backend plugin
   * @param {BackendPlugin} plugin
   * @param {string} endpointName - Endpoint to execute
   * @param {Record<string, any>} params - Parameters to pass to the endpoint
   */
  async executePlugin(plugin, endpointName, params) {
    try {
     
      // Execute the specified endpoint with provided params
      const result = await api.executeBackendPlugin(plugin.id, endpointName, params);
      // Display the result according to content
      this.displayResult(plugin, result);

    } catch (error) {
      console.error(`Error executing plugin ${plugin.id}:`, error);
      notify(`Failed to execute ${plugin.name}: ${error.message}`, 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Display plugin result in an iframe
   * @param {BackendPlugin} plugin
   * @param {any} result - Must include outputUrl property
   */
  displayResultInIframe(plugin, result) {
    const dialog = ui.pluginResultDialog;

    // Configure dialog
    dialog.setAttribute("label", plugin.name);
    dialog.style.setProperty("--width", "90vw");
    dialog.icon.innerHTML = '';

    // Create iframe with authentication
    const iframe = document.createElement('iframe');
    const outputUrl = new URL(result.outputUrl, window.location.origin);

    // Add session ID if not already in URL
    if (!outputUrl.searchParams.has('session_id') && this.state.sessionId) {
      outputUrl.searchParams.set('session_id', this.state.sessionId);
    }

    const fullUrl = outputUrl.toString();
    iframe.src = fullUrl;
    iframe.style.width = '100%';
    iframe.style.height = '60vh';
    iframe.style.border = 'none';

    dialog.content.innerHTML = '';
    dialog.content.appendChild(iframe);

    // Configure "Open in new window" button
    dialog.openWindowBtn.style.display = 'inline-flex';
    const newOpenWindowBtn = dialog.openWindowBtn.cloneNode(true);
    dialog.openWindowBtn.replaceWith(newOpenWindowBtn);
    updateUi();

    ui.pluginResultDialog.openWindowBtn.addEventListener('click', () => {
      window.open(fullUrl, '_blank', 'width=1200,height=800');
    });

    this.configureExportButton(dialog, plugin, result);
    this.configureExecuteButton(dialog, result);
    dialog.show();
  }

  /**
   * Configure export button for plugin result
   * @param {SlDialog} dialog
   * @param {BackendPlugin} plugin
   * @param {any} result
   */
  configureExportButton(dialog, plugin, result) {
    if (result.exportUrl || result.pdf) {
      dialog.exportBtn.style.display = 'inline-flex';

      const newExportBtn = dialog.exportBtn.cloneNode(true);
      dialog.exportBtn.replaceWith(newExportBtn);
      updateUi();

      ui.pluginResultDialog.exportBtn.addEventListener('click', async () => {
        try {
          let exportUrl;

          if (result.exportUrl) {
            exportUrl = result.exportUrl;
          } else if (result.pdf) {
            const variant = result.variant || 'all';
            const endpoint = `/api/plugins/${plugin.id}/export`;
            const params = { pdf: result.pdf, variant: variant };
            const url = new URL(endpoint, window.location.origin);
            Object.entries(params).forEach(([key, value]) => {
              if (value !== null && value !== undefined) {
                url.searchParams.append(key, String(value));
              }
            });
            exportUrl = url.toString();
          }

          const response = await fetch(exportUrl, {
            headers: { 'X-Session-ID': this.state.sessionId || '' }
          });

          if (!response.ok) {
            throw new Error(`Export failed: ${response.statusText}`);
          }

          const blob = await response.blob();
          const contentDisposition = response.headers.get('Content-Disposition');
          let filename = `${plugin.id}_export.csv`;
          if (contentDisposition) {
            const match = contentDisposition.match(/filename="?(.+?)"?$/);
            if (match) filename = match[1];
          }

          const downloadUrl = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.URL.revokeObjectURL(downloadUrl);

          notify('Export successful', 'success', 'check-circle');
        } catch (error) {
          console.error('Export failed:', error);
          notify(`Export failed: ${error.message}`, 'danger', 'exclamation-octagon');
        }
      });
    } else {
      dialog.exportBtn.style.display = 'none';
    }
  }

  /**
   * Configure execute button for plugin result
   * @param {SlDialog} dialog
   * @param {any} result
   */
  configureExecuteButton(dialog, result) {
    if (result.executeUrl) {
      dialog.executeBtn.style.display = 'inline-flex';

      const newExecuteBtn = dialog.executeBtn.cloneNode(true);
      dialog.executeBtn.replaceWith(newExecuteBtn);
      updateUi();

      ui.pluginResultDialog.executeBtn.addEventListener('click', async () => {
        try {
          // Build execute URL with authentication
          const executeUrl = new URL(result.executeUrl, window.location.origin);

          // Add session ID if not already in URL
          if (!executeUrl.searchParams.has('session_id') && this.state.sessionId) {
            executeUrl.searchParams.set('session_id', this.state.sessionId);
          }

          // Load execute result in the same iframe
          const iframe = ui.pluginResultDialog.content.querySelector('iframe');
          if (iframe) {
            iframe.src = executeUrl.toString();
          }

          // Hide execute button after clicking
          ui.pluginResultDialog.executeBtn.style.display = 'none';

          notify('Executing...', 'primary', 'info-circle');
        } catch (error) {
          console.error('Execute failed:', error);
          notify(`Execute failed: ${error.message}`, 'danger', 'exclamation-octagon');
        }
      });
    } else {
      dialog.executeBtn.style.display = 'none';
    }
  }

  /**
   * Trigger a file download from a URL
   * @param {BackendPlugin} plugin
   * @param {string} downloadUrl - URL to download from
   */
  async triggerDownload(plugin, downloadUrl) {
    try {
      const url = new URL(downloadUrl, window.location.origin);

      // Add session ID if not already in URL
      if (!url.searchParams.has('session_id') && this.state.sessionId) {
        url.searchParams.set('session_id', this.state.sessionId);
      }

      const response = await fetch(url.toString(), {
        headers: { 'X-Session-ID': this.state.sessionId || '' }
      });

      if (!response.ok) {
        // Status 499 = cancelled by user, don't show error (notification already sent via SSE)
        if (response.status === 499) {
          logger.info('Download cancelled by user');
          return;
        }
        throw new Error(`Download failed: ${response.statusText}`);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `${plugin.id}_download`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?(.+?)"?$/);
        if (match) filename = match[1];
      }

      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);

      notify('Download started', 'success', 'check-circle');
    } catch (error) {
      console.error('Download failed:', error);
      notify(`Download failed: ${error.message}`, 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Display plugin execution result
   * @param {BackendPlugin} plugin
   * @param {any} result
   */
  displayResult(plugin, result) {
    const dialog = ui.pluginResultDialog;

    // Check if result contains downloadUrl for direct file download
    if (result && result.downloadUrl) {
      this.triggerDownload(plugin, result.downloadUrl);
      return;
    }

    // Check if result contains outputUrl for iframe rendering
    if (result && result.outputUrl) {
      this.displayResultInIframe(plugin, result);
      return;
    }

    // Check if result contains HTML content
    if (result && result.html) {
      // Display HTML in dialog with larger width for tables
      dialog.setAttribute("label", plugin.name);
      dialog.style.setProperty("--width", "80vw");
      dialog.icon.innerHTML = '';
      dialog.content.innerHTML = result.html;

      // Execute any scripts that were in the HTML (innerHTML doesn't execute them)
      const scripts = dialog.content.querySelectorAll('script');
      scripts.forEach(oldScript => {
        const newScript = document.createElement('script');
        // Copy attributes
        Array.from(oldScript.attributes).forEach(attr => {
          newScript.setAttribute(attr.name, attr.value);
        });
        // Copy script content
        newScript.textContent = oldScript.textContent;
        // Replace old script with new one to trigger execution
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });

      dialog.openWindowBtn.style.display = 'none';
      this.configureExportButton(dialog, plugin, result);
      dialog.executeBtn.style.display = 'none';

      dialog.show();
    } else if (result && result.error) {
      // Show error in dialog
      dialog.setAttribute("label", "Plugin Error");
      dialog.style.setProperty("--width", "50vw");
      dialog.icon.innerHTML = `<sl-icon name="exclamation-triangle" style="color: var(--sl-color-danger-500);"></sl-icon>`;
      dialog.content.innerHTML = `<p>${result.error}</p>`;
      dialog.openWindowBtn.style.display = 'none';
      dialog.exportBtn.style.display = 'none';
      dialog.executeBtn.style.display = 'none';
      dialog.show();
    } else {
      // Show JSON result in dialog
      const resultText = JSON.stringify(result, null, 2);
      dialog.setAttribute("label", plugin.name + " Result");
      dialog.style.setProperty("--width", "50vw");
      dialog.icon.innerHTML = `<sl-icon name="info-circle" style="color: var(--sl-color-primary-500);"></sl-icon>`;
      dialog.content.innerHTML = `<pre style="overflow: auto; max-height: 60vh;">${resultText}</pre>`;
      dialog.openWindowBtn.style.display = 'none';
      dialog.exportBtn.style.display = 'none';
      dialog.executeBtn.style.display = 'none';
      dialog.show();
    }
  }
}

export default BackendPluginsPlugin;

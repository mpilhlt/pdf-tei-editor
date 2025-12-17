/**
 * Backend Plugin Sandbox Module
 *
 * Provides controlled interface for plugin-generated HTML to interact with the application.
 * Available as `window.pluginSandbox` when plugin HTML content is displayed.
 */

import { services } from '../plugins.js';
import { openDocumentAtLine as xmlEditorOpenDocumentAtLine } from '../plugins/xmleditor.js';

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from './plugin-context.js'
 * @import { SlDialog } from '../ui.js'
 */

/**
 * Plugin Sandbox
 *
 * Provides controlled interface for plugin-generated HTML to interact with the application.
 * Available as `window.pluginSandbox` when plugin HTML content is displayed.
 */
export class PluginSandbox {
  /**
   * @param {PluginContext} context - Plugin context
   * @param {SlDialog} dialog - Result dialog element
   */
  constructor(context, dialog) {
    this.context = context;
    this.dialog = dialog;
  }

  /**
   * Update application state
   * @param {Partial<ApplicationState>} updates - State fields to update
   */
  async updateState(updates) {
    await this.context.updateState(updates);
  }

  /**
   * Close the result dialog
   */
  closeDialog() {
    this.dialog.hide();
  }

  /**
   * Open a document by updating xml state and closing dialog
   * @param {string} stableId - Document stable ID
   */
  async openDocument(stableId) {
    await services.load({xml: stableId});
    this.closeDialog();
  }

  /**
   * Open diff view between two documents
   * @param {string} stableId1 - First document stable ID
   * @param {string} stableId2 - Second document stable ID
   */
  async openDiff(stableId1, stableId2) {
    await services.load({xml: stableId1});
    await services.showMergeView(stableId2);
    this.closeDialog();
  }

  /**
   * Open document in XML editor and scroll to line
   * @param {string} stableId - Document stable ID
   * @param {number} lineNumber - Line number (1-based)
   * @param {number} [column=0] - Optional column position (0-based)
   */
  async openDocumentAtLine(stableId, lineNumber, column = 0) {
    await xmlEditorOpenDocumentAtLine(stableId, lineNumber, column);
    this.closeDialog();
  }

  /**
   * Open URL in new window with sandbox control capability
   * @param {string} url - URL to open
   * @param {string} [name='_blank'] - Window name
   * @param {string} [features=''] - Window features
   * @returns {Window} Opened window reference
   */
  openControlledWindow(url, name = '_blank', features = '') {
    const win = window.open(url, name, features);

    if (!win) {
      throw new Error('Failed to open window - popup blocked?');
    }

    // Set up message listener for child window commands
    const messageHandler = async (event) => {
      // Security: verify origin if needed
      if (!event.data || event.data.type !== 'SANDBOX_COMMAND') {
        return;
      }

      const { method, args, requestId } = event.data;

      try {
        // Call sandbox method dynamically
        if (typeof this[method] !== 'function') {
          throw new Error(`Unknown or non-callable sandbox method: ${method}`);
        }

        // Prevent calling private methods (starting with _)
        if (method.startsWith('_')) {
          throw new Error(`Cannot call private method: ${method}`);
        }

        const result = await this[method](...args);

        // Send response
        win.postMessage({
          type: 'SANDBOX_RESPONSE',
          requestId,
          result
        }, '*');
      } catch (error) {
        // Send error response
        win.postMessage({
          type: 'SANDBOX_RESPONSE',
          requestId,
          error: error.message
        }, '*');
      }
    };

    window.addEventListener('message', messageHandler);

    // Clean up listener when window closes
    const checkClosed = setInterval(() => {
      if (win.closed) {
        window.removeEventListener('message', messageHandler);
        clearInterval(checkClosed);
      }
    }, 1000);

    return win;
  }
}

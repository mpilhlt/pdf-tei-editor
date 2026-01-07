/**
 * Backend Plugin Sandbox Module
 *
 * Provides controlled interface for plugin-generated HTML to interact with the application.
 * Available as `window.pluginSandbox` when plugin HTML content is displayed.
 */

import { services } from '../plugins.js';
import { openDocumentAtLine as xmlEditorOpenDocumentAtLine } from '../plugins/xmleditor.js';
import { findCorrespondingSource } from '../modules/file-data-utils.js';

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

    // Set up message listener for iframe/popup window commands
    this.messageHandler = this._createMessageHandler();
    window.addEventListener('message', this.messageHandler);
  }

  /**
   * Create message handler for iframe and popup window communication
   * @private
   */
  _createMessageHandler() {
    return async (event) => {
      // Handle download requests
      if (event.data && event.data.type === 'DOWNLOAD_REQUEST') {
        const { requestId, url } = event.data;
        try {
          // Fetch with credentials
          const response = await fetch(url, {
            credentials: 'include'
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const blob = await response.blob();

          // Send blob back to iframe
          event.source.postMessage({
            type: 'DOWNLOAD_RESPONSE',
            requestId,
            blob
          }, '*');
        } catch (error) {
          event.source.postMessage({
            type: 'DOWNLOAD_RESPONSE',
            requestId,
            error: error.message
          }, '*');
        }
        return;
      }

      // Handle sandbox commands
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

        // Send response back to iframe or popup
        event.source.postMessage({
          type: 'SANDBOX_RESPONSE',
          requestId,
          result
        }, '*');
      } catch (error) {
        // Send error response
        event.source.postMessage({
          type: 'SANDBOX_RESPONSE',
          requestId,
          error: error.message
        }, '*');
      }
    };
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
   * Open a document by updating xml and pdf state and closing dialog
   * @param {string} stableId - Document stable ID (typically a TEI file)
   *
   * This method loads both the TEI document and its corresponding PDF source file.
   * If the stable ID corresponds to a TEI artifact, the associated PDF source is
   * automatically loaded alongside it to keep the UI in sync.
   */
  async openDocument(stableId) {
    // Get the corresponding PDF for this TEI file
    const state = this.context.getCurrentState();
    const fileData = state.fileData;
    const sourceInfo = fileData ? findCorrespondingSource(fileData, stableId) : null;
    const pdfId = sourceInfo?.sourceId;

    // Load both XML and PDF
    await services.load({
      xml: stableId,
      pdf: pdfId || undefined
    });
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

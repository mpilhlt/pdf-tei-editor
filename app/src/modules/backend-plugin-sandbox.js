/**
 * Backend Plugin Sandbox Module
 *
 * Provides controlled interface for plugin-generated HTML to interact with the application.
 * Available as `window.pluginSandbox` when plugin HTML content is displayed.
 */

import { services, sse as sseApi } from '../plugins.js';
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

    /** @type {Map<string, {eventType: string, listener: Function, source: WindowProxy|null}>} */
    this._sseSubscriptions = new Map();

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

        // For subscribeSSE, store the source window so we can forward events
        if (method === 'subscribeSSE' && result && this._sseSubscriptions.has(result)) {
          this._sseSubscriptions.get(result).source = event.source;
        }

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
   * Navigate the plugin iframe to a new URL with automatic session_id injection
   * @param {string} url - Relative or absolute URL to navigate to
   */
  navigateIframe(url) {
    const iframe = this.dialog.content.querySelector('iframe');
    if (!iframe) {
      throw new Error('No iframe found in dialog');
    }
    const targetUrl = new URL(url, window.location.origin);
    const state = this.context.getCurrentState();
    if (!targetUrl.searchParams.has('session_id') && state?.sessionId) {
      targetUrl.searchParams.set('session_id', state.sessionId);
    }
    iframe.src = targetUrl.toString();
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
   * Subscribe to SSE events and forward them to the requesting iframe/popup
   * @param {string} eventType - SSE event type to subscribe to
   * @returns {string} Subscription ID for unsubscribing
   */
  subscribeSSE(eventType) {
    const subscriptionId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const listener = (event) => {
      const sub = this._sseSubscriptions.get(subscriptionId);
      if (!sub?.source) return;
      try {
        sub.source.postMessage({
          type: 'SSE_EVENT',
          eventType,
          data: event.data,
          subscriptionId
        }, '*');
      } catch (err) {
        // Source window closed, clean up
        this.unsubscribeSSE(subscriptionId);
      }
    };

    sseApi.addEventListener(eventType, listener);
    this._sseSubscriptions.set(subscriptionId, { eventType, listener, source: null });

    return subscriptionId;
  }

  /**
   * Unsubscribe from SSE events
   * @param {string} subscriptionId - Subscription ID from subscribeSSE
   */
  unsubscribeSSE(subscriptionId) {
    const sub = this._sseSubscriptions.get(subscriptionId);
    if (sub) {
      sseApi.removeEventListener(sub.eventType, sub.listener);
      this._sseSubscriptions.delete(subscriptionId);
    }
  }

  /**
   * Remove SSE subscriptions, optionally filtered by source window.
   * When sourceWindow is provided, only subscriptions from that window are removed.
   * When omitted, all subscriptions are removed.
   * @param {WindowProxy} [sourceWindow] - Only clean up subscriptions from this source
   * @private
   */
  _cleanupSSESubscriptions(sourceWindow) {
    const toClean = [];
    for (const [id, sub] of this._sseSubscriptions) {
      if (!sourceWindow || sub.source === sourceWindow) {
        toClean.push(id);
      }
    }
    for (const id of toClean) {
      this.unsubscribeSSE(id);
    }
  }

  /**
   * Clean up all resources (message handler, SSE subscriptions)
   */
  destroy() {
    this._cleanupSSESubscriptions();
    window.removeEventListener('message', this.messageHandler);
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

    // Close child window and clean up when parent window closes
    const closeChild = () => {
      if (win && !win.closed) {
        this._cleanupSSESubscriptions(win);
        win.close();
      }
      window.removeEventListener('message', messageHandler);
      clearInterval(checkClosed);
    };
    window.addEventListener('beforeunload', closeChild);

    // Clean up listener when child window closes on its own
    const checkClosed = setInterval(() => {
      if (win.closed) {
        this._cleanupSSESubscriptions(win);
        window.removeEventListener('message', messageHandler);
        window.removeEventListener('beforeunload', closeChild);
        clearInterval(checkClosed);
      }
    }, 1000);

    return win;
  }
}

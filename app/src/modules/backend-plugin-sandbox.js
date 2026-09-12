/**
 * Backend Plugin Sandbox Module
 *
 * Provides controlled interface for plugin-generated HTML to interact with the application.
 * Available as `window.pluginSandbox` when plugin HTML content is displayed.
 */

import { openDocumentAtLine as xmlEditorOpenDocumentAtLine } from '../plugins/xmleditor.js';
import { findCorrespondingSource } from '../modules/file-data-utils.js';
import { notify as notifyUser } from './sl-utils.js';

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from './plugin-context.js'
 * @import { SlDialog } from '../ui.js'
 * @import { dialogApi } from '../plugins/dialog.js'
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
   * @param {SlDialog} resultDialog - Result dialog element
   */
  constructor(context, resultDialog) {
    this.context = context;
    this.resultDialog = resultDialog;

    /** @type {Map<string, {eventType: string, listener: Function, source: WindowProxy|null}>} */
    this._sseSubscriptions = new Map();

    /** Popup windows opened via {@link openControlledWindow}, so closeDialog can close them too. @type {Set<WindowProxy>} */
    this._controlledWindows = new Set();

    /** Source window of the SANDBOX_COMMAND currently being handled, if any. @type {WindowProxy|null} */
    this._activeCommandSource = null;

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

        this._activeCommandSource = event.source;
        let result;
        try {
          result = await this[method](...args);
        } finally {
          this._activeCommandSource = null;
        }

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
   * Get application state 
   * @returns {ApplicationState}
   */
  getCurrentState() {
    return this.context.getCurrentState()
  }


  /**
   * Update application state
   * @param {Partial<ApplicationState>} updates - State fields to update
   */
  async updateState(updates) {
    await this.context.updateState(updates);
  }

  /**
   * Close the result dialog. If the command that triggered this originated
   * from a popup opened via {@link openControlledWindow}, close that popup
   * too - otherwise it's left stranded with no way back to the dialog it
   * came from.
   */
  closeDialog() {
    this.resultDialog.hide();
    const source = this._activeCommandSource;
    if (source && this._controlledWindows.has(source)) {
      this._controlledWindows.delete(source);
      if (!source.closed) {
        source.close();
      }
    }
  }

  /**
   * Navigate the plugin iframe to a new URL with automatic session_id injection
   * @param {string} url - Relative or absolute URL to navigate to
   */
  navigateIframe(url) {
    const iframe = this.resultDialog.content.querySelector('iframe');
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
   * @param {string} [pdfId] - Optional PDF stable ID; if omitted, looked up from fileData
   * @param {boolean} [closeDialog] - Closes the dialog after loading the document (default true)
   *
   * This method loads both the TEI document and its corresponding PDF source file.
   * If pdfId is not provided and the stable ID corresponds to a TEI artifact, the
   * associated PDF source is automatically looked up from fileData. 
   */
  async openDocument(stableId, pdfId, closeDialog = true ) {
    // Use provided pdfId or look up from fileData
    const state = this.context.getCurrentState();
    const resolvedPdfId = pdfId || (
      state.fileData ? findCorrespondingSource(state.fileData, stableId)?.sourceId : null
    );

    // Load both XML and PDF
    await this.context.getDependency('services').load({
      xml: stableId,
      pdf: resolvedPdfId || undefined
    });
    if (closeDialog) {
      this.closeDialog();
    }
  }

  /**
   * Re-load the currently open PDF and/or TEI document from the server,
   * discarding any unsaved in-memory changes in the editor.
   *
   * Use this after a plugin endpoint has modified the open document's
   * content on the server out from under the editor (e.g. patching a
   * header label in place) so the UI reflects the fresh content.
   * @returns {Promise<void>}
   */
  async reloadCurrentDocument() {
    const state = this.context.getCurrentState();
    await this.context.getDependency('services').load({
      xml: state.xml || undefined,
      pdf: state.pdf || undefined
    });
  }

  /**
   * Show a toast notification to the user.
   * @param {string} message
   * @param {'primary'|'success'|'warning'|'danger'} [variant='primary']
   * @param {string} [icon='info-circle']
   */
  notify(message, variant = 'primary', icon = 'info-circle') {
    notifyUser(message, variant, icon);
  }

  /**
   * Open a PDF file without loading any TEI document
   * @param {string} stableId - PDF file stable ID
   * @param {boolean} [closeDialog] - Closes the dialog after loading (default true)
   */
  async openPdf(stableId, closeDialog = true) {
    await this.context.getDependency('services').load({ pdf: stableId });
    if (closeDialog) {
      this.closeDialog();
    }
  }

  /**
   * Load a PDF and/or TEI document by stable ID
   * @param {{xml?: string, pdf?: string}} files - Object with optional `xml` and/or `pdf` stable IDs
   * @param {boolean} [closeDialog] - Closes the dialog after loading (default true)
   */
  async load(files, closeDialog = true) {
    await this.context.getDependency('services').load(files);
    if (closeDialog) {
      this.closeDialog();
    }
  }

  /**
   * Open diff view between two documents
   * @param {string} stableId1 - First document stable ID
   * @param {string} stableId2 - Second document stable ID
   * @param {boolean} [closeDialog] - Closes the dialog after loading the document (default true)
   */
  async openDiff(stableId1, stableId2, closeDialog = true) {
    await this.context.getDependency('services').load({xml: stableId1});
    await this.context.getDependency('services').showMergeView(stableId2);
    if (closeDialog) {
      this.closeDialog();
    } 
  }

  /**
   * Open document in XML editor and scroll to line
   * @param {string} stableId - Document stable ID
   * @param {number} lineNumber - Line number (1-based)
   * @param {number} [column=0] - Optional column position (0-based)
   * @param {boolean} [closeDialog] - Closes the dialog after loading the document (default true)
   */
  async openDocumentAtLine(stableId, lineNumber, column = 0, closeDialog = true) {
    await xmlEditorOpenDocumentAtLine(stableId, lineNumber, column);
    if (closeDialog) {
      this.closeDialog();
    } 
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

    this.context.getDependency('sse').addEventListener(eventType, listener);
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
      this.context.getDependency('sse').removeEventListener(sub.eventType, sub.listener);
      this._sseSubscriptions.delete(subscriptionId);
    }
  }

  /**
   * Call a plugin API endpoint with authentication
   * @param {string} endpoint - Plugin endpoint path (e.g., '/api/plugins/my-plugin/action')
   * @param {string} method - HTTP method (GET, POST, etc.)
   * @param {Object|null} params - Query params for GET or request body for POST/PUT
   * @returns {Promise<Object>} Parsed JSON response
   */
  async callPluginApi(endpoint, method = 'GET', params = null) {
    const state = this.context.getCurrentState();
    const url = new URL(endpoint, window.location.origin);
    /** @type {RequestInit} */
    const options = {
      method,
      headers: { 'X-Session-ID': state?.sessionId || '' }
    };
    if (params) {
      if (method === 'GET') {
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
      } else {
        options.headers = { ...options.headers, 'Content-Type': 'application/json' };
        options.body = JSON.stringify(params);
      }
    }
    const response = await fetch(url.toString(), options);
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || response.statusText);
    }
    return response.json();
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
   * Open URL in new window with sandbox control capability, with automatic
   * session_id injection (same convention as {@link navigateIframe}). The
   * opened window's SANDBOX_COMMAND messages are handled by the same generic
   * message handler set up in the constructor (it already handles messages
   * from any iframe or popup), so no dedicated listener is created here.
   * @param {string} url - Relative or absolute URL to open
   * @param {string} [name='_blank'] - Window name
   * @param {string} [features] - Window features. When omitted, resolved
   *   from the `backend-plugins.open-target` config value: 'tab' (default)
   *   opens with no features (a plain new tab in most browsers), 'window'
   *   opens a sized popup. Pass an explicit string to override either way.
   * @returns {Promise<boolean>} True once the window was opened. Not the
   *   window reference itself - callers may be a plugin iframe/popup
   *   invoking this through the cross-window sandbox RPC, whose response
   *   must be structured-clone-able, and a Window object is not.
   */
  async openControlledWindow(url, name = '_blank', features) {
    const targetUrl = new URL(url, window.location.origin);
    const state = this.context.getCurrentState();
    if (!targetUrl.searchParams.has('session_id') && state?.sessionId) {
      targetUrl.searchParams.set('session_id', state.sessionId);
    }
    let resolvedFeatures = features;
    if (resolvedFeatures === undefined) {
      const openTarget = await this.context.getDependency('config').get('backend-plugins.open-target', 'tab');
      resolvedFeatures = openTarget === 'window' ? 'width=1200,height=800' : '';
    }
    const win = window.open(targetUrl.toString(), name, resolvedFeatures);

    if (!win) {
      throw new Error('Failed to open window - popup blocked?');
    }

    this._controlledWindows.add(win);

    // Close child window when parent window closes
    const closeChild = () => {
      if (win && !win.closed) {
        this._cleanupSSESubscriptions(win);
        win.close();
      }
      this._controlledWindows.delete(win);
      clearInterval(checkClosed);
    };
    window.addEventListener('beforeunload', closeChild);

    // Clean up when child window closes on its own
    const checkClosed = setInterval(() => {
      if (win.closed) {
        this._cleanupSSESubscriptions(win);
        this._controlledWindows.delete(win);
        window.removeEventListener('beforeunload', closeChild);
        clearInterval(checkClosed);
      }
    }, 1000);

    return true;
  }
}

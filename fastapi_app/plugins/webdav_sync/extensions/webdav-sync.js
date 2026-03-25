/**
 * Frontend extension for the WebDAV sync backend plugin.
 *
 * Adds a sync icon and progress bar to the PDF viewer statusbar.
 * Shows a hover popup with recent sync messages.
 * Registers the "sync.syncFiles" endpoint so other plugins can trigger synchronization.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 *
 * @typedef {{
 *   conflicts?: number,
 *   downloaded?: number,
 *   deleted_local?: number,
 *   deleted_remote?: number,
 *   errors?: number,
 *   metadata_synced?: number,
 *   uploaded?: number,
 *   new_version?: number,
 *   duration_ms?: number,
 *   message?: string,
 *   skipped?: boolean
 * }} SyncResult
 */

const MAX_MESSAGES = 50;

export default class WebdavSyncExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'webdav-sync-extension' });
  }

  static extensionPoints = ['sync.syncFiles'];

  /** @type {HTMLElement|undefined} */
  _syncContainer;
  /** @type {HTMLElement|undefined} */
  _syncIcon;
  /** @type {HTMLElement|undefined} */
  _syncProgressWidget;
  /** @type {HTMLElement|undefined} */
  _messagePopup;
  /** @type {HTMLElement|undefined} */
  _messageList;
  /** @type {string[]} */
  _messageLog = [];

  async install(state) {
    await super.install(state);

    const sse = this.getDependency('sse');

    sse.addEventListener('syncProgress', (event) => {
      const progress = parseInt(event.data);
      if (this._syncProgressWidget && this._syncProgressWidget.isConnected) {
        this._syncProgressWidget.indeterminate = false;
        this._syncProgressWidget.value = progress;
      }
    });

    sse.addEventListener('syncMessage', (event) => {
      console.debug(`Sync: ${event.data}`);
      this._addMessage(event.data);
    });

    this._syncProgressWidget = document.createElement('status-progress');
    this._syncProgressWidget.indeterminate = false;
    this._syncProgressWidget.value = 0;
    this._syncProgressWidget.hidePercentage = true;
    this._syncProgressWidget.style.minWidth = '40px';
    this._syncProgressWidget.style.maxWidth = '75px';

    this._syncIcon = document.createElement('sl-icon');
    this._syncIcon.name = 'arrow-repeat';
    this._syncIcon.style.marginRight = '4px';
    this._syncIcon.style.cursor = 'pointer';
    this._syncIcon.title = 'Click to sync files';
    this._syncIcon.addEventListener('click', (e) => { e.stopPropagation(); this._onClickSyncBtn(); });

    this._syncContainer = document.createElement('div');
    this._syncContainer.style.display = 'flex';
    this._syncContainer.style.alignItems = 'center';
    this._syncContainer.appendChild(this._syncIcon);
    this._syncContainer.appendChild(this._syncProgressWidget);
    this._syncContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      this._togglePopup();
    });

    this._messagePopup = document.createElement('div');
    this._messagePopup.style.cssText = [
      'position: fixed',
      'display: none',
      'background: var(--sl-color-neutral-900, #1a1a2e)',
      'color: var(--sl-color-neutral-0, #fff)',
      'font-size: 11px',
      'font-family: var(--sl-font-mono, monospace)',
      'line-height: 1.5',
      'padding: 6px 8px',
      'border-radius: 4px',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.4)',
      'max-width: 420px',
      'min-width: 200px',
      'z-index: 9999',
    ].join(';');
    this._messagePopup.addEventListener('click', (e) => e.stopPropagation());

    this._messageList = document.createElement('div');
    this._messageList.style.cssText = 'max-height: 180px; overflow-y: auto;';
    this._messagePopup.appendChild(this._messageList);
    document.body.appendChild(this._messagePopup);
    document.addEventListener('click', () => this._hidePopup());

    this.getDependency('ui').pdfViewer.statusbar.add(this._syncContainer, 'right', 3);

    const syncIntervalSeconds = await this.getDependency('config').get('plugin.webdav-sync.sync-interval', 0);
    if (syncIntervalSeconds > 0) {
      console.debug(`WebDAV sync: periodic sync every ${syncIntervalSeconds}s`);
      setInterval(async () => {
        try {
          const summary = await this.syncFiles();
          if (summary && (summary.downloaded || summary.deleted_local || summary.conflicts)) {
            await this.getDependency('file-selection').reload({ refresh: true });
          }
        } catch (e) {
          console.error('Periodic sync failed:', e);
        }
      }, syncIntervalSeconds * 1000);
    }
  }

  /**
   * Implements sync.syncFiles endpoint.
   * Called by other plugins to trigger synchronization.
   * @returns {Promise<SyncResult>}
   */
  async syncFiles() {
    console.debug('WebDAV sync: synchronizing files on the server');
    this._messageLog.length = 0;
    if (this._syncIcon) this._syncIcon.classList.add('rotating');
    if (this._syncProgressWidget) {
      this._syncProgressWidget.indeterminate = true;
      this._syncProgressWidget.value = 0;
    }

    try {
      const response = await this.getDependency('client').apiClient.pluginsExecute('webdav-sync', {
        endpoint: 'execute',
        params: {}
      });
      const summary = response?.result;
      if (summary && summary.skipped) {
        const reason = summary.message || 'already in sync';
        console.debug(`Sync skipped: ${reason}`);
        this._addMessage(`Sync skipped: ${reason}`);
      } else if (summary) {
        console.debug(`Sync completed: ${JSON.stringify(summary)}`);
        this._addMessage(_formatSummary(summary));
      }
      return summary;
    } finally {
      if (this._syncIcon) this._syncIcon.classList.remove('rotating');
      if (this._syncProgressWidget) {
        this._syncProgressWidget.indeterminate = false;
        this._syncProgressWidget.value = 0;
      }
    }
  }

  /** @param {string} text */
  _addMessage(text) {
    this._messageLog.push(text);
    if (this._messageLog.length > MAX_MESSAGES) this._messageLog.shift();
    this._renderMessages();
  }

  _renderMessages() {
    if (!this._messageList) return;
    this._messageList.innerHTML = '';
    if (this._messageLog.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.textContent = 'No sync messages yet';
      placeholder.style.opacity = '0.5';
      this._messageList.appendChild(placeholder);
    } else {
      for (const msg of this._messageLog) {
        const row = document.createElement('div');
        row.textContent = msg;
        row.style.whiteSpace = 'nowrap';
        this._messageList.appendChild(row);
      }
      this._messageList.scrollTop = this._messageList.scrollHeight;
    }
  }

  _positionPopup() {
    if (!this._syncContainer || !this._messagePopup) return;
    const rect = this._syncContainer.getBoundingClientRect();
    this._messagePopup.style.left = `${rect.left}px`;
    this._messagePopup.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  }

  _showPopup() {
    if (!this._messagePopup) return;
    this._renderMessages();
    this._positionPopup();
    this._messagePopup.style.display = 'block';
  }

  _hidePopup() {
    if (this._messagePopup) this._messagePopup.style.display = 'none';
  }

  _togglePopup() {
    if (!this._messagePopup) return;
    if (this._messagePopup.style.display === 'none' || !this._messagePopup.style.display) {
      this._showPopup();
    } else {
      this._hidePopup();
    }
  }

  async _onClickSyncBtn() {
    try {
      await this.syncFiles();
    } catch (e) {
      console.error('Sync failed:', e);
    }
    await this.getDependency('file-selection').reload({ refresh: true });
  }
}

/**
 * Format a SyncResult into a human-readable summary line.
 * @param {SyncResult} summary
 * @returns {string}
 */
function _formatSummary(summary) {
  const parts = [];
  if (summary.uploaded) parts.push(`↑${summary.uploaded}`);
  if (summary.downloaded) parts.push(`↓${summary.downloaded}`);
  if (summary.metadata_synced) parts.push(`≡${summary.metadata_synced}`);
  if (summary.deleted_remote) parts.push(`remote_del:${summary.deleted_remote}`);
  if (summary.deleted_local) parts.push(`local_del:${summary.deleted_local}`);
  if (summary.conflicts) parts.push(`conflicts:${summary.conflicts}`);
  if (summary.errors) parts.push(`errors:${summary.errors}`);
  return parts.length ? `Sync done — ${parts.join(' ')}` : 'Sync done — no changes';
}

/** @import { FrontendExtensionSandbox } from '../../../app/src/modules/frontend-extension-sandbox.js' */

/**
 * Frontend extension for the WebDAV sync backend plugin.
 *
 * Adds a sync icon and progress bar to the PDF viewer statusbar.
 * Shows a hover popup with recent sync messages.
 * Registers the "sync.syncFiles" endpoint so other plugins can trigger synchronization.
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

/** @type {HTMLElement} */
let syncContainer;

/** @type {HTMLElement} */
let syncIcon;

/** @type {HTMLElement} */
let syncProgressWidget;

/** @type {HTMLElement} */
let messagePopup;

/** @type {HTMLElement} */
let messageList;

/** @type {string[]} */
const messageLog = [];

/**
 * Append a message to the log and refresh the popup contents.
 * @param {string} text
 */
function addMessage(text) {
  messageLog.push(text);
  if (messageLog.length > MAX_MESSAGES) {
    messageLog.shift();
  }
  renderMessages();
}

function renderMessages() {
  if (!messageList) return;
  messageList.innerHTML = '';
  if (messageLog.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.textContent = 'No sync messages yet';
    placeholder.style.opacity = '0.5';
    messageList.appendChild(placeholder);
  } else {
    for (const msg of messageLog) {
      const row = document.createElement('div');
      row.textContent = msg;
      row.style.whiteSpace = 'nowrap';
      messageList.appendChild(row);
    }
    // Scroll to bottom so latest message is visible
    messageList.scrollTop = messageList.scrollHeight;
  }
}

/** Position the popup above the syncContainer. */
function positionPopup() {
  if (!syncContainer || !messagePopup) return;
  const rect = syncContainer.getBoundingClientRect();
  messagePopup.style.left = `${rect.left}px`;
  messagePopup.style.bottom = `${window.innerHeight - rect.top + 6}px`;
}

function showPopup() {
  if (!messagePopup) return;
  renderMessages();
  positionPopup();
  messagePopup.style.display = 'block';
}

function hidePopup() {
  if (messagePopup) messagePopup.style.display = 'none';
}

function togglePopup() {
  if (!messagePopup) return;
  if (messagePopup.style.display === 'none' || !messagePopup.style.display) {
    showPopup();
  } else {
    hidePopup();
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

window.registerFrontendExtension({
  name: "webdav-sync-extension",
  pluginId: "webdav-sync",

  /**
   * @param {Object} state
   * @param {FrontendExtensionSandbox} sandbox
   */
  async install(_state, sandbox) {
    // SSE listeners for sync progress and messages
    sandbox.sse.addEventListener('syncProgress', (event) => {
      const progress = parseInt(event.data);
      if (syncProgressWidget && syncProgressWidget.isConnected) {
        syncProgressWidget.indeterminate = false;
        syncProgressWidget.value = progress;
      }
    });

    sandbox.sse.addEventListener('syncMessage', (event) => {
      console.debug(`Sync: ${event.data}`);
      addMessage(event.data);
    });

    // Create sync progress widget
    syncProgressWidget = document.createElement('status-progress');
    syncProgressWidget.indeterminate = false;
    syncProgressWidget.value = 0;
    syncProgressWidget.hidePercentage = true;
    syncProgressWidget.style.minWidth = '40px';
    syncProgressWidget.style.maxWidth = '75px';

    // Create clickable sync icon
    syncIcon = document.createElement('sl-icon');
    syncIcon.name = 'arrow-repeat';
    syncIcon.style.marginRight = '4px';
    syncIcon.style.cursor = 'pointer';
    syncIcon.title = 'Click to sync files';
    syncIcon.addEventListener('click', (e) => { e.stopPropagation(); onClickSyncBtn(sandbox); });

    // Wrap icon and progress bar in a container
    syncContainer = document.createElement('div');
    syncContainer.style.display = 'flex';
    syncContainer.style.alignItems = 'center';
    syncContainer.appendChild(syncIcon);
    syncContainer.appendChild(syncProgressWidget);

    syncContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopup();
    });

    // Hover popup — fixed position so it sits above the statusbar regardless of scroll
    messagePopup = document.createElement('div');
    messagePopup.style.cssText = [
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

    messagePopup.addEventListener('click', (e) => e.stopPropagation());

    messageList = document.createElement('div');
    messageList.style.cssText = 'max-height: 180px; overflow-y: auto;';
    messagePopup.appendChild(messageList);
    document.body.appendChild(messagePopup);
    document.addEventListener('click', hidePopup);

    sandbox.ui.pdfViewer.statusbar.add(syncContainer, 'right', 3);

    // Periodic sync
    const syncIntervalSeconds = await sandbox.config.get('plugin.webdav-sync.sync-interval', 0);
    if (syncIntervalSeconds > 0) {
      console.debug(`WebDAV sync: periodic sync every ${syncIntervalSeconds}s`);
      setInterval(async () => {
        try {
          const summary = await sandbox.invoke('sync.syncFiles', sandbox.getState());
          if (summary && (summary.downloaded || summary.deleted_local || summary.conflicts)) {
            await sandbox.services.reloadFiles({ refresh: true });
          }
        } catch (e) {
          console.error('Periodic sync failed:', e);
        }
      }, syncIntervalSeconds * 1000);
    }
  },

  /**
   * Implements ep.sync.syncFiles endpoint.
   * Called by other plugins to trigger synchronization.
   * @param {Object} args
   * @param {FrontendExtensionSandbox} sandbox
   * @returns {Promise<SyncResult>}
   */
  sync: {
    async syncFiles(_args, sandbox) {
      console.debug("WebDAV sync: synchronizing files on the server");
      messageLog.length = 0;
      if (syncIcon) syncIcon.classList.add("rotating");
      if (syncProgressWidget) {
        syncProgressWidget.indeterminate = true;
        syncProgressWidget.value = 0;
      }

      try {
        const response = await sandbox.api.pluginsExecute('webdav-sync', { endpoint: 'execute', params: {} });
        const summary = response?.result;
        if (summary && summary.skipped) {
          const reason = summary.message || 'already in sync';
          console.debug(`Sync skipped: ${reason}`);
          addMessage(`Sync skipped: ${reason}`);
        } else if (summary) {
          console.debug(`Sync completed: ${JSON.stringify(summary)}`);
          addMessage(_formatSummary(summary));
        }
        return summary;
      } finally {
        if (syncIcon) syncIcon.classList.remove("rotating");
        if (syncProgressWidget) {
          syncProgressWidget.indeterminate = false;
          syncProgressWidget.value = 0;
        }
      }
    }
  }
});

/**
 * Handle sync icon click: run sync then reload file list.
 * @param {FrontendExtensionSandbox} sandbox
 */
async function onClickSyncBtn(sandbox) {
  try {
    // Use the registered endpoint so all plugins are notified
    await sandbox.invoke('sync.syncFiles', sandbox.getState());
  } catch (e) {
    console.error('Sync failed:', e);
  }
  // Always reload file data after manual sync
  await sandbox.services.reloadFiles({ refresh: true });
}

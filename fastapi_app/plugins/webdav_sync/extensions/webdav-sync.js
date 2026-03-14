/** @import { FrontendExtensionSandbox } from '../../../app/src/modules/frontend-extension-sandbox.js' */

/**
 * Frontend extension for the WebDAV sync backend plugin.
 *
 * Adds a sync icon and progress bar to the PDF viewer statusbar.
 * Shows a hover popup with recent sync messages.
 * Registers the "sync.syncFiles" endpoint so other plugins can trigger synchronization.
 *
 * @typedef {{
 *   conflicts_resolved?: number,
 *   downloads?: number,
 *   local_deletes?: number,
 *   local_markers_cleaned_up?: number,
 *   remote_deletes?: number,
 *   stale_locks_purged?: number,
 *   uploads?: number,
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
    syncIcon.addEventListener('click', () => onClickSyncBtn(sandbox));

    // Wrap icon and progress bar in a container
    syncContainer = document.createElement('div');
    syncContainer.style.display = 'flex';
    syncContainer.style.alignItems = 'center';
    syncContainer.appendChild(syncIcon);
    syncContainer.appendChild(syncProgressWidget);

    syncContainer.addEventListener('mouseenter', showPopup);
    syncContainer.addEventListener('mouseleave', hidePopup);

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
      'pointer-events: none',
    ].join(';');

    messageList = document.createElement('div');
    messageList.style.cssText = 'max-height: 180px; overflow-y: auto;';
    messagePopup.appendChild(messageList);
    document.body.appendChild(messagePopup);

    sandbox.ui.pdfViewer.statusbar.add(syncContainer, 'right', 3);
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

      const originalReadOnly = sandbox.getState().editorReadOnly;
      await sandbox.updateState({ editorReadOnly: true });

      try {
        const summary = await sandbox.api.pluginsExecute('webdav-sync', { endpoint: 'execute', params: {} });
        if (summary && summary.skipped) {
          console.debug(`Sync skipped: ${summary.message}`);
        } else {
          console.log(`Sync completed: ${JSON.stringify(summary)}`);
        }
        return summary;
      } finally {
        await sandbox.updateState({ editorReadOnly: originalReadOnly });
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

/**
 * Frontend extension for the WebDAV sync backend plugin.
 *
 * Adds a sync icon and progress bar to the PDF viewer statusbar.
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

/** @type {HTMLElement} */
let syncContainer;

/** @type {HTMLElement} */
let syncIcon;

/** @type {HTMLElement} */
let syncProgressWidget;

window.registerFrontendExtension({
  name: "webdav-sync-extension",

  /**
   * @param {Object} state
   * @param {import('../../../app/src/modules/frontend-extension-sandbox.js').FrontendExtensionSandbox} sandbox
   */
  async install(state, sandbox) {
    // SSE listeners for sync progress
    sandbox.sse.addEventListener('syncProgress', (event) => {
      const progress = parseInt(event.data);
      if (syncProgressWidget && syncProgressWidget.isConnected) {
        syncProgressWidget.indeterminate = false;
        syncProgressWidget.value = progress;
      }
    });

    sandbox.sse.addEventListener('syncMessage', (event) => {
      console.debug(`Sync: ${event.data}`);
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

    sandbox.ui.pdfViewer.statusbar.add(syncContainer, 'right', 3);
  },

  /**
   * Implements ep.sync.syncFiles endpoint.
   * Called by other plugins to trigger synchronization.
   * @param {Object} args
   * @param {import('../../../app/src/modules/frontend-extension-sandbox.js').FrontendExtensionSandbox} sandbox
   * @returns {Promise<SyncResult>}
   */
  sync: {
    async syncFiles(args, sandbox) {
      console.debug("WebDAV sync: synchronizing files on the server");
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
 * @param {import('../../../app/src/modules/frontend-extension-sandbox.js').FrontendExtensionSandbox} sandbox
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

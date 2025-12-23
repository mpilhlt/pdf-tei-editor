/**
 * File Data Management Plugin
 * 
 * Handles file data operations including loading file lists, saving XML files,
 * and managing file-related state updates.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { DocumentItem } from '../modules/file-data-utils.js'
 */

import { endpoints as ep } from '../app.js'
import { Plugin } from '../modules/plugin-base.js'
import { logger, client, dialog, xmlEditor } from '../app.js'
import { createIdLookupIndex } from '../modules/file-data-utils.js'
import { PanelUtils } from '../modules/panels/index.js'
import ui from '../ui.js'
import { registerTemplate, createFromTemplate } from '../ui.js'
import { userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'

// Register templates
await registerTemplate('gc-menu-item', 'gc-menu-item.html')

/**
 * File data management plugin
 */
class FiledataPlugin extends Plugin {
  /**
   * @param {PluginContext} context
   */
  constructor(context) {
    super(context, {
      name: 'filedata',
      deps: ['logger', 'client', 'dialog', 'xmleditor', 'toolbar']
    });

    /** @type {StatusText | null} */
    this.savingStatusWidget = null;

    /** @private Flag to prevent concurrent reload operations */
    this._reloadInProgress = false;
  }

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state);
    logger.debug(`Installing plugin "${this.name}"`);

    // Initialize empty ID lookup index to prevent errors during plugin initialization
    logger.debug('Initializing empty ID lookup index during installation');
    createIdLookupIndex([]);

    // Create status widget for save operations
    this.savingStatusWidget = PanelUtils.createText({
      text: '',
      icon: 'floppy',
      variant: 'primary',
      name: 'savingStatus'
    });

    // Add garbage collection menu item to toolbar menu
    createFromTemplate('gc-menu-item', ui.toolbar.toolbarMenu.menu);

    logger.debug('Garbage collection menu item added to toolbar menu');

    // Setup menu item handler
    ui.toolbar.toolbarMenu.menu.gcMenuItem.addEventListener('click', () => {
      this.showGarbageCollectionDialog();
    });

    // Initially hide menu item until we check admin status
    ui.toolbar.toolbarMenu.menu.gcMenuItem.style.display = 'none';
  }

  /**
   * Shows a confirmation dialog and triggers garbage collection
   * @private
   */
  async showGarbageCollectionDialog() {
    const result = await dialog.confirm(
      'This will permanently delete all files marked for deletion. Continue?',
      'Confirm Garbage Collection'
    );

    if (!result) {
      return;
    }

    try {
      // Use current time to collect all deleted files
      // The backend enforces 24-hour minimum for non-admin users
      const deletedBefore = new Date().toISOString();

      logger.info('Running garbage collection...');
      const response = await client.apiClient.filesGarbageCollect({
        deleted_before: deletedBefore
      });

      const { purged_count, files_deleted, storage_freed } = response;
      const storageMB = (storage_freed / (1024 * 1024)).toFixed(2);

      notify(
        `Garbage collection complete: ${purged_count} records purged, ${files_deleted} files deleted, ${storageMB} MB freed`,
        'success',
        'check-circle'
      );

      logger.info(`GC complete: ${purged_count} records, ${files_deleted} files, ${storageMB} MB freed`);

      // Reload file data to update the UI
      await this.reload({ refresh: true });
    } catch (error) {
      logger.error('Garbage collection failed: ' + String(error));
      notify('Garbage collection failed: ' + String(error), 'danger', 'exclamation-octagon');
    }
  }

  /**
   * React to state changes
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    if (changedKeys.includes('user')) {
      // Only admins can access garbage collection - hide menu item for non-admins
      const isAdmin = userIsAdmin(this.state.user);
      if (ui.toolbar?.toolbarMenu?.menu?.gcMenuItem) {
        ui.toolbar.toolbarMenu.menu.gcMenuItem.style.display = isAdmin ? '' : 'none';
      }
    }
  }

  /**
   * Reloads the file data from the server
   * @param {Object} options - Options for reloading
   * @param {boolean} [options.refresh] - Whether to force refresh of server cache
   * @returns {Promise<ApplicationState>} Updated state with new file data
   */
  async reload(options = {}) {
    // Prevent concurrent reload operations
    if (this._reloadInProgress) {
      logger.debug("Ignoring reload request - reload already in progress");
      return this.state;
    }

    this._reloadInProgress = true;
    logger.debug("Reloading file data" + (options.refresh ? " with cache refresh" : ""));

    try {
      // Get file list response - API returns {files: [...]} structure
      const response = await client.getFileList(null, options.refresh);
    
      /** @type {DocumentItem[]} */
      let data = response?.files || [];
      if (!data || data.length === 0) {
        data = []; // Ensure data is an empty array instead of null/undefined
      }

      // Create ID lookup index when fileData is loaded
      if (data && data.length > 0) {
        logger.debug('Creating ID lookup index for file data');
        createIdLookupIndex(data);
      } else {
        // Initialize empty ID lookup index to prevent errors
        logger.debug('Initializing empty ID lookup index');
        createIdLookupIndex([]);
      }

      // Load collections from server
      let collections = [];
      try {
        collections = await client.getCollections();
        logger.debug(`Loaded ${collections.length} collections from server`);

        // Validate that all document collections exist in the collections list
        const collectionIds = new Set(collections.map(c => c.id));
        data.forEach((doc, index) => {
          if (doc.collections && doc.collections.length > 0) {
            const invalidCollections = doc.collections.filter(colId => !collectionIds.has(colId));
            if (invalidCollections.length > 0) {
              logger.warn(
                `Document ${doc.doc_id} references non-existent collection(s): ${invalidCollections.join(', ')}`
              );
            }
          }
        });
      } catch (error) {
        logger.error(`Failed to load collections: ${error}`);
        // Continue with empty collections list - file operations will still work
      }

      // Store fileData and collections in state and propagate them
      const newState = await this.dispatchStateChange({
        fileData: data,
        collections
      });
      return newState;
    } finally {
      this._reloadInProgress = false;
    }
  }

  /**
   * Saves the current XML content to a file
   * @param {string} fileHash The hash identifying the XML file on the server
   * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version
   * @returns {Promise<{file_id:string, status:string}>} An object with file_id (stable file identifier) and status
   * @throws {Error}
   */
  async saveXml(fileHash, saveAsNewVersion = false) {
    logger.info(`Saving XML${saveAsNewVersion ? " as new version" : ""}...`);
    if (!xmlEditor.getXmlTree()) {
      throw new Error("Cannot save: No XML valid document in the editor");
    }
    try {
      // Show saving status
      if (this.savingStatusWidget) {
        ui.xmlEditor.statusbar.add(this.savingStatusWidget, 'left', 10);
      }
      const xmlContent = xmlEditor.getXML()

      const result = await client.saveXml(xmlContent, fileHash, saveAsNewVersion);
      return /** @type {{file_id: string, status: string}} */ (result);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error("Error while saving XML:", errorMessage);
      dialog.error(`Could not save XML: ${errorMessage}`);
      throw new Error(`Could not save XML: ${errorMessage}`);
    } finally {
      // clear status message after 1 second
      setTimeout(() => {
        if (this.savingStatusWidget) {
          ui.xmlEditor.statusbar.removeById(this.savingStatusWidget.id);
        }
      }, 1000);
    }
  }

  // Override to expose custom endpoints
  getEndpoints() {
    return {
      ...super.getEndpoints(),
      [ep.filedata.reload]: this.reload.bind(this),
      [ep.filedata.saveXml]: this.saveXml.bind(this)
    };
  }
}

export default FiledataPlugin;
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

import { Plugin } from '../modules/plugin-base.js'
import { createIdLookupIndex } from '../modules/file-data-utils.js'
import { PanelUtils } from '../modules/panels/index.js'
import ui from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'
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
      deps: ['logger', 'client', 'dialog', 'xmleditor', 'toolbar', 'tools']
    });

    /** @type {StatusText | null} */
    this.savingStatusWidget = null;

    /** @private Flag to prevent concurrent reload operations */
    this._reloadInProgress = false;
  }

  // Cached dependencies
  #logger;
  #client;
  #dialog;
  #xmlEditor;

  static extensionPoints = ['filedata.reload', 'filedata.saveXml'];

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state);
    this.#logger = this.getDependency('logger');
    this.#client = this.getDependency('client');
    this.#dialog = this.getDependency('dialog');
    this.#xmlEditor = this.getDependency('xmleditor');
    this.#logger.debug(`Installing plugin "${this.name}"`);

    // Initialize empty ID lookup index to prevent errors during plugin initialization
    this.#logger.debug('Initializing empty ID lookup index during installation');
    createIdLookupIndex([]);

    // Create status widget for save operations
    this.savingStatusWidget = PanelUtils.createText({
      text: '',
      icon: 'floppy',
      variant: 'primary',
      name: 'savingStatus'
    });

    // Listen for SSE events about file data changes
    this.getDependency('sse').addEventListener('fileDataChanged', async (event) => {
      const data = JSON.parse(event.data);

      // Only reload for metadata changes, not lock status changes
      // Lock status is already updated through other mechanisms
      if (data.reason === 'lock_acquired') {
        return;
      }

      // Check if currently loaded document was deleted
      if (data.reason === 'files_deleted' && data.stable_ids) {
        const currentXml = this.state.xml;
        if (currentXml && data.stable_ids.includes(currentXml)) {
          this.#logger.warn(`Currently loaded document ${currentXml} was deleted by another user`);

          // Clear the editor
          this.#xmlEditor.clear();

          // Update state to clear document
          await this.context.updateState({
            xml: null,
            diff: null,
            editorReadOnly: false
          });

          // Notify user
          notify(
            'The document you were viewing was deleted by another user',
            'warning',
            'trash'
          );
        }
      }

      this.#logger.debug(`File data changed (reason: ${data.reason}), reloading file data`);

      // Reload file data when changes occur from other sessions
      this.reload({ refresh: true });
    });
  }

  async start() {
    const gcElement = createSingleFromTemplate('gc-menu-item');
    this._gcItem = gcElement;
    this.getDependency('tools').addMenuItems([gcElement], 'administration');

    gcElement.querySelector('[name="gcMenuItem"]').addEventListener('click', () => {
      this.showGarbageCollectionDialog();
    });

    // Initially hide until admin status is known
    this._gcItem.style.display = 'none';
  }

  /**
   * Shows a confirmation dialog and triggers garbage collection
   * @private
   */
  async showGarbageCollectionDialog() {
    const result = await this.#dialog.confirm(
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

      this.#logger.info('Running garbage collection...');
      const response = await this.#client.apiClient.filesGarbageCollect({
        deleted_before: deletedBefore
      });

      const { purged_count, files_deleted, storage_freed } = response;
      const storageMB = (storage_freed / (1024 * 1024)).toFixed(2);

      notify(
        `Garbage collection complete: ${purged_count} records purged, ${files_deleted} files deleted, ${storageMB} MB freed`,
        'success',
        'check-circle'
      );

      this.#logger.info(`GC complete: ${purged_count} records, ${files_deleted} files, ${storageMB} MB freed`);

      // Reload file data to update the UI
      await this.reload({ refresh: true });
    } catch (error) {
      this.#logger.error('Garbage collection failed: ' + String(error));
      notify('Garbage collection failed: ' + String(error), 'danger', 'exclamation-octagon');
    }
  }

  /**
   * React to state changes
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    if (changedKeys.includes('user')) {
      // Only admins can access garbage collection
      if (this._gcItem) this._gcItem.style.display = userIsAdmin(this.state.user) ? '' : 'none';
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
      this.#logger.debug("Ignoring reload request - reload already in progress");
      return this.state;
    }

    this._reloadInProgress = true;
    this.#logger.debug("Reloading file data" + (options.refresh ? " with cache refresh" : ""));

    try {
      // Get file list response - API returns {files: [...]} structure
      const response = await this.#client.getFileList(null, options.refresh);
    
      /** @type {DocumentItem[]} */
      let data = response?.files || [];
      if (!data || data.length === 0) {
        data = []; // Ensure data is an empty array instead of null/undefined
      }

      // Create ID lookup index when fileData is loaded
      if (data && data.length > 0) {
        this.#logger.debug('Creating ID lookup index for file data');
        createIdLookupIndex(data);
      } else {
        // Initialize empty ID lookup index to prevent errors
        this.#logger.debug('Initializing empty ID lookup index');
        createIdLookupIndex([]);
      }

      // Load collections from server
      let collections = [];
      try {
        collections = await this.#client.getCollections();
        this.#logger.debug(`Loaded ${collections.length} collections from server`);

        // Validate that all document collections exist in the collections list
        const collectionIds = new Set(collections.map(c => c.id));
        data.forEach((doc) => {
          if (doc.collections && doc.collections.length > 0) {
            const invalidCollections = doc.collections.filter(colId => !collectionIds.has(colId));
            if (invalidCollections.length > 0) {
              this.#logger.warn(
                `Document ${doc.doc_id} references non-existent collection(s): ${invalidCollections.join(', ')}`
              );
            }
          }
        });
      } catch (error) {
        this.#logger.error(`Failed to load collections: ${error}`);
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
    this.#logger.info(`Saving XML${saveAsNewVersion ? " as new version" : ""}...`);
    if (!this.#xmlEditor.getXmlTree()) {
      throw new Error("Cannot save: No XML valid document in the editor");
    }
    try {
      // Show saving status
      if (this.savingStatusWidget) {
        ui.xmlEditor.statusbar.add(this.savingStatusWidget, 'left', 10);
      }
      const xmlContent = this.#xmlEditor.getXML()
      const result = await this.#client.saveXml(xmlContent, fileHash, saveAsNewVersion);
      return /** @type {{file_id: string, status: string}} */ (result);
    } finally {
      // clear status message after 1 second
      setTimeout(() => {
        if (this.savingStatusWidget) {
          ui.xmlEditor.statusbar.removeById(this.savingStatusWidget.id);
        }
      }, 1000);
    }
  }

}

export default FiledataPlugin;
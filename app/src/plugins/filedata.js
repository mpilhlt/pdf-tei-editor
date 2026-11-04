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
 * @import { SlDialog } from '../ui.js'
 * @import { gcResultDialogPart } from '../templates/gc-result-dialog.types.js'
 * @import { GarbageCollectResponse, GarbageCollectTaskResult } from '../modules/api-client-v1.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { createIdLookupIndex } from '../modules/file-data-utils.js'
import { PanelUtils } from '../modules/panels/index.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { standOffContributions, userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'

// Register templates
await registerTemplate('gc-menu-item', 'gc-menu-item.html')
await registerTemplate('gc-result-dialog', 'gc-result-dialog.html')

/**
 * Formats a byte count for display.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Formats the details of a GC task result, e.g. "records purged: 3, files deleted: 2".
 * @param {GarbageCollectTaskResult} task
 * @returns {string}
 */
function formatTaskDetails(task) {
  if (task.skipped) return 'skipped (no dry run)';
  return Object.entries(task.details || {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`)
    .join(', ');
}

/**
 * Thrown by {@link FiledataPlugin#saveXml} when the editor's XML is not well-formed.
 * Callers can use `error instanceof NoValidXmlError` to distinguish this from transport
 * or server-side errors and avoid presenting a generic "Save failed" message for what is
 * really a client-side validation problem.
 */
export class NoValidXmlError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NoValidXmlError';
  }
}

/**
 * Thrown by {@link FiledataPlugin#saveXml} when `state.editorReadOnly` is true and the
 * caller did not request a new version. This is the last line of defense against saving
 * a read-only document (see issue #420): the editor itself and all mutating UI (e.g. the
 * visual annotation mode) must already refuse to modify the document while read-only, but
 * this check guards against any path that slips through.
 */
export class ReadOnlyDocumentError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyDocumentError';
  }
}

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
  /** @type {(SlDialog & gcResultDialogPart) | null} */
  #gcResultDialog = null;

  static extensionPoints = [ep.filedata.reload, ep.filedata.saveXml];

  /**
   * Extension point handler for `ep.filedata.reload`.
   * Called to refresh the file list from the server.
   * Delegates to {@link FiledataPlugin#reload}.
   * @param {{refresh: boolean}} [options]
   * @returns {Promise<void>}
   */
  [ep.filedata.reload](...args) { return this.reload(...args) }

  /**
   * Extension point handler for `ep.filedata.saveXml`.
   * Called to persist the current XML document to the server.
   * Delegates to {@link FiledataPlugin#saveXml}.
   * @returns {Promise<void>}
   */
  [ep.filedata.saveXml](...args) { return this.saveXml(...args) }

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

      const { totals } = response;
      this.#logger.info(`GC complete: ${totals.items_deleted} items deleted, ${formatBytes(totals.bytes_freed) || '0 B'} freed`);
      this.showGarbageCollectionResult(response);

      // Reload file data to update the UI
      await this.reload({ refresh: true });
    } catch (error) {
      this.#logger.error('Garbage collection failed: ' + String(error));
      notify('Garbage collection failed: ' + String(error), 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Shows the result of a garbage collection run, one row per task.
   * @param {GarbageCollectResponse} response
   */
  showGarbageCollectionResult(response) {
    if (!this.#gcResultDialog) {
      this.#gcResultDialog = /** @type {SlDialog & gcResultDialogPart} */ (
        this.createUi(createSingleFromTemplate('gc-result-dialog', document.body))
      );
      this.#gcResultDialog.closeBtn.addEventListener('click', () => this.#gcResultDialog?.hide());
    }
    const dialog = this.#gcResultDialog;
    const { tasks = [], totals } = response;
    const errorCount = tasks.reduce((sum, task) => sum + (task.errors?.length || 0), 0);
    dialog.summary.textContent =
      `${response.dry_run ? 'Would delete' : 'Deleted'} ${totals.items_deleted} items` +
      (totals.bytes_freed ? `, ${formatBytes(totals.bytes_freed)} freed` : '') +
      (errorCount ? `; ${errorCount} error${errorCount === 1 ? '' : 's'}` : '') + '.';

    dialog.taskTableBody.replaceChildren(...tasks.map(task => {
      const row = document.createElement('tr');
      row.dataset.taskId = task.id;
      row.style.borderBottom = '1px solid var(--sl-color-neutral-200)';
      const details = formatTaskDetails(task);
      const cells = [
        { text: task.label, align: 'left' },
        { text: task.skipped ? '–' : String(task.items_deleted), align: 'right' },
        { text: formatBytes(task.bytes_freed), align: 'right' },
        { text: details, align: 'left' }
      ];
      for (const { text, align } of cells) {
        const cell = document.createElement('td');
        cell.style.padding = '0.3rem 0.5rem';
        cell.style.textAlign = align;
        cell.textContent = text;
        row.appendChild(cell);
      }
      if (!task.items_deleted && !task.bytes_freed && !details && !task.errors?.length) {
        row.style.color = 'var(--sl-color-neutral-500)';
      }
      if (task.errors?.length) {
        const errors = document.createElement('div');
        errors.style.color = 'var(--sl-color-danger-600)';
        errors.textContent = task.errors.join('; ');
        row.lastElementChild?.appendChild(errors);
      }
      return row;
    }));
    dialog.show();
  }

  /**
   * @param {ApplicationState['user']} user
   */
  onUserChange(user) {
    if (this._gcItem) this._gcItem.style.display = userIsAdmin(user) ? '' : 'none';
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

      // Load projects from server
      let projects = [];
      try {
        projects = await this.#client.listProjects();
        this.#logger.debug(`Loaded ${projects.length} projects from server`);
      } catch (error) {
        this.#logger.error(`Failed to load projects: ${error}`);
      }

      // Store fileData, collections, and projects in state and propagate them
      const newState = await this.dispatchStateChange({
        fileData: data,
        collections,
        projects
      });
      return newState;
    } finally {
      this._reloadInProgress = false;
    }
  }

  /**
   * Saves the current XML content to a file.
   *
   * If the editor contains malformed XML this method throws a {@link NoValidXmlError} so
   * callers can distinguish it from a transport or server error. Callers that auto-save
   * (e.g. XmlEditorPlugin.#saveIfDirty) should pre-check `xmlEditor.getXmlTree()` and keep
   * the user's content in a local draft instead of attempting the save.
   *
   * If `state.editorReadOnly` is true and `saveAsNewVersion` is not set, this method throws
   * a {@link ReadOnlyDocumentError} instead of overwriting the document (issue #420). Saving
   * as a new version is still allowed while read-only, since it creates a separate file
   * rather than modifying the read-only one. Users who may review or comment the read-only
   * document (see `standOffContributions()`) save their review marks and comments instead: the
   * server takes only those from the text.
   *
   * @param {string} fileHash The hash identifying the XML file on the server
   * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version
   * @returns {Promise<{file_id:string, status:string}>} An object with file_id (stable file identifier) and status
   * @throws {ReadOnlyDocumentError} when the document is read-only and a new version was not requested
   * @throws {NoValidXmlError} when the editor has no parseable XML tree
   * @throws {Error} on transport/server failures
   */
  async saveXml(fileHash, saveAsNewVersion = false) {
    this.#logger.info(`Saving XML${saveAsNewVersion ? " as new version" : ""}...`);
    let standOffOnly = false;
    if (this.state?.editorReadOnly && !saveAsNewVersion) {
      const contributions = standOffContributions(this.state.user, fileHash);
      if (this.state.connectionLost || !(contributions.reviews || contributions.comments)) {
        throw new ReadOnlyDocumentError('Cannot save: the document is read-only.');
      }
      standOffOnly = true;
    }
    if (!this.#xmlEditor.getXmlTree()) {
      throw new NoValidXmlError(
        'Cannot save: the XML in the editor is not well-formed. Fix XML errors and try again.'
      );
    }
    try {
      // Show saving status in the headerbar (right-aligned).
      if (this.savingStatusWidget) {
        this.getDependency('xmleditor').addHeaderbarWidget(this.savingStatusWidget, 'right', 3);
      }
      const xmlContent = this.#xmlEditor.getXML()
      if (standOffOnly) {
        const response = await this.#client.apiClient.filesSaveStandOff(fileHash, { xml_string: xmlContent });
        return { file_id: response.stable_id, status: response.status };
      }
      const result = await this.#client.saveXml(xmlContent, fileHash, saveAsNewVersion);
      return /** @type {{file_id: string, status: string}} */ (result);
    } finally {
      // clear status message after 1 second
      setTimeout(() => {
        if (this.savingStatusWidget) {
          this.getDependency('xmleditor').removeHeaderbarWidget(this.savingStatusWidget.id);
        }
      }, 1000);
    }
  }

}

export default FiledataPlugin;
/**
 * File Data Management Plugin
 * 
 * Handles file data operations including loading file lists, saving XML files,
 * and managing file-related state updates.
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { logger, client, dialog, xmlEditor } from '../app.js'
import { createHashLookupIndex } from '../modules/file-data-utils.js'
import { PanelUtils } from '../modules/panels/index.js'
import ui from '../ui.js'

/**
 * File data management plugin
 */
class FiledataPlugin extends Plugin {
  constructor(context) {
    super(context, { 
      name: 'filedata',
      deps: ['logger', 'client', 'dialog', 'xmleditor'] 
    });
    
    /** @type {StatusText} */
    this.savingStatusWidget = null;
  }

  async install(state) {
    await super.install(state);
    
    logger.debug(`Installing plugin "${this.name}"`);

    // Initialize empty hash lookup index to prevent errors during plugin initialization
    logger.debug('Initializing empty hash lookup index during installation');
    createHashLookupIndex([]);

    // Create status widget for save operations
    this.savingStatusWidget = PanelUtils.createText({
      text: 'Saving...',
      icon: 'upload',
      variant: 'primary',
      name: 'savingStatus'
    });
  }

  /**
   * Reloads the file data from the server
   * @param {Object} options - Options for reloading
   * @param {boolean} [options.refresh] - Whether to force refresh of server cache
   * @returns {Promise<ApplicationState>} Updated state with new file data
   */
  async reload(options = {}) {
    logger.debug("Reloading file data" + (options.refresh ? " with cache refresh" : ""));
    
    let data = await client.getFileList(null, options.refresh);
    
    if (!data || data.length === 0) {
      dialog.error("No files found");
      data = []; // Ensure data is an empty array instead of null/undefined
    }
    
    // Create hash lookup index when fileData is loaded
    if (data && data.length > 0) {
      logger.debug('Creating hash lookup index for file data');
      createHashLookupIndex(data);
    } else {
      // Initialize empty hash lookup index to prevent errors
      logger.debug('Initializing empty hash lookup index');
      createHashLookupIndex([]);
    }
    
    // Store fileData in state and propagate it
    return await this.dispatchStateChange({fileData: data});
  }

  /**
   * Saves the current XML content to a file
   * @param {string} filePath The path to the XML file on the server
   * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version 
   * @returns {Promise<{hash:string, status:string}>} An object with a path property, containing the path to the saved version
   * @throws {Error}
   */
  async saveXml(filePath, saveAsNewVersion = false) {
    logger.info(`Saving XML${saveAsNewVersion ? " as new version" : ""}...`);
    if (!xmlEditor.getXmlTree()) {
      throw new Error("No XML valid document in the editor");
    }
    try {
      // Show saving status
      if (this.savingStatusWidget && !this.savingStatusWidget.isConnected) {
        if (ui.xmlEditor.statusbar) {
          ui.xmlEditor.statusbar.add(this.savingStatusWidget, 'left', 10);
        }
      }
      return await client.saveXml(xmlEditor.getXML(), filePath, saveAsNewVersion);
    } catch (e) {
      console.error("Error while saving XML:", e.message);
      dialog.error(`Could not save XML: ${e.message}`);
      throw new Error(`Could not save XML: ${e.message}`);
    } finally {
      // clear status message after 1 second 
      setTimeout(() => {
        if (this.savingStatusWidget && this.savingStatusWidget.isConnected) {
          ui.xmlEditor.statusbar.removeById(this.savingStatusWidget.id);
        }
      }, 1000);
    }
  }

  // Override to expose custom endpoints
  getEndpoints() {
    return {
      ...super.getEndpoints(),
      'filedata.reload': this.reload.bind(this),
      'filedata.saveXml': this.saveXml.bind(this)
    };
  }
}

export default FiledataPlugin;
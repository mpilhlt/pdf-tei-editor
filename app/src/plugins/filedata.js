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
 */

import { endpoints as ep } from '../app.js'
import { Plugin } from '../modules/plugin-base.js'
import { logger, client, dialog, xmlEditor } from '../app.js'
import { createHashLookupIndex } from '../modules/file-data-utils.js'
import { PanelUtils } from '../modules/panels/index.js'
import ui from '../ui.js'

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
      deps: ['logger', 'client', 'dialog', 'xmleditor'] 
    });
    
    /** @type {StatusText | null} */
    this.savingStatusWidget = null;
  }

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state);
    logger.debug(`Installing plugin "${this.name}"`);

    // Initialize empty hash lookup index to prevent errors during plugin initialization
    logger.debug('Initializing empty hash lookup index during installation');
    createHashLookupIndex([]);

    // Create status widget for save operations
    this.savingStatusWidget = PanelUtils.createText({
      text: '',
      icon: 'floppy',
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
    const newState = await this.dispatchStateChange({fileData: data});
    return newState
  }

  /**
   * Saves the current XML content to a file
   * @param {string} fileHash The hash identifying the XML file on the server
   * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version 
   * @returns {Promise<{hash:string, status:string}>} An object with a path property, containing the path to the saved version
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
      return /** @type {{hash: string, status: string}} */ (result);
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
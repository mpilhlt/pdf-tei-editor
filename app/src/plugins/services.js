/**
 * This component provides the core services that can be called programmatically or via user commands
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 * @import { SlButton } from '../ui.js'
 */

import { app, endpoints as ep } from '../app.js'
import ui from '../ui.js'
import {
  client, logger, dialog, config,
  fileselection, xmlEditor, pdfViewer,
  services, validation, authentication,
  sync, accessControl
} from '../app.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import { UrlHash } from '../modules/browser-utils.js'
import { notify } from '../modules/sl-utils.js'
import { resolveDeduplicated } from '../modules/codemirror_utils.js'
import { ApiError } from '../modules/utils.js'

/**
 * plugin API
 */
const api = {
  load,
  validateXml,
  showMergeView,
  removeMergeView,
  downloadXml,
  uploadXml,
  inProgress,
  searchNodeContentsInPdf
}

/**
 * component plugin
 * @type {PluginConfig}
 */
const plugin = {
  name: "services",
  deps: ['file-selection', 'document-actions'],
  install,
  onStateUpdate,
  validation: { inProgress },
  shutdown
}

export { plugin, api }
export default plugin

// Status widget for saving progress moved to filedata plugin
// Current state for use in event handlers
/** @type {ApplicationState|null} */
let currentState = null

//
// UI
//

/**
 * TEI services button group navigation properties
 * @typedef {object} teiServicesPart
 * @property {SlButton} validate - Validate XML button
 * @property {SlButton} teiWizard - TEI Wizard button (added by tei-wizard plugin)
 */


//
// Implementation
//


/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // === TEI button group ===

  const ta = ui.toolbar.teiActions
  // validate xml button
  ta.validate.addEventListener('click', onClickValidateButton);

  // enable save button on dirty editor
  xmlEditor.on("editorReady",() => {ui.toolbar.documentActions.saveRevision.disabled = false});
}

/**
 * @param {(keyof ApplicationState)[]} changedKeys
 * @param {ApplicationState} state
 */
async function onStateUpdate(changedKeys, state) {

}


/**
 * Invoked when a plugin starts a validation
 * @param {Promise<any>} validationPromise 
 */
async function inProgress(validationPromise) {
  // do not start validation if another one is going on
  ui.toolbar.teiActions.validate.disabled = true
  await validationPromise
  ui.toolbar.teiActions.validate.disabled = false
}

/**
 * Called when the application is shutting down (beforeunload)
 * Release any file locks held by this session
 */
async function shutdown() {
  if (currentState?.xml && !currentState?.editorReadOnly) {
    try {
      await client.releaseLock(currentState.xml);
      logger.debug(`Released lock for file ${currentState.xml} during shutdown`);
    } catch (error) {
      // Don't throw during shutdown - just log the error
      console.warn('Failed to release lock during shutdown:', String(error));
    }
  }
}

/**
 * Loads the given XML and/or PDF file(s) into the editor and viewer
 * @param {{xml?: string | null, pdf?: string | null}} files An Object with one or more of the keys "xml" and "pdf"
 */
async function load({ xml, pdf }) {

  // use application state instead of
  const currentState = app.getCurrentState() 
  const stateChanges = {}

  const promises = []
  let file_is_locked = false

  // PDF 
  if (pdf) {
    await app.updateState({ pdf: null, xml: null, diff: null })
    logger.info("Loading PDF: " + pdf)
    // Convert document identifier to static file URL
    const pdfUrl = `/api/files/${pdf}` // TODO unhardcode this!
    promises.push(pdfViewer.load(pdfUrl))
  }

  // XML
  if (xml) {
    // Always check for lock before loading, even if file is already in state
    // (e.g., when opening same URL in new tab with sessionStorage containing stale state)
    const isNewFile = currentState.xml !== xml;

    try {
      ui.spinner.show('Loading file, please wait...')

      // Release previous lock if we're switching files
      if (isNewFile && currentState.xml && !currentState.editorReadOnly) {
        await client.releaseLock(currentState.xml)
      }

      // Check access control before attempting to acquire lock
      const canEdit = accessControl.checkCanEditFile(xml)
      if (!canEdit) {
        logger.debug(`User does not have edit permission for file ${xml}, loading in read-only mode`);
        file_is_locked = true
      } else {
        try {
          await client.acquireLock(xml);
          logger.debug(`Acquired lock for file ${xml}`);
        } catch (error) {
          if (error instanceof client.LockedError) {
            logger.debug(`File ${xml} is locked, loading in read-only mode`);
            file_is_locked = true
          } else {
            const errorMessage = String(error);
            dialog.error(errorMessage)
            throw error
          }
        }
      }
    } finally {
      ui.spinner.hide()
    }

    // Always load XML content and update state
    await removeMergeView()
    await app.updateState({ xml: null, diff: null, editorReadOnly: file_is_locked })
    logger.info(`Loading XML: ${xml} (read-only: ${file_is_locked})`)
    // Convert document identifier to static file URL
    const xmlUrl = `/api/files/${xml}`
    promises.push(xmlEditor.loadXml(xmlUrl))
  }

  // await promises in parallel
  try {
    await Promise.all(promises)
  } catch (error) {
    if (error instanceof ApiError) {
      // @ts-ignore
      if (error.status === 404) {
        logger.warn(String(error))
        await fileselection.reload()
        return
      }
    }
    throw error
  }

  if (pdf) {
    stateChanges.pdf = pdf
  }
  if (xml) {
    stateChanges.xml = xml
    // call asynchronously, don't block the editor
    startAutocomplete().then(result => {
      result && logger.info("Autocomplete is available")
    })
  }

  // Set collection and variant based on loaded documents
  if (currentState.fileData && (pdf || xml)) {
    for (const file of currentState.fileData) {
      const fileData = /** @type {any} */ (file);

      let foundMatch = false;

      // Check source id
      if (pdf && fileData.source && fileData.source.id === pdf) {
        if (!currentState.collection) {
          stateChanges.collection = fileData.collections[0];
        }
        foundMatch = true;
      }

      // Check XML id in artifacts (don't skip this even if PDF was found)
      if (xml) {
        const matchingArtifact = fileData.artifacts && fileData.artifacts.find(/** @param {any} artifact */ artifact => artifact.id === xml);
        if (matchingArtifact) {
          if (!currentState.collection) {
            stateChanges.collection = fileData.collections[0];
          }
          // Always set variant from artifact (it's the source of truth for the loaded document)
          if (matchingArtifact.variant) {
            stateChanges.variant = matchingArtifact.variant;
          }
          foundMatch = true;
        }
      }

      // Only break if we found what we're looking for
      if (foundMatch) {
        break;
      }
    }
  }

  // notify plugins
  await app.updateState(stateChanges)
}

async function startAutocomplete() {
  // Load autocomplete data asynchronously after XML is loaded
  try {
    logger.debug("Loading autocomplete data for XML document")
    const xmlContent = xmlEditor.getEditorContent()
    if (xmlContent) {
      try {
        const invalidateCache = currentState?.hasInternet
        const autocompleteData = await client.getAutocompleteData(xmlContent, invalidateCache)
        
        // Resolve deduplicated references
        const resolvedData = resolveDeduplicated(autocompleteData)
        
        // Start autocomplete with the resolved data
        xmlEditor.startAutocomplete(resolvedData)
        logger.debug("Autocomplete data loaded and applied")
      } catch (error) {
        if (error instanceof ApiError) {
          logger.info("No autocomplete data available: " + String(error))
        } else {
          throw error
        }
      }
    }
    return true 
  } catch (error) {
    const errorMessage = String(error);
    logger.warn("Failed to load autocomplete data: " + errorMessage)
    return false
  }
}

/**
 * Validates the XML document by calling the validation service
 * @returns {Promise<object[]>}
 */
async function validateXml() {
  logger.info("Validating XML...")
  return await validation.validate() // todo use endpoint instead
}

/**
 * Creates a diff between the current and the given document and shows a merge view
 * @param {string} diff The path to the xml document with which to compare the current xml doc
 */
async function showMergeView(diff) {
  if (!diff || typeof diff != "string") {
    throw new TypeError("Invalid diff value");
  }
  logger.info("Loading diff XML: " + diff)
  ui.spinner.show('Computing file differences, please wait...')
  try {
    // Convert document identifier to static file URL
    const diffUrl = `/api/files/${diff}`
    await xmlEditor.showMergeView(diffUrl)
    if (currentState.diff !== diff) {
      await app.updateState({ diff: diff })
    }
    // turn validation off as it creates too much visual noise
    validation.configure({ mode: "off" })
  } finally {
    ui.spinner.hide()
  }
}

/**
 * Removes all remaining diffs
 */
async function removeMergeView() {
  xmlEditor.hideMergeView()
  // re-enable validation
  validation.configure({ mode: "auto" })
  if (currentState.diff) {
    UrlHash.remove("diff")
    await app.updateState({ diff: null })
  }
}

/**
 * Deletes the current version of the document
 * This will remove the XML file from the server and reload the gold version
 * @param {ApplicationState} state
 */

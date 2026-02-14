/**
 * This component provides inter-plugin orchestration methods
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 */

import { app, endpoints as ep, services } from '../app.js'
import ui from '../ui.js'
import {
  client, logger, dialog, config, fileselection, xmlEditor, pdfViewer, validation, accessControl, sse, pluginManager
} from '../app.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import { UrlHash } from '../modules/browser-utils.js'
import { notify } from '../modules/sl-utils.js'
import { resolveDeduplicated } from '../modules/codemirror/codemirror-utils.js'
import { ApiError } from '../modules/utils.js'
import { encodeXmlEntities } from '../modules/tei-utils.js'

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
  shutdown
}

export { plugin, api }
export default plugin

// Status widget for saving progress moved to filedata plugin
// Current state for use in event handlers
/** @type {ApplicationState|null} */
let currentState = null

//
// Implementation
//


/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // enable save button on dirty editor
  xmlEditor.on("editorReady",() => {ui.toolbar.documentActions.saveRevision.disabled = false});

  // Listen for maintenance mode events
  sse.addEventListener('maintenanceOn', async (event) => {
    const data = JSON.parse(event.data);
    await app.updateState({ maintenanceMode: true });
    ui.spinner.show(data.message || '');
  });

  sse.addEventListener('maintenanceOff', async (event) => {
    ui.spinner.hide();
    await app.updateState({ maintenanceMode: false });
    const data = JSON.parse(event.data);
    if (data.message) {
      dialog.info(data.message);
    }
  });

  sse.addEventListener('maintenanceReload', () => {
    window.location.reload();
  });

  // Listen for lock release events to attempt acquiring locks for read-only documents
  sse.addEventListener('lockReleased', async (event) => {
    const data = JSON.parse(event.data);
    const releasedStableId = data.stable_id;

    // Check if we're currently viewing this document in read-only mode
    if (currentState.xml === releasedStableId && currentState.editorReadOnly) {
      logger.debug(`Lock released for current document ${releasedStableId}, attempting to acquire`);

      try {
        // Try to acquire the lock (first client wins)
        await client.acquireLock(releasedStableId);
        logger.info(`Successfully acquired lock for ${releasedStableId}`);

        // Update state to allow editing        
        notify(
          'You can now edit this document',
          'success',
          'unlock'
        );
        await services.load({xml: releasedStableId})
        await app.updateState({ editorReadOnly: false });

      } catch (error) {
        if (error instanceof client.LockedError) {
          logger.debug(`Lock already acquired by another client for ${releasedStableId}`);
          // Another client got the lock first, stay in read-only mode
        } else {
          logger.error(`Failed to acquire lock for ${releasedStableId}: ${error}`);
        }
      }
    }
  });
}

/**
 * @param {(keyof ApplicationState)[]} changedKeys
 * @param {ApplicationState} state
 */
async function onStateUpdate(changedKeys, state) {
  currentState = state;
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

  // Signal loading state to disable selectboxes
  await pluginManager.invoke(ep.filedata.loading, true);

  try {
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
            notify(
              'This document is being edited by another user',
              'warning',
              'exclamation-triangle'
            );
          } else if (error instanceof client.ApiError && error.statusCode === 403) {
            // Permission denied - load in read-only mode
            logger.debug(`No edit permission for file ${xml}, loading in read-only mode`);
            file_is_locked = true
            notify(
              'You do not have permission to edit this document. Create your own version to make changes.',
              'warning',
              'lock'
            );
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
  } finally {
    // Clear loading state
    await pluginManager.invoke(ep.filedata.loading, false);
  }
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
    if (!currentState || currentState.diff !== diff) {
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
  if (currentState && currentState.diff) {
    UrlHash.remove("diff")
    await app.updateState({ diff: null })
  }
}

/**
 * Downloads the current XML file
 * @param {ApplicationState} state
 */
async function downloadXml(state) {
  if (!state.xml) {
    throw new TypeError("State does not contain an xml path")
  }
  let xml = xmlEditor.getXML()
  if (await config.get('xml.encode-entities.server')) {
    const encodeQuotes = await config.get('xml.encode-quotes', false)
    xml = encodeXmlEntities(xml, { encodeQuotes })
  }
  const blob = new Blob([xml], { type: 'application/xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url

  const fileData = getFileDataById(state.xml);
  let filename = fileData?.file?.doc_id || state.xml;

  // Add variant name to filename if variant exists
  // The item could be a version or gold file which has variant
  const variant = fileData?.item?.variant;
  if (variant) {
    // Extract the variant name from variant (e.g., "grobid.training.segmentation" -> "training.segmentation")
    const variantName = variant.replace(/^grobid\./, '');
    filename = `${filename}.${variantName}`;
  }

  a.download = `${filename}.tei.xml`;

  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Uploads an XML file, creating a new version for the currently selected document
 * @param {ApplicationState} state
 */
async function uploadXml(state) {
  const uploadResult = await client.uploadFile(undefined, { accept: '.xml' })
  const tempFilename = /** @type {any} */ (uploadResult).filename
  // @ts-ignore
  const { path } = await client.createVersionFromUpload(tempFilename, state.xml)
  await fileselection.reload()
  const { services } = await import('../app.js')
  await services.load({ xml: path })
  notify("Document was uploaded. You are now editing the new version.")
}

/**
 * Given a Node in the XML, search and highlight its text content in the PDF Viewer
 * @param {Element} node
 */
async function searchNodeContentsInPdf(node) {

  let searchTerms = getNodeText(node)
    // Split on whitespace only; keep hyphenated compounds intact since the
    // span-level scorer handles prefix/suffix matching for line-break hyphens
    .reduce((/**@type {string[]}*/acc, term) => acc.concat(term.split(/\s+/u)), [])
    .filter(term => term.length > 0);

  // make the list of search terms unique
  searchTerms = Array.from(new Set(searchTerms))

  // add footnote number as required anchor term
  // Check the node and its ancestors for a source attribute (handles clicks on child elements)
  let anchorTerm = null;
  let sourceNode = node;
  while (sourceNode && sourceNode.nodeType === Node.ELEMENT_NODE) {
    if (sourceNode.hasAttribute("source")) {
      const source = sourceNode.getAttribute("source");
      if (source?.slice(0, 2) === "fn") {
        anchorTerm = source.slice(2);
        searchTerms.unshift(anchorTerm);
        break;
      }
    }
    sourceNode = sourceNode.parentElement;
  }

  // start search - if anchorTerm is set, clusters must contain it
  await pdfViewer.search(searchTerms, { anchorTerm });
}

/**
 * Returns a list of non-empty text content from all text nodes contained in the given node
 * @param {Element} node
 * @returns {Array<string>}
 */
function getNodeText(node) {
  // @ts-ignore
  return getTextNodes(node).map(node => node.textContent?.trim()).filter(Boolean)
}

/**
 * Recursively extracts all text nodes contained in the given node into a flat list
 * @param {Node} node
 * @return {Array<Node>}
 */
function getTextNodes(node) {
  /** @type {Node[]} */
  let textNodes = [];
  if (node.nodeType === Node.TEXT_NODE) {
    textNodes.push(node);
  } else {
    for (let i = 0; i < node.childNodes.length; i++) {
      textNodes = textNodes.concat(getTextNodes(node.childNodes[i]));
    }
  }
  return textNodes;
}

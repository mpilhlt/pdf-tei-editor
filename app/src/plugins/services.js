/**
 * This component provides the core services that can be called programmatically or via user commands
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 * @import { SlButton, SlInput } from '../ui.js'
 * @import { RespStmt, RevisionChange, Edition} from '../modules/tei-utils.js'
 */

import { app, endpoints as ep } from '../app.js'
import ui, { updateUi } from '../ui.js'
import {
  client, logger, dialog, config,
  fileselection, xmlEditor, pdfViewer,
  services, validation, authentication,
  sync, accessControl, testLog
} from '../app.js'
import FiledataPlugin from './filedata.js'
import { getFileDataByHash } from '../modules/file-data-utils.js'
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../ui.js'
import { UrlHash } from '../modules/browser-utils.js'
import { notify } from '../modules/sl-utils.js'
import * as tei_utils from '../modules/tei-utils.js'
import { resolveDeduplicated } from '../modules/codemirror_utils.js'
import { prettyPrintXmlDom } from './tei-wizard/enhancements/pretty-print-xml.js'
import { ApiError } from '../modules/utils.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'

/**
 * plugin API
 */
const api = {
  load,
  validateXml,
  showMergeView,
  removeMergeView,
  deleteCurrentVersion,
  deleteAllVersions,
  deleteAll,
  addTeiHeaderInfo,
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
  deps: ['file-selection'],
  install,
  state: { update },
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
 * Document actions button group navigation properties
 * @typedef {object} documentActionsPart
 * @property {SlButton} saveRevision - Save current revision button
 * @property {SlButton} createNewVersion - Create new version button
 * @property {SlButton} upload - Upload file button
 * @property {SlButton} download - Download file button
 * @property {SlButton} deleteBtn - Delete dropdown button
 * @property {SlButton} deleteCurrentVersion - Delete current version button
 * @property {SlButton} deleteAllVersions - Delete all versions button
 * @property {SlButton} deleteAll - Delete all files button
 */

/**
 * TEI services button group navigation properties
 * @typedef {object} teiServicesPart
 * @property {SlButton} validate - Validate XML button
 * @property {SlButton} teiWizard - TEI Wizard button (added by tei-wizard plugin)
 */

/**
 * Dialog for creating a new version
 * @typedef {object} newVersionDialogPart
 * @property {SlInput} versionName 
 * @property {SlInput} persName 
 * @property {SlInput} persId 
 * @property {SlInput} editionNote
 * @property {SlButton} submit
 * @property {SlButton} cancel 
 */

/**
 * Dialog for documenting a revision navigation properties
 * @typedef {object} newRevisionChangeDialogPart
 * @property {SlInput} persId - Person ID input
 * @property {SlInput} persName - Person name input
 * @property {SlInput} changeDesc - Change description input
 * @property {SlButton} submit - Submit button
 * @property {SlButton} cancel - Cancel button
 */

// Register templates
await registerTemplate('document-action-buttons', 'document-action-buttons.html');
await registerTemplate('new-version-dialog', 'new-version-dialog.html');
await registerTemplate('save-revision-dialog', 'save-revision-dialog.html');


//
// Implementation
//


/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create UI elements
  const documentActionButtons = createFromTemplate('document-action-buttons');
  createSingleFromTemplate('new-version-dialog', document.body);
  createSingleFromTemplate('save-revision-dialog', document.body);

  // Add document action buttons to toolbar with medium priority
  documentActionButtons.forEach(buttonGroup => {
    // Ensure we're working with HTMLElement
    if (buttonGroup instanceof HTMLElement) {
      // Document actions have medium priority (lower than file selection)
      ui.toolbar.add(buttonGroup, 8);
    }
  });
  updateUi() // Update UI so navigation objects are available
  
  // Saving status widget creation moved to filedata plugin


  // === Document button group ===

  const da = ui.toolbar.documentActions

  // save a revision
  da.saveRevision.addEventListener('click', () => {
    if (currentState) saveRevision(currentState);
  });
  // enable save button on dirty editor
  xmlEditor.on("editorReady",() => {da.saveRevision.disabled = false});

  // delete
  da.deleteCurrentVersion.addEventListener("click", () => {
    if (currentState) deleteCurrentVersion(currentState);
  })
  da.deleteAllVersions.addEventListener('click', () => {
    if (currentState) deleteAllVersions(currentState);
  })
  da.deleteAll.addEventListener('click', () => {
    if (currentState) deleteAll(currentState);
  })

  // new version
  da.createNewVersion.addEventListener("click", () => {
    if (currentState) createNewVersion(currentState);
  })

  // download
  da.download.addEventListener("click", () => {
    if (currentState) downloadXml(currentState);
  })

  // upload
  da.upload.addEventListener("click", () => {
    if (currentState) uploadXml(currentState);
  })

  // === TEI button group ===

  const ta = ui.toolbar.teiActions
  // validate xml button
  ta.validate.addEventListener('click', onClickValidateButton);
}

/**
 * Invoked on application state change
 * @param {ApplicationState} state
 */
async function update(state) {
  // Store current state for use in event handlers
  currentState = state;

  // disable deletion if there are no versions or gold is selected
  const da = ui.toolbar.documentActions

  da.childNodes.forEach(el => {
    if (el instanceof HTMLElement && 'disabled' in el) {
      // @ts-ignore
      el.disabled = state.offline
    }
  })
  if (state.offline) {
    return
  }

  const isReviewer = userHasRole(currentState.user, ["admin", "reviewer"])
  const isAnnotator = userHasRole(currentState.user, ["admin", "reviewer", "annotator"])

  // disable/enable delete buttons
  if (isAnnotator || isReviewer) {
    da.deleteAll.disabled = !Boolean(state.pdf && state.xml) || !isReviewer // Disable if no pdf and no xml)
    da.deleteAllVersions.disabled = !isReviewer || ui.toolbar.xml.querySelectorAll("sl-option").length  < 2 // disable if only one document left (gold version)
    da.deleteCurrentVersion.disabled = !state.xml || state.editorReadOnly || (isGoldFile(currentState.xml) && !isReviewer)
  } else {
    for (let btn of [da.deleteAll, da.deleteAllVersions, da.deleteCurrentVersion]) {
      btn.disabled = true
    }
  }
  
  da.deleteBtn.disabled = 
    da.deleteCurrentVersion.disabled && 
    da.deleteAllVersions.disabled && 
    da.deleteAll.disabled

  // Allow new version or revisions only if we have an xml path
  if (isAnnotator) {

    da.saveRevision.disabled =  !Boolean(state.xml) || state.editorReadOnly 
    da.createNewVersion.disabled = !Boolean(state.xml) 
    
    // Allow download only if we have an xml path
    da.download.disabled = !Boolean(state.xml)

    // no uploads if editor is readonly
    da.upload.disabled = state.editorReadOnly 
  } else {
    for (let btn of [da.saveRevision, da.createNewVersion, da.download, da.upload]) {
      btn.disabled = true
    }
  }
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
    const pdfUrl = `/api/files/${pdf}`
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

  // Set collection based on loaded documents if not already set
  if (currentState.fileData && (pdf || xml) && !currentState.collection) {
    for (const file of currentState.fileData) {
      const fileData = /** @type {any} */ (file);
      // Check PDF hash
      if (pdf && fileData.pdf && fileData.pdf.hash === pdf) {
        stateChanges.collection = fileData.collection;
        break;
      }
      // Check XML hash in gold or versions
      if (xml) {
        const hasGoldMatch = fileData.gold && fileData.gold.some(/** @param {any} gold */ gold => gold.hash === xml);
        const hasVersionMatch = fileData.versions && fileData.versions.some(/** @param {any} version */ version => version.hash === xml);
        if (hasGoldMatch || hasVersionMatch) {
          stateChanges.collection = fileData.collection;
          break;
        }
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
 * @param {ApplicationState} state
 * @param {string} diff The path to the xml document with which to compare the current xml doc
 */
async function showMergeView(state, diff) {
  logger.info("Loading diff XML: " + diff)
  ui.spinner.show('Computing file differences, please wait...')
  try {
    // Convert document identifier to static file URL
    const diffUrl = `/api/files/${diff}`
    await xmlEditor.showMergeView(diffUrl)
    await app.updateState({ diff: diff })
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
  UrlHash.remove("diff")
  await app.updateState({ diff: null })
}

/**
 * Deletes the current version of the document
 * This will remove the XML file from the server and reload the gold version
 * @param {ApplicationState} state
 */
async function deleteCurrentVersion(state) {
  // Handle both PDF-XML files and XML-only files
  let xmlValue = ui.toolbar.xml.value;
  let selectedOption = ui.toolbar.xml.selectedOptions[0];

  // For XML-only files, the XML might be selected in the PDF dropdown instead
  if (!xmlValue && state.xml && !state.pdf) {
    xmlValue = state.xml;
    // Find the option in the PDF dropdown that corresponds to this XML file
    selectedOption = ui.toolbar.pdf.selectedOptions[0];
  }

  if (!xmlValue) {
    dialog.error("No file selected for deletion")
    return
  }

  // Use helper function to check if this is a gold file
  // XML-only files (where state.pdf is null) can always be deleted
  if (state.pdf && typeof xmlValue === 'string') {

    // Only check for gold status if this is a PDF-XML file
    const fileData = getFileDataByHash(xmlValue);
    if (fileData && fileData.type === 'gold' && !userHasRole(state.user, ['admin', 'reviewer'])) {
      dialog.error("You cannot delete the gold version")
    }
  }

  const filePathsToDelete = [xmlValue]
  if (filePathsToDelete.length > 0) {
    const versionName = selectedOption ? selectedOption.textContent : 'current version';
    const msg = `Are you sure you want to delete the current version "${versionName}"?`
    if (!confirm(msg)) return; // todo use dialog
    services.removeMergeView()
    // delete the file
    await client.deleteFiles(/** @type {string[]} */ (filePathsToDelete))
    try {
      // Clear current XML state after successful deletion
      await app.updateState({ xml: null })
      // update the file data
      await fileselection.reload()
      // load the gold version
      // @ts-ignore
      const xml = ui.toolbar.xml.firstChild?.value
      await load({ xml })
      notify(`Version "${versionName}" has been deleted.`)
      sync.syncFiles(state)
        .then(summary => summary && console.debug(summary))
        .catch(e => console.error(e))
    } catch (error) {
      console.error(error)
      const errorMessage = String(error);
      dialog.error(errorMessage)
    }
  }
}

/**
 * Deletes all versions of the document, leaving only the gold standard version
 * Only deletes versions that match the current variant filter
 */
async function deleteAllVersions() {
  if (!currentState?.fileData) {
    throw new Error("No file data");
  }
  // Get the current PDF to find all its versions
  const currentPdf = ui.toolbar.pdf.value;
  const selectedFile = currentState.fileData.find(file => file.pdf.hash === currentPdf);

  if (!selectedFile || !selectedFile.versions) {
    return; // No versions to delete
  }

  // Filter versions based on current variant selection (same logic as file-selection.js)
  let versionsToDelete = selectedFile.versions;
  const { variant } = currentState;

  if (variant === "none") {
    // Delete only versions without variant_id
    versionsToDelete = selectedFile.versions.filter(/** @param {any} version */ version => !version.variant_id);
  } else if (variant && variant !== "") {
    // Delete only versions with the selected variant_id
    versionsToDelete = selectedFile.versions.filter(/** @param {any} version */ version => version.variant_id === variant);
  }
  // If variant is "" (All), delete all versions

  const filePathsToDelete = versionsToDelete.map(/** @param {any} version */ version => version.hash);
  
  if (filePathsToDelete.length > 0) {
    const variantText = variant === "none" ? "without variant" : 
                      variant && variant !== "" ? `with variant "${variant}"` : "";
    const msg = `Are you sure you want to delete ${filePathsToDelete.length} version(s) ${variantText}? This cannot be undone.`
    if (!confirm(msg)) return; // todo use dialog
  } else {
    // No versions match the current variant filter
    const variantText = variant === "none" ? "without variant" : `with variant "${variant}"`;
    notify(`No versions ${variantText} found to delete.`);
    return;
  }
  services.removeMergeView()
  // delete
  await client.deleteFiles(filePathsToDelete)
  try {
    // Clear current XML state after successful deletion
    await app.updateState({ xml: null })
    // update the file data
    await fileselection.reload()
    
    // Find and load the appropriate gold version for the current variant
    let goldToLoad = null;
    if (selectedFile.gold) {
      if (variant === "none") {
        // Load gold version without variant_id
        goldToLoad = selectedFile.gold.find(/** @param {any} gold */ gold => !gold.variant_id);
      } else if (variant && variant !== "") {
        // Load gold version with matching variant_id
        goldToLoad = selectedFile.gold.find(/** @param {any} gold */ gold => gold.variant_id === variant);
      } else {
        // Load first available gold version
        goldToLoad = selectedFile.gold[0];
      }
    }
    
    if (goldToLoad) {
      await load({ xml: goldToLoad.hash });
    }
    
    const variantText = variant === "none" ? "without variant" : 
                      variant && variant !== "" ? `with variant "${variant}"` : "";
    notify(`All versions ${variantText} have been deleted`)
    sync.syncFiles(state)
      .then(summary => summary && console.debug(summary))
      .catch(e => console.error(e))
  } catch (error) {
    console.error(error)
    const errorMessage = String(error);
    dialog.error(errorMessage)
  } 
}

/**
 * Deletes all versions of the document and the PDF file
 * @param {ApplicationState} state
 */
async function deleteAll(state) {

  if (ui.toolbar.pdf.childElementCount < 2) {
    throw new Error("Cannot delete all files, at least one PDF must be present")
  }

  // @ts-ignore
  const filePathsToDelete = Array.from(new Set([ui.toolbar.pdf.value]
    // @ts-ignore
    .concat(Array.from(ui.toolbar.xml.childNodes).map(option => option.value))
    // @ts-ignore
    .concat(Array.from(ui.toolbar.diff.childNodes).map(option => option.value))))
    .filter(Boolean)

  if (filePathsToDelete.length > 0) {
    const msg = `Are you sure you want to delete ${filePathsToDelete.length} files? This cannot be undone.`
    if (!confirm(msg)) return; // todo use dialog
  }

  services.removeMergeView()
  logger.debug("Deleting files:" + filePathsToDelete.join(", "))
  
  try {
    await client.deleteFiles(/** @type {string[]} */ (filePathsToDelete))
    notify(`${filePathsToDelete.length} files have been deleted.`)
    sync.syncFiles(state)
      .then(summary => summary && console.debug(summary))
      .catch(e => console.error(e))
  } catch (error) {
    const errorMessage = String(error);
    console.error(errorMessage)
    notify(errorMessage, "warning")
  } finally {
    // update the file data
    await fileselection.reload({refresh:true})
    // remove xml and pdf
    await app.updateState({xml: null, pdf: null})
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
    xml = tei_utils.encodeXmlEntities(xml)
  }
  const blob = new Blob([xml], { type: 'application/xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url

  const fileData = getFileDataByHash(state.xml);
  console.warn(fileData)
  const filename = fileData?.file?.fileref || state.xml;
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
  await load({ xml: path })
  notify("Document was uploaded. You are now editing the new version.")
}


/**
 * Given a Node in the XML, search and highlight its text content in the PDF Viewer
 * @param {Element} node 
 */
async function searchNodeContentsInPdf(node) {

  let searchTerms = getNodeText(node)
    // split all node text along whitespace and hypen/dash characters
    .reduce((/**@type {string[]}*/acc, term) => acc.concat(term.split(/[\s\p{Pd}]/gu)), [])
    // Search terms must be more than three characters or consist of digits. This is to remove 
    // the most common "stop words" which would litter the search results with false positives.
    // This incorrectly removes hyphenated word parts but the alternative would be to  have to 
    // deal with language-specific stop words
    .filter(term => term.match(/\d+/) ? true : term.length > 3);

  // make the list of search terms unique
  searchTerms = Array.from(new Set(searchTerms))

  // add footnote
  if (node.hasAttribute("source")) {
    const source = node.getAttribute("source")
    // get footnote number 
    if (source?.slice(0, 2) === "fn") {
      // remove the doi prefix
      searchTerms.unshift(source.slice(2) + " ")
    }
  }

  // start search
  await pdfViewer.search(searchTerms);
}

//
// event listeners
//

/**
 * Called when the "Validate" button is executed
 */
async function onClickValidateButton() {
  ui.toolbar.teiActions.validate.disabled = true
  const diagnostics = await validateXml()
  notify(`The document contains ${diagnostics.length} validation error${diagnostics.length === 1 ? '' : 's'}.`)
}


/**
 * Given a user object, get an id (typically by using the initials)
 * @param {any} userData
 */
function getIdFromUser(userData) {
  let names = userData.fullname
  if (names && names.trim() !== "") {
    names = userData.fullname.split(" ")
  } else {
    return userData.username
  }
  if (names.length > 1) {
    return names.map(/** @param {any} n */ n => n[0]).join("").toLocaleLowerCase()
  }
  return names[0].slice(0, 3)
}

/**
 * Called when the "saveRevision" button is executed
 * @param {ApplicationState} state
 */
async function saveRevision(state) {

  // @ts-ignore
  const revDlg = ui.newRevisionChangeDialog;
  revDlg.changeDesc.value = "Corrections"
  try {
    const user = authentication.getUser()
    if (user) {
      const userData = /** @type {any} */ (user);
      revDlg.persId.disabled = revDlg.persName.disabled = true
      revDlg.persId.value = userData.username
      revDlg.persName.value = userData.fullname
    }
    revDlg.show()
    await new Promise((resolve, reject) => {
      revDlg.submit.addEventListener('click', resolve, { once: true })
      revDlg.cancel.addEventListener('click', reject, { once: true })
      revDlg.addEventListener('sl-hide', reject, { once: true })
    })
  } catch (e) {
    console.warn("User cancelled")
    return
  } finally {
    revDlg.hide()
  }

  revDlg.hide()

  /** @type {RespStmt} */
  const respStmt = {
    persId: revDlg.persId.value,
    persName: revDlg.persName.value,
    resp: "Annotator"
  }

  /** @type {RevisionChange} */
  const revisionChange = {
    status: "draft",
    persId: revDlg.persId.value,
    desc: revDlg.changeDesc.value
  }
  ui.toolbar.documentActions.saveRevision.disabled = true
  try {
    await addTeiHeaderInfo(respStmt, undefined, revisionChange)
    if (!state.xml) throw new Error('No XML file loaded')

    const filedata = FiledataPlugin.getInstance()
    await filedata.saveXml(state.xml)

    testLog('REVISION_SAVED', { changeDescription: revDlg.changeDesc.value });

    // Verify revision was added to XML content (self-contained for bundle removal)
    testLog('REVISION_IN_XML_VERIFIED', {
      changeDescription: revDlg.changeDesc.value,
      xmlContainsRevision: xmlEditor.getXML().includes(revDlg.changeDesc.value)
    });

    sync.syncFiles(state)
      .then(summary => summary && console.debug(summary))
      .catch(e => console.error(e))

    // dirty state
    xmlEditor.markAsClean()
  } catch (error) {
    console.error(error)
    dialog.error(String(error))
  } finally {
    ui.toolbar.documentActions.saveRevision.disabled = false
  }
}

/**
 * Called when the "Create new version" button is executed
 * @param {ApplicationState} state
 */
async function createNewVersion(state) {

  // @ts-ignore
  const newVersiondialog = ui.newVersionDialog;
  try {
    const userData = authentication.getUser()
    if (userData) {
      newVersiondialog.persId.value =  userData.username
      newVersiondialog.persName.value = userData.fullname
    }    
    newVersiondialog.show()
    await new Promise((resolve, reject) => {
      newVersiondialog.submit.addEventListener('click', resolve, { once: true })
      newVersiondialog.cancel.addEventListener('click', reject, { once: true })
      newVersiondialog.addEventListener('sl-hide', reject, { once: true })
    })
  } catch (e) {
    console.warn("User cancelled")
    return
  } finally {
    newVersiondialog.hide()
  }

  /** @type {RespStmt} */
  const respStmt = {
    persId: newVersiondialog.persId.value,
    persName: newVersiondialog.persName.value,
    resp: "Annotator"
  }

  /** @type {Edition} */
  const editionStmt = {
    title: newVersiondialog.versionName.value,
    note: newVersiondialog.editionNote.value
  }

  ui.toolbar.documentActions.saveRevision.disabled = true
  try {
    if (!state.xml) throw new Error('No XML file loaded');
    
    // save new version first
    const filedata = FiledataPlugin.getInstance()
    let { hash } = await filedata.saveXml(state.xml, /* save as new version */ true)

    testLog('NEW_VERSION_CREATED', { oldHash: state.xml, newHash: hash });

    // update the state to load the new document
    await load({ xml: hash })

    // now modify the header
    await addTeiHeaderInfo(respStmt, editionStmt)

    // save the modified content back to the same timestamped version file
    await filedata.saveXml(hash)
    xmlEditor.markAsClean() 

    // reload the file data to display the new name and inform the user
    await fileselection.reload({refresh:true})
    await app.updateState({ xml: hash }) // should have been done 

    notify("Document was duplicated. You are now editing the copy.")
    
    // sync the new file to the WebDav server
    if (state.webdavEnabled) {
      sync.syncFiles(state)
      .then(/** @param {any} summary */ summary => {
        if (summary) {
          logger.debug(summary);
        }
      })
      .catch(e => console.error(e))
    }
  } catch (e) {
    console.error(e)
    const errorMessage = e instanceof Error ? e.message : String(e);
    dialog.error(errorMessage)
  } finally {
    ui.toolbar.documentActions.saveRevision.disabled = false
    newVersiondialog.hide()
  }
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


/**
 * Add information on responsibitiy, edition or revisions to the document
 * @param {RespStmt} [respStmt] - Optional responsible statement details.
 * @param {Edition} [edition] - Optional edition statement details.
 * @param {RevisionChange} [revisionChange] - Optional revision statement details.
 * @throws {Error} If any of the operations to add teiHeader info fail
 */
async function addTeiHeaderInfo(respStmt, edition, revisionChange) {

  const xmlDoc = xmlEditor.getXmlTree()
  if (!xmlDoc) {
    throw new Error("No XML document loaded")
  }

  // update document: <respStmt>
  if (respStmt) {
    if (!respStmt || tei_utils.getRespStmtById(xmlDoc, respStmt.persId)) {
      console.warn("No persId or respStmt already exists for this persId")
    } else {
      tei_utils.addRespStmt(xmlDoc, respStmt)
    }
  }

  // update document: <edition>
  if (edition && currentState?.fileData) {
    const versionName = edition.title
    const editionTitleElements = xmlDoc.querySelectorAll('edition > title')
    const nameExistsInDoc = Array.from(editionTitleElements).some(elem => elem.textContent === versionName)
    const nameExistsInVersions = currentState.fileData.some(file => file.label === versionName)
    if (nameExistsInDoc || nameExistsInVersions) {
      throw new Error(`The version name "${versionName}" is already being used, pick another one.`)
    }
    tei_utils.addEdition(xmlDoc, edition)
  }
  if (revisionChange) {
    tei_utils.addRevisionChange(xmlDoc, revisionChange)
  }
  prettyPrintXmlDom(xmlDoc, 'teiHeader')
  await xmlEditor.updateEditorFromXmlTree()
}


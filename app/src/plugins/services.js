/**
 * This component provides the core services that can be called programmatically or via user commands
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlButtonGroup, SlDialog, SlInput } from '../ui.js'
 * @import { RespStmt, RevisionChange, Edition} from '../modules/tei-utils.js'
 * @import { UserData } from '../plugins/authentication.js'
 */
import ui, { updateUi } from '../ui.js'
import {
  updateState, client, logger, dialog, config,
  fileselection, xmlEditor, pdfViewer, services, validation, authentication
} from '../app.js'
import { StatusBarUtils } from '../modules/statusbar/index.js'
import { createHtmlElements } from '../ui.js'
import { UrlHash } from '../modules/browser-utils.js'
import { XMLEditor } from './xmleditor.js'
import { notify } from '../modules/sl-utils.js'
import * as tei_utils from '../modules/tei-utils.js'
import { prettyPrintXmlDom } from './tei-wizard/enhancements/pretty-print-xml.js'

/**
 * plugin API
 */
const api = {
  load,
  validateXml,
  saveXml,
  showMergeView,
  removeMergeView,
  deleteCurrentVersion,
  deleteAllVersions,
  deleteAll,
  addTeiHeaderInfo,
  downloadXml,
  uploadXml,
  inProgress,
  searchNodeContentsInPdf,
  syncFiles
}

/**
 * component plugin
 */
const plugin = {
  name: "services",
  deps: ['file-selection'],
  install,
  state: { update },
  validation: { inProgress }
}

export { plugin, api }
export default plugin

// Status widget for saving progress
let savingStatusWidget = null

//
// UI
//

/**
 * Document actions button group navigation properties
 * @typedef {object} documentActionsPart
 * @property {SlButton} saveRevision - Save current revision button
 * @property {SlButton} createNewVersion - Create new version button
 * @property {SlButton} sync - Sync files button
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

// todo align template with definition
const documentActionButtons = await createHtmlElements("document-action-buttons.html")

/**
 * Dialog for creating a new version
 * @typedef {object} newVersionDialog
 * @property {SlDialog} self
 * @property {SlInput} versionName 
 * @property {SlInput} persName 
 * @property {SlInput} persId 
 * @property {SlInput} editionNote 
 */

/** @type {newVersionDialog & SlDialog} */
// @ts-ignore
const newVersionDialog = (await createHtmlElements("new-version-dialog.html"))[0]

/**
 * Dialog for documenting a revision navigation properties
 * @typedef {object} newRevisionChangeDialogPart
 * @property {SlInput} persId - Person ID input
 * @property {SlInput} persName - Person name input
 * @property {SlInput} changeDesc - Change description input
 */

/** @type {newRevisionChangeDialogPart & SlDialog} */
// @ts-ignore
const saveRevisionDialog = (await createHtmlElements("save-revision-dialog.html"))[0]


//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // install controls on menubar
  ui.toolbar.append(...documentActionButtons)
  document.body.append(newVersionDialog)
  document.body.append(saveRevisionDialog)
  updateUi()
  
  // Create saving status widget
  savingStatusWidget = StatusBarUtils.createText({
    text: 'Saving XML...',
    variant: 'info'
  })

  const tb = ui.toolbar

  // === Document button group ===

  const da = ui.toolbar.documentActions

  // save a revision
  da.saveRevision.addEventListener('click', () => saveRevision(state));
  // enable save button on dirty editor
  xmlEditor.addEventListener(
    XMLEditor.EVENT_EDITOR_READY,
    () => da.saveRevision.disabled = false
  );

  // delete
  da.deleteCurrentVersion.addEventListener("click", () => deleteCurrentVersion(state))
  da.deleteAllVersions.addEventListener('click', () => deleteAllVersions(state))
  da.deleteAll.addEventListener('click', () => deleteAll(state))

  // new version
  da.createNewVersion.addEventListener("click", () => createNewVersion(state))

  // sync
  da.sync.addEventListener("click", () => onClickSyncBtn(state))

  // download
  da.download.addEventListener("click", () => downloadXml(state))

  // upload
  da.upload.addEventListener("click", () => uploadXml(state))

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
  //console.warn("update", plugin.name, state)

  // disable deletion if there are no versions or gold is selected
  const da = ui.toolbar.documentActions

  da.childNodes.forEach(el => el.disabled = state.offline)
  if (state.offline) {
    return
  }

  da.deleteAll.disabled = fileselection.fileData.length < 2 // at least on PDF must be present
  da.deleteAllVersions.disabled = ui.toolbar.xml.childElementCount < 2
  da.deleteCurrentVersion.disabled = ui.toolbar.xml.value === ui.toolbar.xml.firstChild?.value
  da.deleteBtn.disabled = da.deleteCurrentVersion.disabled && da.deleteAllVersions.disabled && da.deleteAll.disabled

  // Allow duplicate only if we have an xml path
  da.createNewVersion.disabled = !Boolean(state.xml)

  // Allow download only if we have an xml path
  da.download.disabled = !Boolean(state.xml)

  // disable sync and upload if webdav is not enabled
  da.sync.disabled = !state.webdavEnabled

  // no uploads if editor is readonly
  da.upload.disabled = state.editorReadOnly
  //console.warn(plugin.name,"done")
}


/**
 * Invoked when a plugin starts a validation
 * @param {Promise} validationPromise 
 */
async function inProgress(validationPromise) {
  // do not start validation if another one is going on
  ui.toolbar.teiActions.validate.disabled = true
  await validationPromise
  ui.toolbar.teiActions.validate.disabled = false
}

/**
 * Loads the given XML and/or PDF file(s) into the editor and viewer 
 * @param {ApplicationState} state
 * @param {Object} files An Object with one or more of the keys "xml" and "pdf"
 */
async function load(state, { xml, pdf }) {

  const promises = []
  let file_is_locked = false

  // PDF 
  if (pdf) {
    await updateState(state, { pdf: null, xml: null, diff: null })
    logger.info("Loading PDF: " + pdf)
    // Convert document identifier to static file URL
    const pdfUrl = `/api/files/${pdf}`
    promises.push(pdfViewer.load(pdfUrl))
  }

  // XML
  if (xml) {
    // Check for lock before loading

    if (state.xml !== xml) {
      try {
        ui.spinner.show('Loading file, please wait...')
        if (state.xml && !state.editorReadOnly) {
          await client.releaseLock(state.xml)
        }
        try {
          await client.acquireLock(xml);
          logger.debug(`Acquired lock for file ${xml}`);
        } catch (error) {
          if (error instanceof client.LockedError) {
            logger.debug(`File ${xml} is locked, loading in read-only mode`);
            notify(`File is being edited by another user, loading in read-only mode`)
            file_is_locked = true
          } else {
            dialog.error(error.message)
            throw error
          }
        }
      } finally {
        ui.spinner.hide()
      }
    }

    removeMergeView(state)
    await updateState(state, { xml: null, diff: null, editorReadOnly: file_is_locked })
    logger.info("Loading XML: " + xml)
    // Convert document identifier to static file URL
    const xmlUrl = `/api/files/${xml}`
    promises.push(xmlEditor.loadXml(xmlUrl))
  }

  // await promises in parallel
  try {
    await Promise.all(promises)
  } catch (error) {
    console.error(error.message)
    if (error.status === 404) {
      await fileselection.reload(state)
      return
    }
    throw error
  }

  if (pdf) {
    state.pdf = pdf
    // update selectboxes in the toolbar
    await fileselection.update(state)
  }
  if (xml) {
    state.xml = xml
    startAutocomplete()
  }

  // notify plugins
  await updateState(state)
}

async function startAutocomplete() {
  // Load autocomplete data asynchronously after XML is loaded
  try {
    logger.debug("Loading autocomplete data for XML document")
    const xmlContent = xmlEditor.getEditorContent()
    if (xmlContent) {
      const autocompleteData = await client.getAutocompleteData(xmlContent)
      if (autocompleteData && !autocompleteData.error) {
        // Resolve deduplicated references
        const resolvedData = tei_utils.resolveDeduplicated(autocompleteData)
        // Start autocomplete with the resolved data
        xmlEditor.startAutocomplete(resolvedData)
        logger.debug("Autocomplete data loaded and applied")
        notify("Autocomplete is available")
      } else if (autocompleteData && autocompleteData.error) {
        logger.debug("No autocomplete data available: " + autocompleteData.error)
      }
    }
  } catch (error) {
    logger.warn("Failed to load autocomplete data: " + error.message)
    // Don't block the loading process if autocomplete fails
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
 * Saves the current XML content to the server, optionally as a new version
 * @param {string} filePath The path to the XML file on the server
 * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version 
 * @returns {Promise<{path:string, status:string}>} An object with a path property, containing the path to the saved version
 * @throws {Error}
 */
async function saveXml(filePath, saveAsNewVersion = false) {
  logger.info(`Saving XML${saveAsNewVersion ? " as new version" : ""}...`);
  if (!xmlEditor.getXmlTree()) {
    throw new Error("No XML valid document in the editor")
  }
  try {
    // Show saving status
    if (savingStatusWidget && !savingStatusWidget.isConnected) {
      if (ui.xmlEditor.statusbar) {
        ui.xmlEditor.statusbar.addWidget(savingStatusWidget, 'left', 10)
      }
    }
    return await client.saveXml(xmlEditor.getXML(), filePath, saveAsNewVersion)
  } catch (e) {
    console.error("Error while saving XML:", e.message)
    dialog.error(`Could not save XML: ${e.message}`)
    throw new Error(`Could not save XML: ${e.message}`)
  } finally {
    // clear status message after 1 second 
    setTimeout(() => {
      if (savingStatusWidget && savingStatusWidget.isConnected) {
        ui.xmlEditor.statusbar.removeWidget(savingStatusWidget.id)
      }
    }, 1000)
  }
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
    updateState(state, { diff: diff })
    // turn validation off as it creates too much visual noise
    validation.configure({ mode: "off" })
  } finally {
    ui.spinner.hide()
  }
}

/**
 * Removes all remaining diffs
 */
function removeMergeView(state) {
  xmlEditor.hideMergeView()
  // re-enable validation
  validation.configure({ mode: "auto" })
  UrlHash.remove("diff")
  updateState(state, { diff: null })
}

/**
 * Deletes the current version of the document
 * This will remove the XML file from the server and reload the gold version
 * @param {ApplicationState} state
 */
async function deleteCurrentVersion(state) {
  // @ts-ignore
  if (ui.toolbar.xml.value.startsWith("/data/tei")) {
    dialog.error("You cannot delete the gold version")
    return
  }
  const filePathsToDelete = [ui.toolbar.xml.value]
  if (filePathsToDelete.length > 0) {
    const versionName = ui.toolbar.xml.selectedOptions[0].textContent
    const msg = `Are you sure you want to delete the current version "${versionName}"?`
    if (!confirm(msg)) return; // todo use dialog
    services.removeMergeView(state)
    // delete the file
    await client.deleteFiles(filePathsToDelete)
    try {
      // update the file data
      await fileselection.reload(state)
      // load the gold version
      // @ts-ignore
      const xml = ui.toolbar.xml.firstChild?.value
      await load(state, { xml })
      notify(`Version "${versionName}" has been deleted.`)
      syncFiles(state)
        .then(summary => summary && notify("Synchronized files"))
        .catch(e => console.error(e))
    } catch (error) {
      console.error(error)
      alert(error.message)
    }
  }
}

/**
 * Deletes all versions of the document, leaving only the gold standard version
 * @param {ApplicationState} state
 */
async function deleteAllVersions(state) {
  // @ts-ignore
  const xmlPaths = Array.from(ui.toolbar.xml.childNodes).map(option => option.value)
  const filePathsToDelete = xmlPaths.slice(1) // skip the first option, which is the gold standard version  
  if (filePathsToDelete.length > 0) {
    const msg = "Are you sure you want to delete all versions of this document and leave only the current gold standard version? This cannot be undone."
    if (!confirm(msg)) return; // todo use dialog
  }
  services.removeMergeView(state)
  // delete
  await client.deleteFiles(filePathsToDelete)
  try {

    // update the file data
    await fileselection.reload(state)
    // load the gold version
    await load(state, { xml: xmlPaths[0] })
    notify("All version have been deleted")
    syncFiles(state)
      .then(summary => summary && notify("Synchronized files"))
      .catch(e => console.error(e))
  } catch (error) {
    console.error(error)
    alert(error.message)
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

  if (filePathsToDelete.length > 0) {
    const msg = `Are you sure you want to delete the following files: ${filePathsToDelete.join(", ")}? This cannot be undone.`
    if (!confirm(msg)) return; // todo use dialog
  }

  services.removeMergeView(state)
  logger.debug("Deleting files:" + filePathsToDelete.join(", "))
  
  try {
    await client.deleteFiles(filePathsToDelete)
    notify(`${filePathsToDelete.length} files have been deleted.`)
    syncFiles(state)
      .then(summary => summary && notify("Synchronized files"))
      .catch(e => console.error(e))
  } catch (error) {
    console.error(error.message)
    notify(error.message, "warning")
  } finally {
    // update the file data
    await fileselection.reload(state)
    // load the first PDF and XML file 
    await load(state, {
      pdf: fileselection.fileData[0].pdf.hash,
      xml: fileselection.fileData[0].gold?.[0]?.hash || fileselection.fileData[0].versions?.[0]?.hash
    })
  }
}

/**
 * Synchronizes the files on the server with the WebDAV backend, if so configured
 * @param {ApplicationState} state 
 */
async function syncFiles(state) {
  if (state.webdavEnabled) {
    logger.debug("Synchronizing files on the server")
    const summary = await client.syncFiles()
    logger.debug(summary)
    return summary
  }
  return false
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
  a.download = state.xml.split('/').pop() || 'document.xml'
  a.click()
  URL.revokeObjectURL(url)
}


/**
 * Uploads an XML file, creating a new version for the currently selected document
 * @param {ApplicationState} state 
 */
async function uploadXml(state) {
  const { filename: tempFilename } = await client.uploadFile(undefined, { accept: '.xml' })
  // @ts-ignore
  const { path } = await client.createVersionFromUpload(tempFilename, state.xml)
  await fileselection.reload(state)
  await load(state, { xml: path })
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
 * @param {UserData} userData 
 */
function getIdFromUser(userData) {
  let names = userData.fullname
  if (names && names.trim() !== "") {
    names = userData.fullname.split(" ")
  } else {
    return userData.username
  }
  if (names.length > 1) {
    return names.map(n => n[0]).join("").toLocaleLowerCase()
  }
  return names[0].slice(0, 3)
}

/**
 * Called when the "saveRevision" button is executed
 * @param {ApplicationState} state
 */
async function saveRevision(state) {

  /** @type {newVersionDialog} */
  const dialog = document.querySelector('[name="newRevisionChangeDialog"]')
  dialog.changeDesc.value = "Corrections"
  try {
    const user = authentication.getUser()
    console.warn(user)
    if (user) {
      dialog.persId.value = dialog.persId.value || getIdFromUser(user)
      dialog.persName.value = dialog.persName.value || user.fullname
    }
    dialog.show()
    await new Promise((resolve, reject) => {
      dialog.submit.addEventListener('click', resolve, { once: true })
      dialog.cancel.addEventListener('click', reject, { once: true })
      dialog.addEventListener('sl-hide', reject, { once: true })
    })
  } catch (e) {
    console.warn("User cancelled")
    return
  } finally {
    dialog.hide()
  }

  dialog.hide()

  /** @type {RespStmt} */
  const respStmt = {
    persId: dialog.persId.value,
    persName: dialog.persName.value,
    resp: "Annotator"
  }

  /** @type {RevisionChange} */
  const revisionChange = {
    status: "draft",
    persId: dialog.persId.value,
    desc: dialog.changeDesc.value
  }
  ui.toolbar.documentActions.saveRevision.disabled = true
  try {
    await addTeiHeaderInfo(respStmt, null, revisionChange)
    const result = await saveXml(state.xml)
    
    // If migration occurred, first reload file data, then update state
    if (result.status === "saved_with_migration") {
      await fileselection.reload(state)
      state.xml = result.path
      await updateState(state)
    }
    
    notify("Document was saved.")
    syncFiles(state)
      .then(summary => summary && notify("Synchronized files"))
      .catch(e => console.error(e))

    // dirty state
    xmlEditor.markAsClean()
  } catch (e) {
    console.error(e)
    alert(e.message)
  } finally {
    ui.toolbar.documentActions.saveRevision.disabled = false
  }
}

/**
 * Called when the "Create new version" button is executed
 * @param {ApplicationState} state
 */
async function createNewVersion(state) {

  /** @type {newVersionDialog} */
  const dialog = document.querySelector('[name="newVersionDialog"]')
  try {
    const user = authentication.getUser()
    if (user) {
      dialog.persId.value = dialog.persId.value || getIdFromUser(user)
      dialog.persName.value = dialog.persName.value || user.fullname
    }    
    dialog.show()
    await new Promise((resolve, reject) => {
      dialog.submit.addEventListener('click', resolve, { once: true })
      dialog.cancel.addEventListener('click', reject, { once: true })
      dialog.addEventListener('sl-hide', reject, { once: true })
    })
  } catch (e) {
    console.warn("User cancelled")
    return
  } finally {
    dialog.hide()
  }

  /** @type {RespStmt} */
  const respStmt = {
    persId: dialog.persId.value,
    persName: dialog.persName.value,
    resp: "Annotator"
  }

  /** @type {Edition} */
  const editionStmt = {
    title: dialog.versionName.value,
    note: dialog.editionNote.value
  }

  ui.toolbar.documentActions.saveRevision.disabled = true
  try {
    // save new version first
    let { path } = await saveXml(state.xml, true)

    // update the state to load the new document
    state.xml = path
    state.diff = path
    await updateState(state)

    // now modify the header
    await addTeiHeaderInfo(respStmt, editionStmt)

    // save again to the new path
    await saveXml(path)
    xmlEditor.markAsClean() 

    // reload the file data to display the new name and inform the user
    await fileselection.reload(state)
    notify("Document was duplicated. You are now editing the copy.")
    
    // sync the new file to the WebDav server
    if (state.webdavEnabled) {
      syncFiles(state)
      .then(summary => summary && notify("Synchronized files"))
      .catch(e => console.error(e))
    }
  } catch (e) {
    console.error(e)
    alert(e.message)
  } finally {
    ui.toolbar.documentActions.saveRevision.disabled = false
    dialog.hide()
  }
}

async function onClickSyncBtn(state) {
  let summary
  ui.spinner.show('Synchronizing files, please wait...')
  try {
    summary = await syncFiles(state)
  } catch (e) {
    throw e
  } finally {
    ui.spinner.hide()
  }
  if (summary) {
    let msg = []
    for (const [action, count] of Object.entries(summary)) {
      if (count > 0) {
        msg.push(`${action.replace('_', ' ')}: ${count}`)
      }
    }
    if (msg.length > 0) {
      notify(msg.join(", "))
      // something has changed, reload the file data
      await fileselection.reload(state)
    }
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
 * @return {Array<Node>}
 */
function getTextNodes(node) {
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
  if (edition) {
    const versionName = edition.title
    const nameExistsInDoc = Array.from(xmlDoc.querySelector('edition > title') || []).some(elem => elem.textContent === versionName)
    const nameExistsInVersions = fileselection.fileData.some(file => file.label === versionName)
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


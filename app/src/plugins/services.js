/**
 * This component provides the core services that can be called programmatically or via user commands
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlButtonGroup, SlDialog, SlInput } from '../ui.js'
 * @import { RespStmt, RevisionChange, Edition} from '../modules/tei-utils.js'
 */
import ui from '../ui.js'
import { updateState, client, logger, dialog, 
  fileselection, xmlEditor, pdfViewer, services, validation } from '../app.js'
import { appendHtml } from '../ui.js'
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
  searchNodeContentsInPdf
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

/**
 * Document actions button group
 * @typedef {object} documentActionsComponent
 * @property {SlButtonGroup} self
 * @property {SlButton} saveRevision 
 * @property {SlButton} createNewVersion
 * @property {SlButton} upload
 * @property {SlButton} download
 * @property {SlButton} deleteBtn
 * @property {SlButton} deleteCurrentVersion
 * @property {SlButton} deleteAllVersions
 * @property {SlButton} deleteAll
 */

/**
 * TEI actions button group
 * @typedef {object} teiServicesComponents
 * @property {SlButtonGroup} self
 * @property {SlButton} validate 
 */

const toolbarActionsHtml = `
<span class="hbox-with-gap toolbar-content">
  <!-- Document button group -->
  <sl-button-group label="Document" name="documentActions">

    <!-- document revision -->
    <sl-tooltip content="Save document revision">
      <sl-button name="saveRevision" size="small" disabled>
        <sl-icon name="save"></sl-icon>
      </sl-button>
    </sl-tooltip>

    <!-- duplicate -->
    <sl-tooltip content="Duplicate current document to make changes">
      <sl-button name="createNewVersion" size="small" disabled>
        <sl-icon name="copy"></sl-icon>
      </sl-button>
    </sl-tooltip>  
    
    <!-- upload, not implemented yet -->
    <sl-tooltip content="Upload document">
      <sl-button name="upload" size="small">
        <sl-icon name="cloud-upload"></sl-icon>
      </sl-button>
    </sl-tooltip>    

    <!-- download -->
    <sl-tooltip content="Download XML document">
      <sl-button name="download" size="small" disabled>
        <sl-icon name="cloud-download"></sl-icon>
      </sl-button>
    </sl-tooltip>   

    <!-- delete -->
    <sl-button-group>
      <sl-dropdown placement="bottom-end">
        <sl-button name="deleteBtn" size="small" slot="trigger" caret>
          <sl-icon name="trash3"></sl-icon>
        </sl-button>
        <sl-menu>
          <sl-menu-item name="deleteCurrentVersion">Delete current version</sl-menu-item>
          <sl-menu-item name="deleteAllVersions">Delete all versions</sl-menu-item>
          <sl-menu-item name="deleteAll">Delete PDF and XML</sl-menu-item>
        </sl-menu>
      </sl-dropdown>
    </sl-button-group>
    
  </sl-button-group>

  <!-- TEI -->
  <sl-button-group label="TEI" name="teiActions">

    <!-- validate -->
    <sl-tooltip content="Validate the document">
      <sl-button name="validate" size="small" disabled>
        <sl-icon name="file-earmark-check"></sl-icon>
      </sl-button> 
    </sl-tooltip>

  </sl-button-group>
</span>
`

/**
 * Dialog for creating a new version
 * @typedef {object} newVersionDialog
 * @property {SlDialog} self
 * @property {SlInput} versionName 
 * @property {SlInput} persName 
 * @property {SlInput} persId 
 * @property {SlInput} editionNote 
 */
const newVersionDialogHtml = `
<sl-dialog name="newVersionDialog" label="Create new version">
  <div class="dialog-column">
    <sl-input name="versionName" label="Version Name" size="small" help-text="Provide a short name for the version (required)"></sl-input>
    <sl-input name="persId" label="Initials" size="small" help-text="Your initials (required)"></sl-input>
    <sl-input name="persName" label="Editor Name" size="small" help-text="Your name, if this is your first edit on this document"></sl-input>
    <sl-input name="editionNote" label="Description" size="small" help-text="Description of this version (optional)"></sl-input>
  </div>
  <sl-button slot="footer" name="cancel" variant="neutral">Cancel</sl-button>
  <sl-button slot="footer" name="submit" variant="primary">Create new version</sl-button>  
</sl-dialog>
`

/**
 * Dialog for documenting a revision
 * @typedef {object} newRevisionChangeDialog
 * @property {SlDialog} self
 * @property {SlInput} persId
 * @property {SlInput} persName 
 * @property {SlInput} changeDesc 
 */
const saveChangeDialogHtml = `
<sl-dialog name="newRevisionChangeDialog" label="Add a change description">
  <div class="dialog-column">
    Document changes of this 
    <sl-input name="persId" label="Initials" size="small" help-text="Your initials (required)"></sl-input>
    <sl-input name="persName" label="Editor Name" size="small" help-text="Your name, if this is your first edit on this document"></sl-input>
    <sl-input name="changeDesc" label="Description" size="small" help-text="Description of the change"></sl-input>
  </div>
  <sl-button slot="footer" name="cancel" variant="neutral">Cancel</sl-button>
  <sl-button slot="footer" name="submit" variant="primary">Add</sl-button>  
</sl-dialog>
`

//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
function install(state) {
  const tb = ui.toolbar.self
  
  // install controls on menubar
  appendHtml(toolbarActionsHtml, tb)

  // install dialogs
  appendHtml(newVersionDialogHtml)
  appendHtml(saveChangeDialogHtml)

  // === Document button group ===

  const da = ui.toolbar.documentActions
  // save a revision
  da.saveRevision.addEventListener('click', () => onClickSaveRevisionButton(state));
  // enable save button on dirty editor
  xmlEditor.addEventListener(
    XMLEditor.EVENT_XML_CHANGED,
    () =>  da.saveRevision.disabled = false
  );

  // delete
  da.deleteCurrentVersion.addEventListener("click", () => deleteCurrentVersion(state))
  da.deleteAllVersions.addEventListener('click', () => deleteAllVersions(state))
  da.deleteAll.addEventListener('click', () => deleteAll(state))
  
  // duplicate
  da.createNewVersion.addEventListener("click", () => onClickCreateNewVersionButton(state))

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
  // disable deletion if there are no versions or gold is selected
  const da = ui.toolbar.documentActions
  da.deleteAll.disabled = ui.toolbar.pdf.childElementCount < 2 // at least on PDF must be present
  da.deleteAllVersions.disabled = ui.toolbar.xml.childElementCount < 2 
  da.deleteCurrentVersion.disabled = ui.toolbar.xml.value === ui.toolbar.xml.firstChild?.value
  da.deleteBtn.disabled = da.deleteCurrentVersion.disabled && da.deleteAllVersions.disabled && da.deleteAll.disabled

  // Allow duplicate only if we have an xml path
  da.createNewVersion.disabled = !Boolean(state.xmlPath)

  // Allow download only if we have an xml path
  da.download.disabled = !Boolean(state.xmlPath)
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

  // PDF 
  if (pdf) {
    logger.info("Loading PDF: " + pdf)
    promises.push(pdfViewer.load(pdf))
  }

  // XML
  if (xml) {
    logger.info("Loading XML: " + xml)
    removeMergeView(state)
    state.diffXmlPath = null
    promises.push(xmlEditor.loadXml(xml))
  }

  // await promises in parallel
  await Promise.all(promises)

  if (pdf) {
    state.pdfPath = pdf
    // update selectboxes in the toolbar
    await fileselection.update(state)
  }
  if (xml) {
    state.xmlPath = xml
  }
  // notify plugins
  updateState(state)
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
 * @returns {Promise<{path:string}>} An object with a path property, containing the path to the saved version
 */
async function saveXml(filePath, saveAsNewVersion=false) {
  logger.info(`Saving XML${saveAsNewVersion ? " as new version":""}...`);
  if (!xmlEditor.getXmlTree()) {
    throw new Error("No XML valid document in the editor")
  }
  return await client.saveXml(xmlEditor.getXML(), filePath, saveAsNewVersion)
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
    await xmlEditor.showMergeView(diff)
    updateState(state, {diffXmlPath: diff})
    // turn validation off as it creates too much visual noise
    validation.configure({mode:"off"})
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
  validation.configure({mode:"auto"})
  UrlHash.remove("diff")
  updateState(state, {diffXmlPath:null})
}

/**
 * Deletes the current version of the document
 * This will remove the XML file from the server and reload the gold version
 * @param {ApplicationState} state
 */
async function deleteCurrentVersion(state){  
  // @ts-ignore
  if (ui.toolbar.xml.value.startsWith("/data/tei")) {
    dialog.error("You cannot delete the gold version")
    return
  }
  const filePathsToDelete = [ui.toolbar.xml.value]
  if (filePathsToDelete.length > 0) {
    await client.deleteFiles(filePathsToDelete)
  }
  try {
    const versionName = ui.toolbar.xml.selectedOptions[0].textContent
    const msg = `Are you sure you want to delete the current version "${versionName}"?`
    if (!confirm(msg)) return; // todo use dialog
    services.removeMergeView(state)
    // update the file data
    await fileselection.reload(state)
    // load the gold version
    // @ts-ignore
    const xml = ui.toolbar.xml.firstChild?.value 
    await load(state, { xml })
    notify(`Version "${versionName}" has been deleted.`)
  } catch (error) {
    console.error(error)
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
    services.removeMergeView(state)
    await client.deleteFiles(filePathsToDelete)
  }
  try {
    // update the file data
    await fileselection.reload(state)
    // load the gold version
    await load(state, { xml:xmlPaths[0] })
    notify("All version have been deleted")
  } catch (error) {
    console.error(error)
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
  const filePathsToDelete = [ui.toolbar.pdf.value]
    .concat(Array.from(ui.toolbar.xml.childNodes).map(option => option.value))
    
  if (filePathsToDelete.length > 0) {
    const msg = `Are you sure you want to delete the current PDF and all XML versions? This cannot be undone.`
    if (!confirm(msg)) return; // todo use dialog
    services.removeMergeView(state)
    console.debug("Deleting files:", filePathsToDelete)
    await client.deleteFiles(filePathsToDelete)
  }
  try {
    // update the file data
    await fileselection.reload(state)

    // load the first PDF and XML file 
    await load(state, { 
      pdf: fileselection.fileData[0].pdf, 
      xml: fileselection.fileData[0].xml 
    })
    notify("All files have been deleted")
  } catch (error) {
    console.error(error)
  }
}



/**
 * Add information on responsibitiy, edition or revisions to the document
 * @param {RespStmt} [respStmt] - Optional responsible statement details.
 * @param {Edition} [edition] - Optional edition statement details.
 * @param {RevisionChange} [revisionChange] - Optional revision statement details.
 * @throws {Error} If any of the operations to add teiHeader info fail
 */
async function addTeiHeaderInfo(respStmt, edition, revisionChange ) {

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
    if (nameExistsInDoc || nameExistsInVersions ) {
      throw new Error(`The version name "${versionName}" is already being used, pick another one.`)
    }
    tei_utils.addEdition(xmlDoc, edition)
  }
  if (revisionChange) {
    tei_utils.addRevisionChange(xmlDoc, revisionChange)
  }
  prettyPrintXmlDom(xmlDoc)
  await xmlEditor.updateEditorFromXmlTree()
}

/**
 * Downloads the current XML file
 * @param {ApplicationState} state
 */
function downloadXml(state) {
  if (!state.xmlPath) {
    throw new TypeError("State does not contain an xml path")
  }
  const xml = xmlEditor.getXML()
  const blob = new Blob([xml], { type: 'application/xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = state.xmlPath.split('/').pop() || 'document.xml'
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Given a Node in the XML, search and highlight its text content in the PDF Viewer
 * @param {Element} node 
 */
async function searchNodeContentsInPdf(node) {

  let searchTerms = getNodeText(node)
    // split all node text along whitespace and hypen/dash characters
    .reduce( (/**@type {string[]}*/acc, term) => acc.concat(term.split(/[\s\p{Pd}]/gu)), [])
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
 * Called when the "saveRevision" button is executed
 * @param {ApplicationState} state
 */
async function onClickSaveRevisionButton(state) {

  /** @type {newVersionDialog} */
  const dialog = document.querySelector('[name="newRevisionChangeDialog"]')
  dialog.changeDesc.value = "Corrections"
  try {
    dialog.show()
    await new Promise((resolve, reject) =>{
      dialog.submit.addEventListener('click', resolve, {once: true})
      dialog.cancel.addEventListener('click', reject, {once: true})
      dialog.self.addEventListener('sl-hide', reject, {once: true})
    })
  } catch (e) {
    console.warn("User cancelled")
    return 
  } finally {
    dialog.hide()
  }

  dialog.hide()

  /** @type {RespStmt} */
  const respStmt= {
    persId: dialog.persId.value,
    persName: dialog.persName.value,
    resp: "Contributor"
  }

  /** @type {RevisionChange} */
  const revisionChange = {
    status: "draft",
    persId: dialog.persId.value,
    desc: dialog.changeDesc.value
  }
  try {
    await addTeiHeaderInfo(respStmt, null, revisionChange)
    await saveXml(state.xmlPath)
    ui.toolbar.documentActions.saveRevision.disabled = true
    // dirty state
    xmlEditor.isDirty = false
    notify("Document was saved.")
  } catch(e) {
    console.error(e)
    alert(e.message)
  } 
}

/**
 * Called when the "Create new version" button is executed
 * @param {ApplicationState} state
 */
async function onClickCreateNewVersionButton(state) {

  /** @type {newVersionDialog} */
  const dialog = document.querySelector('[name="newVersionDialog"]')
  try {
    dialog.show()
    await new Promise((resolve, reject) =>{
      dialog.submit.addEventListener('click', resolve, {once: true})
      dialog.cancel.addEventListener('click', reject, {once: true})
      dialog.self.addEventListener('sl-hide', reject, {once: true})
    })
  } catch (e) {
    console.warn("User cancelled")
    return 
  } finally {
    dialog.hide()
  }

  /** @type {RespStmt} */
  const respStmt= {
    persId: dialog.persId.value,
    persName: dialog.persName.value,
    resp: "Contributor"
  }

  /** @type {Edition} */
  const editionStmt = {
    title: dialog.versionName.value,
    note: dialog.editionNote.value
  }

  try {
    await addTeiHeaderInfo(respStmt, editionStmt)
    ui.toolbar.documentActions.saveRevision.disabled = true

    // save new version
    let {path} = await saveXml(state.xmlPath, true)
    state.xmlPath = path
    state.diffXmlPath = path
    await fileselection.reload(state)
    await updateState(state)
    // dirty state
    xmlEditor.isDirty = false

    notify("Document was duplicated. You are now editing the copy.")
  } catch(e) {
    console.error(e)
    alert(e.message)
  } finally {
    dialog.hide()
  }
}

/**
 * Uploads an XML file, creating a new version for the currently selected document
 * @param {ApplicationState} state 
 */
async function uploadXml(state) {
  const { filename: tempFilename } = await client.uploadFile(undefined, { accept: '.xml' })
  const { path } = await client.createVersionFromUpload(tempFilename, state.xmlPath)
  await fileselection.reload(state)
  await load(state, { xml: path })
  notify("Document was uploaded. You are now editing the new version.")
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


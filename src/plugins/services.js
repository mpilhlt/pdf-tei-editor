/**
 * This component provides the core services that can be called programmatically or via user commands
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlButtonGroup, SlInput } from '../ui.js'
 */
import ui from '../ui.js'
import { invoke, updateState, endpoints, client, logger, dialog, 
  fileselection, xmlEditor, pdfViewer, services, validation } from '../app.js'
import { appendHtml } from '../ui.js'
import { UrlHash } from '../modules/browser-utils.js'
import { XMLEditor } from './xmleditor.js'
import { notify } from '../modules/sl-utils.js'

/**
 * plugin API
 */
const api = {
  load,
  validateXml,
  saveXml,
  showMergeView,
  removeMergeView,
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
 * @property {SlButton} saveXml 
 * @property {SlButton} duplicateXml
 * @property {SlButton} upload
 * @property {SlButton} download
 * @property {SlButton} deleteBtn
 * @property {SlButton} deleteCurrent 
 * @property {SlButton} deleteCurrent 
 * @property {SlButton} deleteAll
 */

/**
 * TEI actions button group
 * @typedef {object} teiServicesComponents
 * @property {SlButtonGroup} self
 * @property {SlButton} validate 
 * @property {SlButton} teiWizard
 */

const toolbarActionsHtml = `
<span class="hbox-with-gap toolbar-content">
  <!-- Document button group -->
  <sl-button-group label="Document" name="documentActions">
    <!-- save -->
    <sl-tooltip content="Save document content to server">
      <sl-button name="saveXml" size="small" disabled>
        <sl-icon name="save"></sl-icon>
      </sl-button>
    </sl-tooltip>

    <!-- duplicate -->
    <sl-tooltip content="Duplicate current document to make changes">
      <sl-button name="duplicateXml" size="small" disabled>
        <sl-icon name="copy"></sl-icon>
      </sl-button>
    </sl-tooltip>  
    
    <!-- upload, not implemented yet -->
    <sl-tooltip content="Upload document">
      <sl-button name="upload" size="small" disabled>
        <sl-icon name="cloud-upload"></sl-icon>
      </sl-button>
    </sl-tooltip>    

    <!-- download, not implemented yet -->
    <sl-tooltip content="Download XML document">
      <sl-button name="download" size="small" disabled>
        <sl-icon name="cloud-download"></sl-icon>
      </sl-button>
    </sl-tooltip>   

    <!-- delete -->
    <sl-button-group>
      <sl-dropdown placement="bottom-end">
        <sl-button name="deleteBtn" size="small" slot="trigger" size="small" caret>
          <sl-icon name="trash3"></sl-icon>
        </sl-button>
        <sl-menu>
          <sl-menu-item name="deleteCurrent">Delete current version</sl-menu-item>
          <sl-menu-item name="deleteAll">Delete all versions</sl-menu-item>
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

    <!-- enhance TEI -->
    <sl-tooltip content="Enhance TEI, i.e. add missing attributes">
      <sl-button name="teiWizard" size="small">
        <sl-icon name="magic"></sl-icon>
      </sl-button>
    </sl-tooltip> 

  </sl-button-group>
</span>
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

  // === Document button group ===

  const da = ui.toolbar.documentActions
  // save current version
  da.saveXml.addEventListener('click', () => onClickSaveButton());
  // enable save button on dirty editor
  xmlEditor.addEventListener(
    XMLEditor.EVENT_XML_CHANGED,
    () =>  da.saveXml.disabled = false
  );

  // delete
  da.deleteCurrent.addEventListener("click", () => deleteCurrentVersion(state))
  da.deleteAll.addEventListener('click', () => deleteAllVersions(state))
  
  // duplicate
  da.duplicateXml.addEventListener("click", () => onClickDuplicateButton(state))

  // === TEI button group ===

  const ta = ui.toolbar.teiActions
  // validate xml button
  ta.validate.addEventListener('click', onClickValidateButton);

  // wizard
  ta.teiWizard.addEventListener("click", runTeiWizard)
}

/**
 * Invoked on application state change
 * @param {ApplicationState} state
 */
async function update(state) {
  // disable deletion if there are no versions or gold is selected
  const da = ui.toolbar.documentActions
  
  da.deleteBtn.disabled = da.deleteAll.disabled = da.deleteCurrent.disabled = (
    ui.toolbar.xml.childElementCount < 2 || 
    // @ts-ignore
    ui.toolbar.xml.value === ui.toolbar.xml.firstChild?.value
  )

  // Allow duplicate only if we have an xml path
  da.duplicateXml.disabled = !Boolean(state.xmlPath)
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
    removeMergeView()
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
  return await client.saveXml(xmlEditor.getXML(), filePath, saveAsNewVersion)
}

/**
 * Creates a diff between the current and the given document and shows a merge view
 * @param {string} diff The path to the xml document with which to compare the current xml doc
 */
async function showMergeView(diff) {
  logger.info("Loading diff XML: " + diff)
  ui.spinner.show('Computing file differences, please wait...')
  try {
    await xmlEditor.showMergeView(diff)
  } finally {
    ui.spinner.hide()
  }
}


/**
 * Removes all remaining diffs
 */
function removeMergeView() {
  xmlEditor.hideMergeView()
  UrlHash.remove("diff")
}

/**
 * Called when the "delete-all" button is executed
 * @param {ApplicationState} state
 */
async function deleteCurrentVersion(state){
  const versionName = ui.toolbar.xml.selectedOptions[0].textContent
  const msg = `Are you sure you want to delete the current version "${versionName}"?`
  if (!confirm(msg)) return; // todo use dialog

  services.removeMergeView()
  
  // delete files 
  
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
 * Called when the "delete-all" button is executed
 * @param {ApplicationState} state
 */
async function deleteAllVersions(state) {
  const msg = "Are you sure you want to clean up the extraction history? This will delete all versions of this document and leave only the current gold standard version."
  if (!confirm(msg)) return; // todo use dialog

  services.removeMergeView()
  
  // delete files 
  // @ts-ignore
  const xmlPaths = Array.from(ui.toolbar.xml.childNodes).map(option => option.value)
  const filePathsToDelete = xmlPaths.slice(1) // skip the first option, which is the gold standard version  
  if (filePathsToDelete.length > 0) {
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
 * Saves the current file as a new version
 * @param {ApplicationState} state
 */
async function duplicateXml(state) {
  if (!state.xmlPath) {
    throw new TypeError("State does not contain an xml path")
  }
  let {path} = await saveXml(state.xmlPath, true)
  await fileselection.reload(state)
  state.xmlPath = path
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


/**
 * Invokes all TEI enhancement plugin enpoints
 */
async function runTeiWizard() {
  const teiDoc = xmlEditor.getXmlTree()
  if (!teiDoc) return
  const invocationResult = await invoke(endpoints.tei.enhancement, teiDoc)
  // todo check if there are any changes
  const enhancedTeiDoc = invocationResult[0]
  const xmlstring = (new XMLSerializer()).serializeToString(enhancedTeiDoc).replace(/ xmlns=".+?"/, '')
  xmlEditor.showMergeView(xmlstring)
  ui.floatingPanel.diffNavigation.self
    .querySelectorAll("button")
    .forEach(node => node.disabled = false)
}

// event listeners


/**
 * Called when the "Validate" button is executed
 */
async function onClickValidateButton() {
  ui.toolbar.teiActions.validate.disabled = true
  const diagnostics = await validateXml()
  notify(`The document contains ${diagnostics.length} validation error${diagnostics.length === 1 ? '' : 's'}.`)
}

/**
 * Called when the "Save" button is executed
 */
async function onClickSaveButton() {
  const xmlPath = ui.toolbar.xml.value;
  // @ts-ignore
  await saveXml(xmlPath)
  ui.toolbar.documentActions.saveXml.disabled = true
  notify("Document was saved.")
}

/**
 * Called when the "Save" button is executed
 * @param {ApplicationState} state
 */
async function onClickDuplicateButton(state) {
  await duplicateXml(state)
  ui.toolbar.documentActions.saveXml.disabled = true
  notify("Document was duplicated. You are now editing the copy.")
}

// helper methods

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
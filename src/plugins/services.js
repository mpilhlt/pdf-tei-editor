/**
 * This component provides the core services that can be called programmatically or via user commands
 */

import SlButton from '@shoelace-style/shoelace/dist/components/button/button.js'
import SlIcon from '@shoelace-style/shoelace/dist/components/icon/icon.js'
import SlTooltip from '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js'
import SlMenu from '@shoelace-style/shoelace/dist/components/menu/menu.js'
import SlMenuItem from '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js'

import { app, PdfTeiEditor } from '../app.js'
import { getNameMap, UrlHash } from '../modules/browser-utils.js'
import { validationEvents } from '../modules/lint.js' // Todo remove this dependency, use events instead
import { XMLEditor } from './xmleditor.js'
import { notify } from '../modules/sl-utils.js'

// name of the component
const name = "services"

const commandBarHtml = `
<span class="hbox-with-gap">
  <!-- Document button group -->
  <sl-button-group label="Document" name="document-group">
    <!-- save -->
    <sl-tooltip content="Save document content to server">
      <sl-button name="save-xml" size="small" disabled>
        <sl-icon name="save"></sl-icon>
      </sl-button>
    </sl-tooltip>

    <!-- duplicate -->
    <sl-tooltip content="Duplicate current document to make changes">
      <sl-button name="duplicate-xml" size="small" disabled>
        <sl-icon name="copy"></sl-icon>
      </sl-button>
    </sl-tooltip>  
    
    <!-- upload, not implemented yet -->
    <sl-tooltip content="Upload document">
      <sl-button name="download" size="small" disabled>
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
        <sl-button name="delete" size="small" slot="trigger" size="small" caret>
          <sl-icon name="trash3"></sl-icon>
        </sl-button>
        <sl-menu>
          <sl-menu-item name="delete-current">Delete current version</sl-menu-item>
          <sl-menu-item name="delete-all">Delete all versions</sl-menu-item>
        </sl-menu>
      </sl-dropdown>
    </sl-button-group>
  </sl-button-group>

  <!-- TEI -->
  <sl-button-group label="TEI" name="document-group">

    <!-- validate -->
    <sl-tooltip content="Validate the document">
      <sl-button name="validate" size="small" disabled>
        <sl-icon name="file-earmark-check"></sl-icon>
      </sl-button> 
    </sl-tooltip>

    <!-- enhance TEI -->
    <sl-tooltip content="Enhance TEI, i.e. add missing attributes">
      <sl-button name="tei-wizard" size="small">
        <sl-icon name="magic"></sl-icon>
      </sl-button>
    </sl-tooltip> 

  </sl-button-group>
</span>
`

/**
 * component API
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
  name,
  install,
  ui: {
    elements: {}
  }
}

export { plugin, api }
export default plugin

//
// Implementation
//


// API

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  app.registerComponent(name, api, name)

  // install controls on menubar
  const bar = app.commandbar
  const div = document.createElement("div")
  div.innerHTML = commandBarHtml.trim()
  const span = div.firstChild
  bar.add(span)
  Object.assign(plugin.ui.elements, getNameMap(span, ['sl-icon']))  

  // === Document button group ===

  // save current version
  bar.onClick('save-xml', onClickSaveButton);
  // enable save button on dirty editor
  app.xmleditor.addEventListener(
    XMLEditor.EVENT_XML_CHANGED,
    () => bar.getByName('save-xml').disabled = false
  );

  // delete
  const delBtn = app.getUiElementByName("services.delete")
  const delCurrBtn = app.getUiElementByName("services.delete-current")
  delCurrBtn.addEventListener("click", deleteCurrentVersion)
  const delAllBtn = app.getUiElementByName("services.delete-all")
  delAllBtn.addEventListener('click', deleteAllVersions)
  const xmlSelectbox = bar.getByName("xml")

  // disable when only gold is left
  app.on(app.fileselection.events.updated, () => {
    delBtn.disabled = delAllBtn.disabled = delCurrBtn.disabled = xmlSelectbox.childElementCount < 2
  })
  app.on("change:xmlPath", xmlPath => {
    // disable when the first entry (gold) is selected
    delBtn.disabled = delAllBtn.disabled = delCurrBtn.disabled = 
      xmlSelectbox.value === xmlSelectbox.firstChild?.value
  })

  // duplicate
  const duplicateBtn = bar.getByName("duplicate-xml")
  duplicateBtn.addEventListener("click", onClickDuplicateButton)
  app.on("change:xmlPath", xmlPath => {duplicateBtn.disabled = !xmlPath})


  // === TEI button group ===

  // validate xml button
  const validateBtn = bar.getByName('validate')
  validateBtn.addEventListener('click', onClickValidateButton);
  // disable during an ongoing validation
  validationEvents.addEventListener(validationEvents.EVENT.START, () => {
    validateBtn.disabled = true;
  })
  validationEvents.addEventListener(validationEvents.EVENT.END, () => {
    validateBtn.disabled = false;
  })

  // wizard
  const wizardBtn = bar.getByName('tei-wizard')
  wizardBtn.addEventListener("click", runTeiWizard)

  app.logger.info("Services plugin installed.")
}

/**
 * Loads the given XML and/or PDF file(s) into the editor and viewer 
 * @param {Object} param0 An Object with the following entries:
 * @param {string?} param0.pdf The path to the PDF file
 * @param {string?} param0.xml The path to the XML file
 * @param {string?} param0.diff The path to the diffed XML file, if one exists, this will not be loaded but is needed
 * 
 */
async function load({ xml, pdf, diff }) {

  const promises = []

  // PDF 
  if (pdf) {
    app.logger.info("Loading PDF", pdf)
    promises.push(app.pdfviewer.load(pdf))
  }

  // XML
  if (xml) {
    app.logger.info("Loading XML", xml)
    removeMergeView()
    promises.push(app.xmleditor.loadXml(xml))
  }

  // await promises in parallel
  await Promise.all(promises)

  if (pdf) {
    app.pdfPath = pdf
    // update selectboxes in the toolbar
    await app.fileselection.update()
  }
  if (xml) {
    app.xmlPath = xml
  }
}

/**
 * Validates the XML document by calling the validation service
 * @returns {Promise<void>}
 */
async function validateXml() {
  app.logger.info("Validating XML...")
  return await app.xmleditor.validateXml()
}

/**
 * Saves the current XML content to the server, optionally as a new version
 * @param {string} filePath The path to the XML file on the server
 * @param {Boolean?} saveAsNewVersion Optional flag to save the file content as a new version 
 * @returns {Promise<void>}
 */
async function saveXml(filePath, saveAsNewVersion=false) {
  app.logger.info(`Saving XML${saveAsNewVersion ? " as new version":""}...`);
  return await app.client.saveXml(app.xmleditor.getXML(), filePath, saveAsNewVersion)
}

/**
 * Creates a diff between the current and the given document and shows a merge view
 * @param {string} diff The path to the xml document with which to compare the current xml doc
 */
async function showMergeView(diff) {
  app.logger.info("Loading diff XML", diff)
  app.spinner.show('Computing file differences, please wait...')
  try {
    await app.xmleditor.showMergeView(diff)
  } finally {
    app.spinner.hide()
  }
  app.diffXmlPath = diff
}


/**
 * Removes all remaining diffs
 */
function removeMergeView() {
  app.xmleditor.hideMergeView()
  app.diffXmlPath = null
  UrlHash.remove("diff")
}

/**
 * Called when the "delete-all" button is executed
 */
async function deleteCurrentVersion(){
  const xmlSelectbox = app.getUiElementByName("fileselection.xml")
  const versionName = xmlSelectbox.selectedOptions[0].textContent
  const msg = `Are you sure you want to delete the current version "${versionName}"?`
  if (!confirm(msg)) return; // todo use dialog

  app.services.removeMergeView()
  
  // delete files 
  
  if (xmlSelectbox.value.startsWith("/data/tei")) {
    app.dialog.error("You cannot delete the gold version")
    return
  }
  const filePathsToDelete = [xmlSelectbox.value]
  if (filePathsToDelete.length > 0) {
    await app.client.deleteFiles(filePathsToDelete)
  }
  try {
    // update the file data
    await app.fileselection.reload()
    // load the gold version
    await load({ xml:xmlSelectbox.firstChild.value })
    notify(`Version "${versionName}" has been deleted.`)
  } catch (error) {
    console.error(error)
  }
}

/**
 * Called when the "delete-all" button is executed
 */
async function deleteAllVersions() {
  const msg = "Are you sure you want to clean up the extraction history? This will delete all versions of this document and leave only the current gold standard version."
  if (!confirm(msg)) return; // todo use dialog

  app.services.removeMergeView()
  
  // delete files 
  const xmlSelectbox = app.getUiElementByName("fileselection.xml")
  const xmlPaths = Array.from(xmlSelectbox.childNodes).map(option => option.value)
  const filePathsToDelete = xmlPaths.slice(1) // skip the first option, which is the gold standard version  
  if (filePathsToDelete.length > 0) {
    await app.client.deleteFiles(filePathsToDelete)
  }
  try {
    // update the file data
    await app.fileselection.reload()
    // load the gold version
    await load({ xml:xmlPaths[0] })
    notify("All version have been deleted")
  } catch (error) {
    console.error(error)
  }
}

/**
 * Saves the current file as a new version
 * @param {string} xmlPath The path to the xml file to be duplicated as a new version
 */
async function duplicateXml(xmlPath) {
  let {path} = await saveXml(xmlPath, true)
  app.fileselection.reload()
  app.xmlPath = path
}

/**
 * Given a Node in the XML, search and highlight its text content in the PDF Viewer
 * @param {Element} node 
 */
async function searchNodeContentsInPdf(node) {

  let searchTerms = getNodeText(node)
    // split all node text along whitespace and hypen/dash characters
    .reduce((acc, term) => acc.concat(term.split(/[\s\p{Pd}]/gu)), [])
    // Search terms must be more than three characters or consist of digits. This is to remove 
    // the most common "stop words" which would litter the search results with false positives.
    // This incorrectly removes hyphenated word parts but the alternative would be to  have to 
    // deal with language-specific stop words
    .filter(term => term.match(/\d+/) ? true : term.length > 3)

  // make the list of search terms unique
  searchTerms = Array.from(new Set(searchTerms))

  // add footnote
  if (node.hasAttribute("source")) {
    const source = node.getAttribute("source")
    // get footnote number 
    if (source.slice(0, 2) === "fn") {
      // remove the doi prefix
      searchTerms.unshift(source.slice(2) + " ")
    }
  }

  // start search
  await app.pdfviewer.search(searchTerms);
}


/**
 * Invokes all TEI enhancement plugin enpoints
 */
async function runTeiWizard() {
  const teiDoc = app.xmleditor.getXmlTree()
  if (!teiDoc) return
  const invocationResult = app.plugin.invoke(app.ext.tei.enhancement, teiDoc)
  // todo check if there are any changes
  const enhancedTeiDoc = (await Promise.all(invocationResult))[0]
  const xmlstring = (new XMLSerializer()).serializeToString(enhancedTeiDoc).replace(/ xmlns=".+?"/, '')
  app.xmleditor.showMergeView(xmlstring)
  app.floatingPanel.getByName("nav-diff")
    .querySelectorAll("button")
    .forEach(node => node.disabled = false)
}

// event listeners


/**
 * Called when the "Validate" button is executed
 */
async function onClickValidateButton() {
  app.commandbar.getByName('validate').disabled = true
  const diagnostics = await validateXml()
  notify(`The document contains ${diagnostics.length} validation error${diagnostics.length === 1 ? '' : 's'}.`)
}

/**
 * Called when the "Save" button is executed
 */
async function onClickSaveButton() {
  const xmlPath = app.commandbar.getByName('xml').value;
  await saveXml(xmlPath)
  app.commandbar.getByName('save-xml').disabled = true
  notify("Document was saved.")
}

/**
 * Called when the "Save" button is executed
 */
async function onClickDuplicateButton() {
  let xmlPath = app.commandbar.getByName('xml').value;
  await duplicateXml(xmlPath)
  app.commandbar.getByName('save-xml').disabled = true
  notify("Document was duplicated. You are now editing the copy.")
}

// helper methods

/**
 * Returns a list of non-empty text content from all text nodes contained in the given node
 * @returns {Array<string>}
 */
function getNodeText(node) {
  return getTextNodes(node).map(node => node.textContent.trim()).filter(Boolean)
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
/**
 * This component provides the core services that can be called programmatically or via user commands
 */

import SlButton from '@shoelace-style/shoelace/dist/components/button/button.js'
import SlIcon from '@shoelace-style/shoelace/dist/components/icon/icon.js'
import SlTooltip from '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js'

import { app, PdfTeiEditor } from '../app.js'
import { UrlHash } from '../modules/browser-utils.js'
import { validationEvents } from '../modules/lint.js' // Todo remove this dependency, use events instead
import { XMLEditor } from './xmleditor.js'
import { notify } from '../modules/sl-utils.js'

// name of the component
const name = "services"

const commandBarHtml = `
<sl-button-group label="Document" name="document-group">
  <sl-tooltip content="Validate the document">
    <sl-button name="validate" size="small" disabled>
      <sl-icon name="file-earmark-check"></sl-icon>
    </sl-button> 
  </sl-tooltip>
  <sl-tooltip content="Save document content to server">
    <sl-button name="save" size="small" disabled>
      <sl-icon name="save"></sl-icon>
    </sl-button>
  </sl-tooltip> 
  <sl-tooltip content="Upload document">
    <sl-button name="download" size="small" disabled>
      <sl-icon name="cloud-upload"></sl-icon>
    </sl-button>
  </sl-tooltip>    
  <sl-tooltip content="Download XML document">
    <sl-button name="download" size="small" disabled>
      <sl-icon name="cloud-download"></sl-icon>
    </sl-button>
  </sl-tooltip>   
  <sl-tooltip content="Delete all document versions except 'Gold'">
    <sl-button name="cleanup" size="small" disabled>
      <sl-icon name="trash3"></sl-icon>
    </sl-button>
  </sl-tooltip>
</sl-button>
`


/**
 * component API
 */
const servicesComponent = {
  load,
  validateXml,
  saveXml,
  showMergeView,
  removeMergeView
}


/**
 * component plugin
 */
const servicesPlugin = {
  name,
  install
}

export { servicesComponent, servicesPlugin }
export default servicesPlugin

//
// Implementation
//


// API

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  app.registerComponent(name, servicesComponent, name)

  // install controls on menubar
  const bar = app.commandbar
  const div = document.createElement("div")
  div.innerHTML = commandBarHtml.trim()
  div.childNodes.forEach(elem =>bar.add(elem))

  // setup event listeners

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

  // save current version
  bar.onClick('save', onClickSaveButton);

  // cleanup versions
  const cleanupBtn = bar.getByName("cleanup")
  cleanupBtn.addEventListener('click', onClickBtnCleanup)
  const xmlSelectBox = app.commandbar.getByName('xml')
  app.on(app.fileselection.events.updated, () => {
    cleanupBtn.disabled = xmlSelectBox.childElementCount < 2
  })

  // enable save button on dirty editor
  app.xmleditor.addEventListener(
    XMLEditor.EVENT_XML_CHANGED,
    () => bar.getByName('save').disabled = false
  );



  app.logger.info("Services component installed.")
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
 * Saves the current XML content to the server
 * @param {string} filePath The path to the XML file
 * @returns {Promise<void>}
 */
async function saveXml(filePath) {
  app.logger.info("Saving XML on server...");
  await app.client.saveXml(app.xmleditor.getXML(), filePath)
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
  app.commandbar.getByName('save').disabled = true
  notify("Document was saved.")
}

/**
 * Called when the "Cleanup" button is executed
 */
async function onClickBtnCleanup() {
  const msg = "Are you sure you want to clean up the extraction history? This will delete all versions of this document and leave only the current gold standard version."
  if (!confirm(msg)) return;

  app.services.removeMergeView()
  
  // delete files 
  const xmlPaths = Array.from(bar.getByName("xml").childNodes).map(option => option.value)
  const filePathsToDelete = xmlPaths.slice(1) // skip the first option, which is the gold standard version  
  if (filePathsToDelete.length > 0) {
    await app.client.deleteFiles(filePathsToDelete)
  }
  try {
    // update the file data
    await app.fileselection.reload()
    // load the gold version
    await load({ xml:xmlPaths[0] })
  } catch (error) {
    console.error(error)
  }
}
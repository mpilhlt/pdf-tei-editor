/**
 * This component provides the core services that can be called programmatically or via user commands
 */
import { app, PdfTeiEditor } from '../app.js'
import { UrlHash } from '../modules/browser-utils.js'
import { UrlHash } from '../modules/browser-utils.js'
import { validationEvents } from '../modules/lint.js' // Todo remove this dependency, use events instead

// name of the component
const name = "services"

const html = `
  <sl-button name="validate" disabled>Validate</sl-button>  
  <sl-button name="save" disabled>Save</sl-button> 
  <sl-button name="cleanup" disabled>Cleanup</sl-button>  
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

const bar = app.commandbar

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  app.registerComponent(name, servicesComponent, name)

  // install controls on menubar
  const div = document.createElement("div")
  div.innerHTML = html.trim()
  div.childNodes.foreEach(elem =>bar.add(elem))

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
  bar.clicked('save', onClickSaveButton);

  // cleanup versions
  const cleanupBtn = bar.getByName("cleanup")
  cleanupBtn.addEventListener('click', onClickBtnCleanup)
  app.on("fileselection:reloaded", () => {
    cleanupBtn.disabled = bar.getByName("xml").childElementCount < 2
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
    app.xmlPath = app.diffXmlPath = null
  }
  if (xml) {
    app.xmlPath = xml
    app.diffXmlPath = diff || null
  }
}

/**
 * Validates the XML document by calling the validation service
 * @returns {Promise<void>}
 */
async function validateXml() {
  app.logger.info("Validating XML...")
  await validateXml()
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
  app.diffXmlPath = app.xmlPath
  UrlHash.remove("diff")
}

// event listeners


/**
 * Called when the "Validate" button is executed
 */
async function onClickValidateButton() {
  bar.getByName('validate').disabled = true
  await validateXml()
}

/**
 * Called when the "Save" button is executed
 */
async function onClickSaveButton() {
  const xmlPath = bar.getByName('xml').value;
  await saveXml(xmlPath)
  bar.getByName('save').disabled = true
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
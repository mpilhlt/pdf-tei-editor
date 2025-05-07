/**
 * This implements the UI for the file selection
 */

import SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js'
import SlOption from '@shoelace-style/shoelace/dist/components/option/option.js'
import { app, PdfTeiEditor } from '../app.js'
import { selectByValue } from '../modules/browser-utils.js'

// name of the component
const componentId = "fileSelectionUi"

// HTML elements
const html = `
<sl-select name="pdf"></sl-select>
<span>Version:</span>
<sl-select name="xml"></sl-select>
<span>Diff:</span>
<sl-select name="diff"></sl-select>
`

/**
 * component API
 */
const cmp = {
  reload,
  update
}

/**
 * component plugin
 */
const plugin = {
  name: componentId,
  install
}

export { cmp as extractionUiComponent, plugin as extractionUiPlugin }
export default plugin

//
// Implementation
//

// UI elements
const cmd = app.commandbar;
const pdfSelectbox = cmd.getByName('pdf')
const xmlSelectbox = cmd.getByName('xml')
const diffSelectbox = cmd.getByName('diff')

// API

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function install(app) {
  app.registerComponent(componentId, cmp, "extraction")

  // install controls on menubar
  const div = document.createElement("div")
  div.innerHTML = html.trim()
  div.childNodes.foreEach(elem => app.commandbar.add(elem))

  // configure event handlers for these controls
  setupEventHandlers()

  // bind selectboxes to app state
  app.on("change:pdfPath", (value, old) => {
    if (!value) return
    cmd.selectByValue(pdfSelectbox, value)
    cmd.update()
  })
  app.on("change:xmlPath", (value, old) => {
    if (!value) return
    selectByValue(xmlSelectbox, value)
  })
  app.on("change:diffXmlPath", (value, old) => {
    if (!value) return
    selectByValue(diffSelectbox, value)
  })

  // enable save button on dirty editor
  app.xmleditor.addEventListener(
    XMLEditor.EVENT_XML_CHANGED,
    () => cmd.getByName('save').disabled = false
  );
  app.logger.info("Loading file metadata...")
  await cmd.reload()
  app.logger.info("Command bar component installed.")

  app.logger.info("Prompt editor component installed.")
}


/**
 * Reloads data and then updates based on the application state
 */
async function reload() {
  await reloadFileData();
  populateSelectboxes();
}

/**
 * Updates data such as select box options based on the application state
 */
async function update() {
  populateSelectboxes();
}

// 


/**
 * The data about the pdf and xml files on the server
 */
let fileData = null;

/**
 * Reloads the file data from the server
 */
async function reloadFileData() {
  const { files } = await app.client.getFileList();
  fileData = files
  if (!fileData || fileData.length === 0) {
    app.dialog.error("No files found")
  }
}

/**
 * Populates the selectboxes for file name and version
 */
function populateSelectboxes() {

  if (fileData === null) {
    throw new Error("You need to load the file data first")
  }

  // Clear existing options
  pdfSelectbox.innerHTML = xmlSelectbox.innerHTML = diffSelectbox.innerHTML = '';

  // get items to be selected from app state or use first element
  const pdfPath = app.pdfPath || fileData[0].pdf
  const xmlPath = app.xmlPath || fileData[0].xml
  const diffXmlPath = app.diffXmlPath || fileData[0].xml

  fileData.forEach(file => {

    // populate pdf select box 
    const option = document.createElement('option');
    option.value = file.pdf
    option.text = file.label

    if (file.pdf === pdfPath) {
      option.selected = true
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          const option = document.createElement('option');
          option.value = version.path;
          option.text = version.label;
          option.selected = (version.path === xmlPath)
          xmlSelectbox.appendChild(option);
          const diffOption = option.cloneNode(true)
          diffOption.selected = (version.path === diffXmlPath)
          diffSelectbox.appendChild(diffOption)
        })
      }
    }
    pdfSelectbox.appendChild(option);
  })
}

/**
 * Attaches the event handlers to the component subelements
 */
function setupEventHandlers() {

  // file selectboxes
  pdfSelectbox.addEventListener('change', onChangePdfSelectbox);
  xmlSelectbox.addEventListener('change', onChangeXmlSelectbox);
  diffSelectbox.addEventListener('change', onChangeDiffSelectbox);


}


/**
 * Called when the selection in the PDF selectbox changes
 */
async function onChangePdfSelectbox() {
  const selectedFile = fileData.find(file => file.pdf === pdfSelectbox.value);
  const pdf = selectedFile.pdf
  const xml = selectedFile.xml
  const filesToLoad = {}

  if (pdf && pdf !== app.pdfPath) {
    filesToLoad.pdf = pdf
  }
  if (xml && xml !== app.xmlPath) {
    filesToLoad.xml = xml
  }

  if (Object.keys(filesToLoad).length > 0) {
    try {
      await app.services.load(filesToLoad)
    }
    catch (error) {
      console.error(error)
    }
  }
}


/**
 * Called when the selection in the XML selectbox changes
 */
async function onChangeXmlSelectbox() {
  const xml = xmlSelectbox.value
  if (xml !== app.xmlPath) {
    try {
      await app.services.removeMergeView()
      await app.services.load({ xml })
    } catch (error) {
      console.error(error)
    }
  }
}

/**
 * Called when the selection in the diff version selectbox  changes
 */
async function onChangeDiffSelectbox() {
  const diff = diffSelectbox.value
  if (diff !== xmlSelectbox.value) {
    try {
      await app.services.showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    app.services.removeMergeView()
  }
}
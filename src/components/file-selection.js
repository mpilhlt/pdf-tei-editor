/**
 * This implements the UI for the file selection
 */

import SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js'
import SlOption from '@shoelace-style/shoelace/dist/components/option/option.js'
import { app, PdfTeiEditor } from '../app.js'
import { getNameMap } from '../modules/browser-utils.js'


// name of the component
const pluginId = "fileselection"

// HTML elements
const commandBarHtml = `
<span id="${pluginId}" class="hbox-with-gap">
  <sl-select name="pdf" size="small" label="PDF"></sl-select>
  <sl-select name="xml" size="small" label="XML file version"></sl-select>
  <sl-select name="diff" size="small" label="Compare with version"></sl-select>
<span>`

/**
 * Component events
 */
const events = {
  /** emitted when the file data is updated in the UI */
  updated: pluginId + ":updated",
  /** emitted when new data is loaded from the server */
  reloaded: pluginId + ":reloaded"
}

/**
 * component API
 */
const api = {
  reload,
  update,
  events
}

/**
 * component plugin
 */
const plugin = {
  name: pluginId,
  install,
  state: {
    pdfPath,
    xmlPath,
    diffXmlPath
  },
  ui: {
    elements: {}
  }
}

export { api, plugin }
export default plugin

//
// Implementation
//

// API

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function install(app) {
  app.registerComponent(pluginId, api, "fileselection")

  // install controls on menubar
  const div = document.createElement("div")
  div.innerHTML = commandBarHtml.trim()
  div.childNodes.forEach(elem => app.commandbar.add(elem))

  // define the UI elements of this plugin
  const elements = getNameMap(document.getElementById(pluginId), ['sl-icon'])
  plugin.ui.elements = elements

  // configure event handlers for these controls
  elements.pdf.addEventListener('sl-change', onChangePdfSelectbox);
  elements.xml.addEventListener('sl-change', onChangeXmlSelectbox);
  elements.diff.addEventListener('sl-change', onChangeDiffSelectbox);

  app.logger.info("Loading file metadata...")
  await reload()

  app.logger.info("Fileselection component installed.")
}



/**
 * Invoked when the application state "pdfPath" changes
 * @param {object} obj The object containing the parameters of the invocation
 * @param {any} obj.value The current value of the state
 * @param {any} obj.old The previous value of the state
 * @returns {void}
 */
function pdfPath({ value, old }) {
  if (!value) return
  plugin.ui.elements.pdf.value = value
  update()
}

/**
 * Invoked when the application state "xmlPath" changes
 * @param {object} obj The object containing the parameters of the invocation
 * @param {any} obj.value The current value of the state
 * @param {any} obj.old The previous value of the state
 * @returns {void}
 */
function xmlPath({ value, old }) {
  if (!value) return
  plugin.ui.elements.xml.value = value
}

/**
 * Invoked when the application state "diffXmlPath" changes
 * @param {object} obj The object containing the parameters of the invocation
 * @param {any} obj.value The current value of the state
 * @param {any} obj.old The previous value of the state
 * @returns {void}
 */
function diffXmlPath({ value, old }) {
  plugin.ui.elements.diff.value = value
}

/**
 * Reloads data and then updates based on the application state
 */
async function reload() {
  await reloadFileData();
  await populateSelectboxes();
  app.emit(events.reloaded)
}

/**
 * Updates data such as select box options based on the application state
 */
async function update() {
  await populateSelectboxes();
  app.emit(events.updated)
}

/**
 * The data about the pdf and xml files on the server
 */
let fileData = null;

/**
 * Reloads the file data from the server
 */
async function reloadFileData() {
  app.logger.debug("Reloading file data")
  const { files } = await app.client.getFileList();
  fileData = files
  if (!fileData || fileData.length === 0) {
    app.dialog.error("No files found")
  }
}

/**
 * Populates the selectboxes for file name and version
 */
async function populateSelectboxes() {
  app.logger.debug("Populating selectboxes")

  if (fileData === null) {
    await reloadFileData()
  }

  const elements = plugin.ui.elements

  // Clear existing options
  for (const name of ["pdf", "xml", "diff"]) {
    elements[name].innerHTML = ""
  }

  // get items to be selected from app state or use first element
  fileData.forEach(file => {

    // populate pdf select box 
    const option = Object.assign(new SlOption, {
      value: file.pdf,
      textContent: file.label,
      size: "small",
    })

    // save scalar file properties in option
    const data = Object.fromEntries(Object.entries(file).filter(([key, value]) => typeof value !== 'object'))
    Object.assign(option.dataset, data)

    elements.pdf.appendChild(option);

    if (file.pdf === app.pdfPath) {
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          // xml
          let option = new SlOption()
          option.size = "small"
          option.value = version.path;
          option.textContent = version.label;
          elements.xml.appendChild(option);
          // diff 
          option = new SlOption()
          option.size = "small"
          option.value = version.path;
          option.textContent = version.label;
          elements.diff.appendChild(option)
        })
      }
    }
  })

  // update selection
  elements.pdf.value = app.pdfPath
  elements.xml.value = app.xmlPath
  elements.diff.value = app.diffXmlPath

}

// Event handlers

/**
 * Called when the selection in the PDF selectbox changes
 */
async function onChangePdfSelectbox() {
  const selectedFile = fileData.find(file => file.pdf === plugin.ui.elements.pdf.value);
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
      app.services.removeMergeView()
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
  const xml = plugin.ui.elements.xml.value
  if (xml !== app.xmlPath) {
    try {
      app.services.removeMergeView()
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
  const diff = plugin.ui.elements.diff.value
  if (diff && diff !== plugin.ui.elements.xml.value) {
    try {
      await app.services.showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    app.services.removeMergeView()
  }
}
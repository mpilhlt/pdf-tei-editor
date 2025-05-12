/**
 * This implements the UI for the file selection
 */

/** @import {ApplicationState} from '../app.js' */
import ui from '../ui.js'
import { logger, client, services, dialog } from '../app.js'

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
 * plugin API
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
    update
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

  // install controls on menubar
  const div = document.createElement("div")
  div.innerHTML = commandBarHtml.trim()
  div.childNodes.forEach(elem => ui.toolbar.appendChild(elem))

  // configure event handlers for these controls
  ui.toolbar.pdf.addEventListener('sl-change', onChangePdfSelectbox);
  ui.toolbar.xml.addEventListener('sl-change', onChangeXmlSelectbox);
  ui.toolbar.diff.addEventListener('sl-change', onChangeDiffSelectbox);

  logger.info("Loading file metadata...")
  await reload()

  logger.info("Fileselection plugin installed.")
}

/**
 * 
 * @param {ApplicationState} state 
 */
async function update(state) {
  ui.toolbar.pdf.value = state.pdfPath
  ui.toolbar.xml.value = state.xnlPath
  ui.toolbar.diff.value = state.diffXmlPath
}


/**
 * Reloads data and then updates based on the application state
 */
async function reload(state) {
  await reloadFileData(state);
  await populateSelectboxes(state);
}

/**
 * Updates data such as select box options based on the application state
 */
async function update(state) {
  await populateSelectboxes(state);

}

/**
 * The data about the pdf and xml files on the server
 */
let fileData = null;

/**
 * Reloads the file data from the server
 * @type {ApplicationState} state
 */
async function reloadFileData(state) {
  logger.debug("Reloading file data")
  const { files } = await client.getFileList();
  fileData = files
  if (!fileData || fileData.length === 0) {
    dialog.error("No files found")
  }
}

/**
 * Populates the selectboxes for file name and version
 * @type {ApplicationState} state
 */
async function populateSelectboxes(state) {
  logger.debug("Populating selectboxes")

  if (fileData === null) {
    await reloadFileData()
  }

  // Clear existing options
  for (const name of ["pdf", "xml", "diff"]) {
    ui.toolbar[name].innerHTML = ""
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

    ui.toolbar.pdf.appendChild(option);

    if (file.pdf === app.pdfPath) {
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          // xml
          let option = new SlOption()
          option.size = "small"
          option.value = version.path;
          option.textContent = version.label;
          ui.toolbar.xml.appendChild(option);
          // diff 
          option = new SlOption()
          option.size = "small"
          option.value = version.path;
          option.textContent = version.label;
          ui.toolbar.diff.appendChild(option)
        })
      }
    }
  })

  // update selection
  ui.toolbar.pdf.value = state.pdfPath
  ui.toolbar.xml.value = state.xmlPath
  ui.toolbar.diff.value = state.diffXmlPath

}

// Event handlers

/**
 * Called when the selection in the PDF selectbox changes
 */
async function onChangePdfSelectbox() {
  const selectedFile = fileData.find(file => file.pdf === ui.toolbar.pdf.value);
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
      services.removeMergeView()
      await services.load(filesToLoad)
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
  const xml = ui.toolbar.xml.value
  if (xml !== app.xmlPath) {
    try {
      services.removeMergeView()
      await services.load({ xml })
    } catch (error) {
      console.error(error)
    }
  }
}

/**
 * Called when the selection in the diff version selectbox  changes
 */
async function onChangeDiffSelectbox() {
  const diff = ui.toolbar.diff.value
  if (diff && diff !== ui.toolbar.xml.value) {
    try {
      await services.showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    services.removeMergeView()
  }
}
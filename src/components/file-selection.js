/**
 * This implements the UI for the file selection
 */

import SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js'
import SlOption from '@shoelace-style/shoelace/dist/components/option/option.js'
import { app, PdfTeiEditor } from '../app.js'


// name of the component
const componentId = "fileselection"

// HTML elements
const commandBarHtml = `
<sl-select name="pdf" size="small" label="PDF"></sl-select>
<sl-select name="xml" size="small" label="XML file version"></sl-select>
<sl-select name="diff" size="small" label="Compare with version"></sl-select>
`

/**
 * Component events
 */
const events = {
  /** emitted when the file data is updated in the UI */
  updated: componentId + ":updated",
  /** emitted when new data is loaded from the server */
  reloaded: componentId + ":reloaded"
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
  name: componentId,
  install
}

export { api as fileselectionComponent, plugin as fileselectionPlugin }
export default plugin

//
// Implementation
//

// API

let controls;

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function install(app) {
  app.registerComponent(componentId, api, "fileselection")

  // install controls on menubar
  const div = document.createElement("div")
  div.innerHTML = commandBarHtml.trim()
  div.childNodes.forEach(elem => app.commandbar.add(elem))
  controls = app.commandbar.controls()
  
  // configure event handlers for these controls
  controls.pdf.addEventListener('sl-change', onChangePdfSelectbox);
  controls.xml.addEventListener('sl-change', onChangeXmlSelectbox);
  controls.diff.addEventListener('sl-change', onChangeDiffSelectbox);

  // bind selectboxes to app state
  app.on("change:pdfPath", (value, old) => {
    if (!value) return
    controls.pdf.value = value
    update()
  })
  app.on("change:xmlPath", (value, old) => {
    if (!value) return
    controls.xml.value = value
  })
  app.on("change:diffXmlPath", (value, old) => {
    controls.diff.value = value
  })

  app.logger.info("Loading file metadata...")
  await reload()

  app.logger.info("Fileselection component installed.")
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

  // Clear existing options
  for (const name of ["pdf", "xml", "diff"]) {
    controls[name].innerHTML = ""
  }

  // get items to be selected from app state or use first element
  fileData.forEach(file => {

    // populate pdf select box 
    const option = new SlOption()
    option.value = file.pdf
    option.textContent = file.label
    option.size = "small"
    controls.pdf.appendChild(option);

    if (file.pdf === app.pdfPath) {
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          // xml
          let option = new SlOption()
          option.size = "small"
          option.value = version.path;
          option.textContent = version.label;
          controls.xml.appendChild(option);
          // diff 
          option = new SlOption()
          option.size = "small"
          option.value = version.path;
          option.textContent = version.label;
          controls.diff.appendChild(option)
        })
      }
    }
    // Set selection
    controls.pdf.value = app.pdfPath || fileData[0].pdf
    controls.xml.value = app.xmlPath || fileData[0].xml
    if (app.diffXmlPath) {
      controls.diff.value = app.diffXmlPath
    }
  })
}

// Event handlers

/**
 * Called when the selection in the PDF selectbox changes
 */
async function onChangePdfSelectbox() {
  const selectedFile = fileData.find(file => file.pdf === app.commandbar.getByName("pdf").value);
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
  const xml = controls.xml.value
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
  console.warn("onChangeDiffSelectbox")
  const diff = controls.diff.value
  if (diff && diff !== controls.xml.value) {
    try {
      await app.services.showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    app.services.removeMergeView()
  }
}
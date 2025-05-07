/**
 * This implements the UI for the file selection
 */

import SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js'
import SlOption from '@shoelace-style/shoelace/dist/components/option/option.js'
import { app, PdfTeiEditor } from '../app.js'


// name of the component
const componentId = "fileselection"

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

export { cmp as fileselectionComponent, plugin as fileselectionPlugin }
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
  app.registerComponent(componentId, cmp, "fileselection")

  // install controls on menubar
  const div = document.createElement("div")
  div.innerHTML = html.trim()
  div.childNodes.foreEach(elem => app.commandbar.add(elem))

  // configure event handlers for these controls
  pdfSelectbox.addEventListener('sl-change', onChangePdfSelectbox);
  xmlSelectbox.addEventListener('sl-change', onChangeXmlSelectbox);
  diffSelectbox.addEventListener('sl-change', onChangeDiffSelectbox);

  // bind selectboxes to app state
  app.on("change:pdfPath", (value, old) => {
    if (!value) return
    cmd.selectOptionByValue("pdf", value)
    cmd.update()
  })
  app.on("change:xmlPath", (value, old) => {
    if (!value) return
    cmd.selectOptionByValue("xml", value)
  })
  app.on("change:diffXmlPath", (value, old) => {
    if (!value) return
    cmd.selectOptionByValue("diff", value)
  })

  app.logger.info("Loading file metadata...")
  await cmd.reload()

  app.logger.info("Fileselection component installed.")
}


/**
 * Reloads data and then updates based on the application state
 */
async function reload() {
  await reloadFileData();
  populateSelectboxes();
  app.emit(componentId + ":reloaded")
}

/**
 * Updates data such as select box options based on the application state
 */
async function update() {
  populateSelectboxes();
}

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
  for (const name of ["pdf", "xml", "diff"]) {
    const elem = cmd.getByName(name)
    elem.childNodes.forEach(node => node.remove())
  }

  // get items to be selected from app state or use first element
  const pdfPath = app.pdfPath || fileData[0].pdf
  const xmlPath = app.xmlPath || fileData[0].xml
  const diffXmlPath = app.diffXmlPath || fileData[0].xml // || null?

  fileData.forEach(file => {

    // populate pdf select box 
    const option = new SlOption()
    option.value = file.pdf
    option.textContent = file.label
    cmd.getByName("pdf").appendChild(option);
    if (file.pdf === pdfPath) {
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          const option = new SlOption()
          option.value = version.path;
          option.textContent = version.label;
          cmd.getByName("xml").appendChild(option);
          const diffOption = option.cloneNode(true)
          cmd.getByName("diff").appendChild(diffOption)
        })
      }
    }
    // Set selection
    cmd.getByName("pdf").value = app.pdfPath
    cmd.getByName("xml").value = app.xmlPath
    if (app.xmlPath) {
      cmd.getByName("diff").value = app.pdfPath
    }
  })
}

// Event handlers

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
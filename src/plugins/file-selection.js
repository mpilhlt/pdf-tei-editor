/**
 * This implements the UI for the file selection
 */


/** 
 * @import { ApplicationState } from '../app.js' 
 */
import ui from '../ui.js'
import { SlOption, appendHtml } from '../ui.js'
import { logger, client, services, dialog } from '../app.js'

/**
 * plugin API
 */
const api = {
  reload,
  update
}

/**
 * component plugin
 */
const plugin = {
  name: "file-selection",
  install,
  state: {
    update
  }
}

export { api, plugin }
export default plugin

//
// UI
//

// HTML elements
const fileSelectionHtml = `
<span class="hbox-with-gap">
  <sl-select name="pdf" size="small" label="PDF"></sl-select>
  <sl-select name="xml" size="small" label="XML file version"></sl-select>
  <sl-select name="diff" size="small" label="Compare with version"></sl-select>
<span>`

//
// Implementation
//

// API

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {

  // install controls on menubar
  appendHtml(fileSelectionHtml, ui.toolbar.self)

  // configure event handlers for these controls
  ui.toolbar.pdf.addEventListener('sl-change', () => onChangePdfSelectbox(state));
  ui.toolbar.xml.addEventListener('sl-change', () => onChangeXmlSelectbox(state));
  ui.toolbar.diff.addEventListener('sl-change', () => onChangeDiffSelectbox(state));

  logger.info("Loading file metadata...")
  await reload(state)

  logger.info("Fileselection plugin installed.")
}

/**
 * 
 * @param {ApplicationState} state 
 */
async function update(state) {
  await populateSelectboxes(state);
  ui.toolbar.pdf.value = state.pdfPath || ""
  ui.toolbar.xml.value = state.xmlPath || ""
  ui.toolbar.diff.value = state.diffXmlPath || ""
}


/**
 * Reloads data and then updates based on the application state
 * @param {ApplicationState} state
 */
async function reload(state) {
  await reloadFileData();
  await populateSelectboxes(state);
}

/**
 * The data about the pdf and xml files on the server
 * @type {Array<object>}
 */
let fileData;

/**
 * Reloads the file data from the server
 */
async function reloadFileData() {
  logger.debug("Reloading file data")
  fileData = await client.getFileList();
  if (!fileData || fileData.length === 0) {
    dialog.error("No files found")
  }
}

/**
 * Populates the selectboxes for file name and version
 * @param {ApplicationState} state
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

    if (file.pdf === state.pdfPath) {
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          // xml
          let option = new SlOption()
          // @ts-ignore
          option.size = "small"
          option.value = version.path;
          option.textContent = version.label;
          ui.toolbar.xml.appendChild(option);
          // diff 
          option = new SlOption()
          // @ts-ignore
          option.size = "small"
          option.value = version.path;
          option.textContent = version.label;
          ui.toolbar.diff.appendChild(option)
        })
      }
    }
  })

  // update selection
  ui.toolbar.pdf.value = state.pdfPath || ''
  ui.toolbar.xml.value = state.xmlPath || ''
  ui.toolbar.diff.value = state.diffXmlPath || ''

}

// Event handlers

/**
 * Called when the selection in the PDF selectbox changes
 * @param {ApplicationState} state
 */
async function onChangePdfSelectbox(state) {
  const selectedFile = fileData.find(file => file.pdf === ui.toolbar.pdf.value);
  const pdf = selectedFile.pdf
  const xml = selectedFile.xml
  const filesToLoad = {}

  if (pdf && pdf !== state.pdfPath) {
    filesToLoad.pdf = pdf
  }
  if (xml && xml !== state.xmlPath) {
    filesToLoad.xml = xml
  }

  if (Object.keys(filesToLoad).length > 0) {
    try {
      services.removeMergeView()
      // @ts-ignore
      await services.load(state, filesToLoad)
    }
    catch (error) {
      console.error(error)
    }
  }
}


/**
 * Called when the selection in the XML selectbox changes
 * @param {ApplicationState} state
 */
async function onChangeXmlSelectbox(state) {
  const xml = ui.toolbar.xml.value
  if (xml && typeof xml == "string" && xml !== state.xmlPath) {
    try {
      services.removeMergeView()
      await services.load(state, { xml })
    } catch (error) {
      console.error(error)
    }
  }
}

/**
 * Called when the selection in the diff version selectbox  changes
 * @param {ApplicationState} state
 */
async function onChangeDiffSelectbox(state) {
  const diff = ui.toolbar.diff.value
  if (diff && typeof diff == "string" && diff !== ui.toolbar.xml.value) {
    try {
      await services.showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    services.removeMergeView()
  }
}
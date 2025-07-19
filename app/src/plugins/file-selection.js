/**
 * This implements the UI for the file selection
 */


/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlSelect } from '../ui.js'
 */
import ui from '../ui.js'
import { SlOption, SlDivider, createHtmlElements, updateUi } from '../ui.js'
import { logger, client, services, dialog, updateState } from '../app.js'

/**
 * The data about the pdf and xml files on the server
 * @type {Array<object>}
 */
const fileData = [];

/**
 * plugin API
 */
const api = {
  reload,
  update,
  fileData
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

// see ui.js for @typedef 
const fileSelectionControls = await createHtmlElements('file-selection.html')

//
// Implementation
//

// API

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {

  logger.debug(`Installing plugin "${plugin.name}"`);
  
  // install controls on menubar
  ui.toolbar.self.append(...fileSelectionControls)
  updateUi()
  
  /**  @type {[SlSelect,function][]} */
  const handlers = [
    [ui.toolbar.pdf, onChangePdfSelection],
    [ui.toolbar.xml, onChangeXmlSelection],
    [ui.toolbar.diff, onChangeDiffSelection]
  ]

  for (const [select, handler] of handlers) {
    // add event handler for the selectbox
    select.addEventListener('sl-change', () => handler(state));

    // this works around a problem with the z-index of the select dropdown being bound 
    // to the z-index of the parent toolbar (and therefore being hidden by the editors)
    select.addEventListener('sl-show', () => {
      select.closest('#toolbar')?.classList.add('dropdown-open');
    });

    select.addEventListener('sl-hide', () => {
      select.closest('#toolbar')?.classList.remove('dropdown-open');
    });
  }
}

/**
 * 
 * @param {ApplicationState} state 
 */
async function update(state) {
//console.warn("update", plugin.name, state)
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
  await reloadFileData(state);
  await populateSelectboxes(state);
}

/**
 * Reloads the file data from the server
 * @param {ApplicationState} state
 */
async function reloadFileData(state) {
  logger.debug("Reloading file data")
  let data = await client.getFileList();
  if (!data || data.length === 0) {
    dialog.error("No files found")
  }
  // update the fileData variable
  fileData.length = 0; // clear the array
  fileData.push(...data);
  return fileData;
}

let stateCache

/**
 * Populates the selectboxes for file name and version
 * @param {ApplicationState} state
 */
async function populateSelectboxes(state) {

  // check if state has changed
  const { xmlPath, pdfPath, diffXmlPath } = state
  const jsonState = JSON.stringify({ xmlPath, pdfPath, diffXmlPath })
  if (jsonState === stateCache) {
    //logger.debug("Not repopulating selectboxes as state hasn't changed")
    return
  }
  stateCache = jsonState

  logger.debug("Populating selectboxes")

  if (fileData === null) {
    await reloadFileData(state)
  }

  // Clear existing options
  for (const name of ["pdf", "xml", "diff"]) {
    ui.toolbar[name].innerHTML = ""
  }

  // sort into groups by directory
  const dirname = (path) => path.split('/').slice(0, -1).join('/')
  const basename = (path) => path.split('/').pop()
  const grouped_files = fileData.reduce((groups, file) => {
    const collection_name = basename(dirname(file.pdf));
    (groups[collection_name] = groups[collection_name] || []).push(file)
    return groups
  }, {})

  // save the collections, this tight coupling is not ideal
  const collections = Object.keys(grouped_files).sort()
  ui.toolbar.pdf.dataset.collections = JSON.stringify(collections)

  // get items to be selected from app state or use first element
  for (const collection_name of collections) {
    
    await createHtmlElements(`<small>${collection_name}</small>`, ui.toolbar.pdf)
    
    // get a list of file data sorted by label
    const files = grouped_files[collection_name]
      .sort((a, b) => (a.label < b.label) ? -1 : (a.label > b.label) ? 1 : 0 )

    for (const file of files) {
      // populate pdf select box 
      const option = Object.assign(new SlOption, {
        value: file.pdf,
        textContent: file.label,
        size: "small",
      })

      // save scalar file properties in option
      const data = Object.fromEntries(Object.entries(file).filter(([key, value]) => typeof value !== 'object'))
      Object.assign(option.dataset, data)

      ui.toolbar.pdf.hoist = true
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
    }
    ui.toolbar.pdf.appendChild(new SlDivider);
  }


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
async function onChangePdfSelection(state) {
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
      services.removeMergeView(state)
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
async function onChangeXmlSelection(state) {
  const xml = ui.toolbar.xml.value
  if (xml && typeof xml == "string" && xml !== state.xmlPath) {
    try {
      services.removeMergeView(state)
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
async function onChangeDiffSelection(state) {
  const diff = ui.toolbar.diff.value
  if (diff && typeof diff == "string" && diff !== ui.toolbar.xml.value) {
    try {
      await services.showMergeView(state, diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    services.removeMergeView(state)
  }
  updateState(state, { diffXmlPath: diff })
}
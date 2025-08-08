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
    [ui.toolbar.variant, onChangeVariantSelection],
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
  //console.warn(plugin.name,"done")
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
  // Always get all files, don't filter on server side
  let data = await client.getFileList();
  if (!data || data.length === 0) {
    dialog.error("No files found")
  }
  // update the fileData variable
  fileData.length = 0; // clear the array
  fileData.push(...data);
  stateCache = null;
  return fileData;
}

let stateCache

/**
 * Populates the variant selectbox with unique variants from fileData
 * @param {ApplicationState} state
 */
async function populateVariantSelectbox(state) {
  // Clear existing options
  ui.toolbar.variant.innerHTML = "";

  // Get unique variants from fileData
  const variants = new Set();
  fileData.forEach(file => {
    // Add variant_id from versions
    if (file.versions) {
      file.versions.forEach(version => {
        if (version.variant_id) {
          variants.add(version.variant_id);
        }
      });
    }
  });

  // Add "All" option
  const allOption = new SlOption();
  allOption.value = "";
  allOption.textContent = "All";
  // @ts-ignore
  allOption.size = "small";
  ui.toolbar.variant.appendChild(allOption);

  // Add "None" option for files without variants
  const noneOption = new SlOption();
  noneOption.value = "none";
  noneOption.textContent = "None";
  // @ts-ignore
  noneOption.size = "small";
  ui.toolbar.variant.appendChild(noneOption);

  // Add variant options
  [...variants].sort().forEach(variant => {
    const option = new SlOption();
    option.value = variant;
    option.textContent = variant;
    // @ts-ignore
    option.size = "small";
    ui.toolbar.variant.appendChild(option);
  });

  // Set current selection
  ui.toolbar.variant.value = state.variant || "";
}

/**
 * Populates the selectboxes for file name and version
 * @param {ApplicationState} state
 */
async function populateSelectboxes(state) {

  // check if state has changed
  const { xmlPath, pdfPath, diffXmlPath, variant } = state
  const jsonState = JSON.stringify({ xmlPath, pdfPath, diffXmlPath, variant })
  if (jsonState === stateCache) {
    //logger.debug("Not repopulating selectboxes as state hasn't changed")
    return
  }
  stateCache = jsonState

  logger.debug("Populating selectboxes")

  // Only reload if fileData is completely empty (initial load)
  if (fileData.length === 0) {
    await reloadFileData(state)
  }

  // Populate variant selectbox first
  await populateVariantSelectbox(state);

  // Clear existing options
  for (const name of ["pdf", "xml", "diff"]) {
    ui.toolbar[name].innerHTML = ""
  }

  // Filter files by variant selection
  let filteredFileData = fileData;
  
  if (variant === "none") {
    // Show only files without variant_id at top level and no versions with variant_id
    filteredFileData = fileData.filter(file => {
      const hasTopLevelVariant = !!file.variant_id;
      const hasVersionVariant = file.versions && file.versions.some(v => !!v.variant_id);
      return !hasTopLevelVariant && !hasVersionVariant;
    });
  } else if (variant && variant !== "") {
    // Show only files with the selected variant_id (either at top level or in versions)
    filteredFileData = fileData.filter(file => {
      const matchesTopLevel = file.variant_id === variant;
      const matchesVersion = file.versions && file.versions.some(v => v.variant_id === variant);
      return matchesTopLevel || matchesVersion;
    });
  }
  // If variant is "" (All), show all files

  // sort into groups by directory
  const dirname = (path) => path.split('/').slice(0, -1).join('/')
  const basename = (path) => path.split('/').pop()
  const grouped_files = filteredFileData.reduce((groups, file) => {
    const collection_name = basename(dirname(file.pdf));
    (groups[collection_name] = groups[collection_name] || []).push(file)
    return groups
  }, {})

  // save the collections, this tight coupling is not ideal
  const collections = Object.keys(grouped_files).sort()
  ui.toolbar.pdf.dataset.collections = JSON.stringify(collections)

  // get items to be selected from app state or use first element
  for (const collection_name of collections) {
    
    await createHtmlElements(`<small>${collection_name.replaceAll("_"," ").trim()}</small>`, ui.toolbar.pdf)
    
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
          // Filter versions based on variant selection
          let versionsToShow = file.versions;
          if (variant === "none") {
            // Show only versions without variant_id
            versionsToShow = file.versions.filter(version => !version.variant_id);
          } else if (variant && variant !== "") {
            // Show only versions with the selected variant_id
            versionsToShow = file.versions.filter(version => version.variant_id === variant);
          }
          // If variant is "" (All), show all versions

          versionsToShow.forEach((version) => {
            // xml
            let option = new SlOption()
            // @ts-ignore
            option.size = "small"
            option.value = version.path;
            option.textContent = version.is_locked ? `🔒 ${version.label}` : version.label;
            //option.disabled = version.is_locked;
            ui.toolbar.xml.appendChild(option);
            // diff 
            option = new SlOption()
            // @ts-ignore
            option.size = "small"
            option.value = version.path;
            option.textContent = version.is_locked ? `🔒 ${version.label}` : version.label;
            option.disabled = version.is_locked;
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

/**
 * Called when the selection in the variant selectbox changes
 * @param {ApplicationState} state
 */
async function onChangeVariantSelection(state) {
  const variant = ui.toolbar.variant.value
  updateState(state, { variant })
}
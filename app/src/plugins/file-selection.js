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
  
  // Add file selection controls to toolbar with specified priorities
  const controlPriorities = {
    'pdf': 10,    // High priority - essential
    'xml': 10,    // High priority - essential  
    'variant': 5, // Medium priority
    'diff': 3     // Lower priority
  };
  
  fileSelectionControls.forEach(control => {
    // Ensure we're working with HTMLElement
    if (control instanceof HTMLElement) {
      const name = control.getAttribute('name');
      const priority = controlPriorities[name] || 1;
      ui.toolbar.add(control, priority);
    }
  });
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
    select.addEventListener('sl-change', async () => await handler(state));

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
  ui.toolbar.pdf.value = state.pdf || ""
  ui.toolbar.xml.value = state.xml || ""
  ui.toolbar.diff.value = state.diff || ""
  //console.warn(plugin.name,"done")
}


/**
 * Reloads data and then updates based on the application state
 * @param {ApplicationState} state
 * @param {Object} options - Options for reloading
 * @param {boolean} [options.refresh] - Whether to force refresh of server cache
 */
async function reload(state, options = {}) {
  await reloadFileData(state, options);
  await populateSelectboxes(state);
}

/**
 * Reloads the file data from the server
 * @param {ApplicationState} state
 * @param {Object} options - Options for reloading
 * @param {boolean} [options.refresh] - Whether to force refresh of server cache
 */
async function reloadFileData(state, options = {}) {
  logger.debug("Reloading file data" + (options.refresh ? " with cache refresh" : ""))
  // Always get all files, don't filter on server side
  let data = await client.getFileList(null, options.refresh);
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
let variants
let collections

/**
 * Populates the variant selectbox with unique variants from fileData
 * @param {ApplicationState} state
 */
async function populateVariantSelectbox(state) {
  // Clear existing options
  ui.toolbar.variant.innerHTML = "";

  // Get unique variants from fileData and store in closure variable
  variants = new Set();
  fileData.forEach(file => {
    // Add variant_id from gold entries
    if (file.gold) {
      file.gold.forEach(gold => {
        if (gold.variant_id) {
          variants.add(gold.variant_id);
        }
      });
    }
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
  // @ts-ignore - size property not in SlOption type definition
  allOption.size = "small";
  ui.toolbar.variant.appendChild(allOption);

  // Add "None" option for files without variants
  const noneOption = new SlOption();
  noneOption.value = "none";
  noneOption.textContent = "None";
  // @ts-ignore - size property not in SlOption type definition
  noneOption.size = "small";
  ui.toolbar.variant.appendChild(noneOption);

  // Add variant options
  [...variants].sort().forEach(variant => {
    const option = new SlOption();
    option.value = variant;
    option.textContent = variant;
    // @ts-ignore - size property not in SlOption type definition
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
  const { xml, pdf, diff, variant } = state
  const jsonState = JSON.stringify({ xml, pdf, diff, variant })
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
    // Show only files without variant_id in gold or versions
    filteredFileData = fileData.filter(file => {
      const hasGoldVariant = file.gold && file.gold.some(g => !!g.variant_id);
      const hasVersionVariant = file.versions && file.versions.some(v => !!v.variant_id);
      return !hasGoldVariant && !hasVersionVariant;
    });
  } else if (variant && variant !== "") {
    // Show only files with the selected variant_id (in gold or versions)
    filteredFileData = fileData.filter(file => {
      const matchesGold = file.gold && file.gold.some(g => g.variant_id === variant);
      const matchesVersion = file.versions && file.versions.some(v => v.variant_id === variant);
      return matchesGold || matchesVersion;
    });
  }
  // If variant is "" (All), show all files

  // sort into groups by collection (now directly from server data)
  const grouped_files = filteredFileData.reduce((groups, file) => {
    const collection_name = file.collection;
    (groups[collection_name] = groups[collection_name] || []).push(file)
    return groups
  }, {})

  // save the collections in closure variable
  collections = Object.keys(grouped_files).sort()
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
        value: file.pdf.hash,  // Use document identifier
        textContent: file.label,
        size: "small",
      })

      // save scalar file properties in option
      const data = Object.fromEntries(Object.entries(file).filter(([key, value]) => typeof value !== 'object'))
      Object.assign(option.dataset, data)

      ui.toolbar.pdf.hoist = true
      ui.toolbar.pdf.appendChild(option);

      if (file.pdf.hash === state.pdf) {
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
          
          // Also add gold entries if they match the variant filter
          let goldToShow = [];
          if (file.gold) {
            if (variant === "none") {
              goldToShow = file.gold.filter(gold => !gold.variant_id);
            } else if (variant && variant !== "") {
              goldToShow = file.gold.filter(gold => gold.variant_id === variant);
            } else {
              goldToShow = file.gold;
            }
          }

          // Add gold entries with visual grouping
          if (goldToShow.length > 0) {
            // Add "Gold" group headers for both selectboxes
            await createHtmlElements(`<small>Gold</small>`, ui.toolbar.xml);
            await createHtmlElements(`<small>Gold</small>`, ui.toolbar.diff);
            
            goldToShow.forEach((gold) => {
              // xml
              let option = new SlOption()
              // @ts-ignore
              option.size = "small"
              option.value = gold.hash;  // Use document identifier
              option.textContent = gold.label;
              ui.toolbar.xml.appendChild(option);
              // diff 
              option = new SlOption()
              // @ts-ignore
              option.size = "small"
              option.value = gold.hash;  // Use document identifier
              option.textContent = gold.label;
              ui.toolbar.diff.appendChild(option)
            });
            
            // Add dividers after gold entries if there are versions to show
            if (versionsToShow.length > 0) {
              ui.toolbar.xml.appendChild(new SlDivider());
              ui.toolbar.diff.appendChild(new SlDivider());
            }
          }

          // Add versions with visual grouping
          if (versionsToShow.length > 0) {
            // Add "Versions" group headers for both selectboxes
            await createHtmlElements(`<small>Versions</small>`, ui.toolbar.xml);
            await createHtmlElements(`<small>Versions</small>`, ui.toolbar.diff);
            
            versionsToShow.forEach((version) => {
              // xml
              let option = new SlOption()
              // @ts-ignore
              option.size = "small"
              option.value = version.hash;  // Use document identifier
              option.textContent = version.is_locked ? `🔒 ${version.label}` : version.label;
              //option.disabled = version.is_locked;
              ui.toolbar.xml.appendChild(option);
              // diff 
              option = new SlOption()
              // @ts-ignore
              option.size = "small"
              option.value = version.hash;  // Use document identifier
              option.textContent = version.is_locked ? `🔒 ${version.label}` : version.label;
              option.disabled = version.is_locked;
              ui.toolbar.diff.appendChild(option)
            });
          }
        }
      }
    }
    ui.toolbar.pdf.appendChild(new SlDivider);
  }


  // update selection
  ui.toolbar.pdf.value = state.pdf || ''
  ui.toolbar.xml.value = state.xml || ''
  ui.toolbar.diff.value = state.diff || ''

}

// Event handlers

/**
 * Called when the selection in the PDF selectbox changes
 * @param {ApplicationState} state
 */
async function onChangePdfSelection(state) {
  const selectedFile = fileData.find(file => file.pdf.hash === ui.toolbar.pdf.value);
  const pdf = selectedFile.pdf.hash  // Use document identifier
  const xml = selectedFile.gold?.[0]?.hash  // Use first gold entry identifier
  const filesToLoad = {}

  if (pdf && pdf !== state.pdf) {
    filesToLoad.pdf = pdf
  }
  if (xml && xml !== state.xml) {
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
  if (xml && typeof xml == "string" && xml !== state.xml) {
    try {
      await services.removeMergeView(state)
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
    await services.removeMergeView(state)
  }
  await updateState(state, { diff: diff })
}

/**
 * Called when the selection in the variant selectbox changes
 * @param {ApplicationState} state
 */
async function onChangeVariantSelection(state) {
  const variant = ui.toolbar.variant.value
  await updateState(state, { variant, xml:null })
}
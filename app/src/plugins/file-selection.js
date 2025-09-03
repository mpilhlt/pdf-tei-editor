/**
 * This implements the UI for the file selection
 */


/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlSelect } from '../ui.js'
 */
import ui from '../ui.js'
import { SlOption, SlDivider, updateUi } from '../ui.js'
import { registerTemplate, createFromTemplate, createHtmlElements } from '../modules/ui-system.js'
import { logger, services, dialog, updateState, reloadFileData, hasStateChanged } from '../app.js'

/**
 * The data about the pdf and xml files on the server
 * @type {Array<object>}
 */
let fileData = [];

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
    update,
    changeFileData: data => {
      fileData = data;
    }
  }
}

export { api, plugin }
export default plugin

//
// UI
//

// Register templates
await registerTemplate('file-selection', 'file-selection.html');

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
  
  // Create file selection controls
  const fileSelectionControls = createFromTemplate('file-selection');
  
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
    select.addEventListener('sl-change', async () => {
      
      
      // Ignore programmatic changes to prevent double-loading
      if (isUpdatingProgrammatically) {
        
        return;
      }
      
      
      if (currentState) {
        await handler(currentState);
      } else {
        console.warn(`${select.name} selection ignored: no current state available`);
      }
    });

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
  // Store current state for use in event handlers
  currentState = state;
  
  // Note: Don't mutate state directly in update() - that would cause infinite loops
  // The state.collection should be managed by other functions that call updateState()
  
  // Check if relevant state properties have changed
  if (hasStateChanged(state, 'xml', 'pdf', 'diff', 'variant', 'fileData') && state.fileData) {
    await populateSelectboxes(state);
  }
  
  // Always update selected values (with guard to prevent triggering events)
  
  isUpdatingProgrammatically = true;
  try {
    ui.toolbar.pdf.value = state.pdf || ""
    ui.toolbar.xml.value = state.xml || ""
    ui.toolbar.diff.value = state.diff || ""
  } finally {
    isUpdatingProgrammatically = false;
  }
}


/**
 * Reloads data and then updates based on the application state
 * @param {ApplicationState} state
 * @param {Object} options - Options for reloading
 * @param {boolean} [options.refresh] - Whether to force refresh of server cache
 */
async function reload(state, options = {}) {
  await reloadFileData(state, options);
  // Note: populateSelectboxes() will be called automatically via the update() method 
  // when reloadFileData() triggers a state update with new fileData
}


let variants
let collections
let currentState = null
let isUpdatingProgrammatically = false

/**
 * Populates the variant selectbox with unique variants from fileData
 * @param {ApplicationState} state
 */
async function populateVariantSelectbox(state) {
  if (!state.fileData) {
    throw new Error("fileData hasn't been loaded yet")
  }

  // Clear existing options
  ui.toolbar.variant.innerHTML = "";

  // Get unique variants from fileData and store in closure variable
  variants = new Set();
  state.fileData.forEach(file => {
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

  // Set current selection (with guard to prevent triggering events)
  isUpdatingProgrammatically = true;
  try {
    ui.toolbar.variant.value = state.variant || "";
  } finally {
    isUpdatingProgrammatically = false;
  }
}

/**
 * Populates the selectboxes for file name and version
 * @param {ApplicationState} state
 */
async function populateSelectboxes(state) {
  if (!state.fileData) {
    throw new Error("fileData hasn't been loaded yet")
  }
  logger.debug("Populating selectboxes")

  // Note: This function should only be called when fileData exists
  // If fileData is missing, it should be loaded via reloadFileData() which will trigger
  // this function again via the update() method
  if (!state.fileData || state.fileData.length === 0) {
    throw new Error("populateSelectboxes called but fileData is not available")
  }
  
  const fileData = state.fileData;

  // Populate variant selectbox first
  await populateVariantSelectbox(state);

  // Clear existing options
  for (const name of ["pdf", "xml", "diff"]) {
    ui.toolbar[name].innerHTML = ""
  }

  // Filter files by variant selection
  let filteredFileData = fileData;
  const variant = state.variant;
  
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



}

// Event handlers

/**
 * Called when the selection in the PDF selectbox changes
 * @param {ApplicationState} state
 */
async function onChangePdfSelection(state) {
  if (!state.fileData) {
    throw new Error("fileData hasn't been loaded yet")
  }
  const selectedFile = state.fileData.find(file => file.pdf.hash === ui.toolbar.pdf.value);
  const pdf = selectedFile.pdf.hash  // Use document identifier
  const collection = selectedFile.collection
  
  // Find gold file matching current variant selection
  let xml = null;
  if (selectedFile.gold) {
    const { variant } = state;
    let matchingGold;
    
    if (variant === "none") {
      // Find gold without variant_id
      matchingGold = selectedFile.gold.find(gold => !gold.variant_id);
    } else if (variant && variant !== "") {
      // Find gold with matching variant_id
      matchingGold = selectedFile.gold.find(gold => gold.variant_id === variant);
    } else {
      // No variant filter - use first gold file
      matchingGold = selectedFile.gold[0];
    }
    
    xml = matchingGold?.hash;
  }
  
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
      await updateState(state, { collection })
      await services.load(state, filesToLoad)
    }
    catch (error) {
      await updateState(state, { collection: null, pdf: null, xml: null })
      await reload(state, {refresh:true})
      logger.warn(error.message)
    }
  }
}


/**
 * Called when the selection in the XML selectbox changes
 * @param {ApplicationState} state
 */
async function onChangeXmlSelection(state) {
  if (!state.fileData) {
    throw new Error("fileData hasn't been loaded yet")
  }
  const xml = ui.toolbar.xml.value
  if (xml && typeof xml == "string" && xml !== state.xml) {
    try {
      // Find the collection for this XML file by searching fileData
      for (const file of state.fileData) {
        const hasGoldMatch = file.gold && file.gold.some(gold => gold.hash === xml);
        const hasVersionMatch = file.versions && file.versions.some(version => version.hash === xml);
        
        if (hasGoldMatch || hasVersionMatch) {
          await updateState(state, { collection: file.collection });
          break;
        }
      }
      
      
      await services.removeMergeView(state)
      await services.load(state, { xml })
    } catch (error) {
      console.error(error.message)
      await reload(state, {refresh:true})
      await updateState(state, {xml:null})
      dialog.error(error.message)
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
/**
 * File selection drawer plugin - replacement for selectbox-based file selection
 * Uses a SlDrawer with SlTree for hierarchical file selection
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlSelect, SlTree, SlButton, SlInput, SlTreeItem } from '../ui.js'
 */

/**
 * @typedef {object} fileDrawerTriggerPart
 */

/**
 * @typedef {object} fileDrawerPart  
 * @property {SlSelect} variantSelect
 * @property {SlInput} labelFilter
 * @property {SlTree} fileTree
 * @property {SlButton} closeDrawer
 */
import ui, { updateUi, SlOption } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'
import { logger, updateState, hasStateChanged, services } from '../app.js'
import {
  extractVariants,
  filterFileDataByVariant,
  filterFileDataByLabel,
  groupFilesByCollection,
  filterFileContentByVariant,
  findMatchingGold,
  findFileByPdfHash
} from '../modules/file-data-utils.js'

/**
 * plugin API
 */
const api = {
  open,
  close
}

/**
 * component plugin
 */
const plugin = {
  name: "file-selection-drawer",
  install,
  state: {
    update
  }
}

export { api, plugin }
export default plugin

// Register templates
await registerTemplate('file-selection-drawer', 'file-selection-drawer.html');
await registerTemplate('file-drawer-button', 'file-drawer-button.html');

// Internal state
let currentLabelFilter = '';
let needsTreeUpdate = false;
let currentState = null;
let isUpdatingProgrammatically = false;

//
// Implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`);
  
  // Create and add trigger button to toolbar
  const triggerButton = createSingleFromTemplate('file-drawer-button');
  ui.toolbar.add(triggerButton, 10, "afterbegin"); 
  
  // Create and add drawer to document body
  const drawer = createSingleFromTemplate('file-selection-drawer', document.body);
  
  // Update UI to register new elements
  updateUi();
  
  // Wire up event handlers - now the UI elements exist
  triggerButton.addEventListener('click', () => {
    open();
  });
  
  // Close drawer when close button is clicked
  ui.fileDrawer.closeDrawer.addEventListener('click', () => {
    close();
  });
  
  // Close drawer when clicking outside or pressing escape (built into SlDrawer)
  drawer.addEventListener('sl-request-close', () => {
    close();
  });
  
  // Handle variant selection changes
  ui.fileDrawer.variantSelect.addEventListener('sl-change', () => {
    
    
    // Ignore programmatic changes to prevent double-loading
    if (isUpdatingProgrammatically) {
      
      return;
    }
    
    
    // Use currentState instead of stale installation-time state
    if (currentState) {
      onVariantChange(currentState);
    } else {
      console.warn("Variant change ignored: no current state available");
    }
  });
  
  // Handle label filter changes
  ui.fileDrawer.labelFilter.addEventListener('sl-input', () => {
    // Use currentState instead of stale installation-time state
    if (currentState) {
      onLabelFilterChange(currentState);
    } else {
      console.warn("Label filter change ignored: no current state available");
    }
  });
  
  // Handle tree selection changes
  drawer.addEventListener('sl-selection-change', (event) => {
    
    
    // Ignore programmatic changes to prevent double-loading
    if (isUpdatingProgrammatically) {
      
      return;
    }
    
    
    // Use currentState instead of stale installation-time state
    if (currentState) {
      onFileTreeSelection(event, currentState);
    } else {
      console.warn("File tree selection ignored: no current state available");
    }
  });
}

/**
 * Opens the file selection drawer
 */
async function open() {
  logger.debug("Opening file selection drawer");
  ui.fileDrawer?.show();
  
  // Update tree if needed when opening
  if (needsTreeUpdate && currentState?.fileData) {
    await populateFileTree(currentState);
    needsTreeUpdate = false;
  }
}

/**
 * Closes the file selection drawer
 */
function close() {
  logger.debug("Closing file selection drawer");
  ui.fileDrawer.hide();
}

/**
 * Handles state updates
 * @param {ApplicationState} state
 */
async function update(state) {
  // Store current state for lazy loading
  currentState = state;
  
  // Check if relevant state properties have changed
  if (hasStateChanged(state, 'xml', 'pdf', 'variant', 'fileData') && state.fileData) {
    await populateVariantSelect(state);
    
    // Only populate tree if drawer is visible, otherwise mark for lazy update
    const drawer = ui.fileDrawer;
    if (drawer && drawer.open) {
      await populateFileTree(state);
    } else {
      needsTreeUpdate = true;
    }
  }
  
  // Always update selected values (with guard to prevent triggering events)
  if (ui.fileDrawer?.variantSelect) {
    
    isUpdatingProgrammatically = true;
    try {
      ui.fileDrawer.variantSelect.value = state.variant || "";
    } finally {
      isUpdatingProgrammatically = false;
    }
  }
}

/**
 * Populates the variant selectbox with unique variants from fileData
 * @param {ApplicationState} state
 */
async function populateVariantSelect(state) {
  if (!state.fileData) return;
  
  const variantSelect = ui.fileDrawer?.variantSelect;
  if (!variantSelect) return;
  
  // Clear existing options
  variantSelect.innerHTML = "";
  
  // Get unique variants
  const variants = extractVariants(state.fileData);
  
  // Add "All" option
  const allOption = new SlOption();
  allOption.value = "";
  allOption.textContent = "All";
  // @ts-ignore - size property not in SlOption type definition
  allOption.size = "small";
  variantSelect.appendChild(allOption);
  
  // Add "None" option for files without variants
  const noneOption = new SlOption();
  noneOption.value = "none";
  noneOption.textContent = "None";
  // @ts-ignore - size property not in SlOption type definition
  noneOption.size = "small";
  variantSelect.appendChild(noneOption);
  
  // Add variant options
  [...variants].sort().forEach(variant => {
    const option = new SlOption();
    option.value = variant;
    option.textContent = variant;
    // @ts-ignore - size property not in SlOption type definition
    option.size = "small";
    variantSelect.appendChild(option);
  });
  
  // Set current selection (with guard to prevent triggering events)
  isUpdatingProgrammatically = true;
  try {
    variantSelect.value = state.variant || "";
  } finally {
    isUpdatingProgrammatically = false;
  }
}

/**
 * Populates the file tree with hierarchical structure
 * @param {ApplicationState} state
 */
async function populateFileTree(state) {
  if (!state.fileData) return;
  
  const fileTree = ui.fileDrawer?.fileTree;
  if (!fileTree) return;
  
  // Apply filters
  let filteredData = filterFileDataByVariant(state.fileData, state.variant);
  filteredData = filterFileDataByLabel(filteredData, currentLabelFilter);
  
  // Group by collection
  const groupedFiles = groupFilesByCollection(filteredData);
  const collections = Object.keys(groupedFiles).sort();
  
  // Clear existing tree
  fileTree.innerHTML = '';

  // Find which nodes should be expanded based on current selections
  const shouldExpandCollection = (collectionName) => {
    if (!state.pdf && !state.xml) return false;
    const files = groupedFiles[collectionName];
    return files.some(file => {
      // Expand if this collection contains the current PDF
      if (state.pdf && file.pdf.hash === state.pdf) return true;
      // Expand if this collection contains the current XML
      if (state.xml) {
        const { versionsToShow, goldToShow } = filterFileContentByVariant(file, state.variant);
        return [...versionsToShow, ...goldToShow].some(item => item.hash === state.xml);
      }
      return false;
    });
  };

  const shouldExpandPdf = (file) => {
    if (!state.pdf && !state.xml) return false;
    // Expand if this is the current PDF
    if (state.pdf && file.pdf.hash === state.pdf) return true;
    // Expand if this PDF contains the current XML
    if (state.xml) {
      const { versionsToShow, goldToShow } = filterFileContentByVariant(file, state.variant);
      return [...versionsToShow, ...goldToShow].some(item => item.hash === state.xml);
    }
    return false;
  };
  
  // Build tree structure programmatically
  for (const collectionName of collections) {
    const collectionDisplayName = collectionName.replaceAll("_", " ").trim();
    
    // Create collection item
    const collectionItem = document.createElement('sl-tree-item');
    collectionItem.expanded = shouldExpandCollection(collectionName);
    collectionItem.className = 'collection-item';
    collectionItem.innerHTML = `<sl-icon name="folder"></sl-icon><span>${collectionDisplayName}</span>`;
    
    const files = groupedFiles[collectionName]
      .sort((a, b) => (a.label < b.label) ? -1 : (a.label > b.label) ? 1 : 0);
    
    for (const file of files) {
      // Get filtered content for this file
      const { versionsToShow, goldToShow } = filterFileContentByVariant(file, state.variant);
      
      // Create PDF document item
      const pdfItem = document.createElement('sl-tree-item');
      pdfItem.expanded = shouldExpandPdf(file);
      pdfItem.className = 'pdf-item';
      pdfItem.dataset.type = 'pdf';
      pdfItem.dataset.hash = file.pdf.hash;
      pdfItem.dataset.collection = file.collection;
      pdfItem.innerHTML = `<sl-icon name="file-pdf"></sl-icon><span>${file.label}</span>`;
      
      // Add Gold section if there are gold entries
      if (goldToShow.length > 0) {
        const goldSection = document.createElement('sl-tree-item');
        goldSection.expanded = true;
        goldSection.className = 'gold-section';
        goldSection.dataset.type = 'section';
        goldSection.innerHTML = `<sl-icon name="award"></sl-icon><span>Gold</span>`;

        goldToShow.forEach(gold => {
          const goldItem = document.createElement('sl-tree-item');
          goldItem.className = 'gold-item';
          goldItem.dataset.type = 'gold';
          goldItem.dataset.hash = gold.hash;
          goldItem.dataset.pdfHash = file.pdf.hash;
          goldItem.dataset.collection = file.collection;
          if (gold.is_locked) {
            goldItem.innerHTML = `🔒 <span>${gold.label}</span>`;
          } else {
            goldItem.innerHTML = `<span>${gold.label}</span>`;
          }          
          goldSection.appendChild(goldItem);
        });
        pdfItem.appendChild(goldSection);
      }
      
      // Add Versions section if there are versions
      if (versionsToShow.length > 0) {
        const versionsSection = document.createElement('sl-tree-item');
        versionsSection.expanded = false;
        versionsSection.className = 'versions-section';
        versionsSection.dataset.type = 'section';
        versionsSection.innerHTML = `<sl-icon name="file-earmark-diff"></sl-icon><span>Versions</span>`;
        
        versionsToShow.forEach(version => {
          const versionItem = document.createElement('sl-tree-item');
          versionItem.className = 'version-item';
          versionItem.dataset.type = 'version';
          versionItem.dataset.hash = version.hash;
          versionItem.dataset.pdfHash = file.pdf.hash;
          versionItem.dataset.collection = file.collection;
          if (version.is_locked) {
            versionItem.innerHTML = `🔒 <span>${version.label}</span>`;
          } else {
            versionItem.innerHTML = `<span>${version.label}</span>`;
          }
          versionsSection.appendChild(versionItem);
        });
        pdfItem.appendChild(versionsSection);
      }
      
      collectionItem.appendChild(pdfItem);
    }
    
    fileTree.appendChild(collectionItem);
  }
  
  // Programmatically select the item that corresponds to current state
  
  isUpdatingProgrammatically = true;
  try {
    await selectCurrentStateItem(state, fileTree);
  } finally {
    isUpdatingProgrammatically = false;
  }
}

/**
 * Selects the tree item that corresponds to the current state
 * @param {ApplicationState} state
 * @param {SlTree} fileTree
 */
async function selectCurrentStateItem(state, fileTree) {
  if (!state.pdf && !state.xml) return;
  
  let itemToSelect = null;
  
  // Priority: XML item (gold/version) over PDF item
  if (state.xml) {
    // Find XML item (gold or version) with matching hash
    itemToSelect = fileTree.querySelector(`[data-type="gold"][data-hash="${state.xml}"], [data-type="version"][data-hash="${state.xml}"]`);
  } else if (state.pdf) {
    // Find PDF item with matching hash
    itemToSelect = fileTree.querySelector(`[data-type="pdf"][data-hash="${state.pdf}"]`);
  }
  
  if (itemToSelect) {
    // Clear any existing selection first
    const currentSelection = fileTree.querySelectorAll('sl-tree-item[selected]');
    currentSelection.forEach(item => /** @type {SlTreeItem} */ (item).selected = false);
    
    // Select the item
    /** @type {SlTreeItem} */ (itemToSelect).selected = true;
  }
}

//
// Event Handlers
//

/**
 * Handles variant selection changes
 * @param {ApplicationState} state
 */
async function onVariantChange(state) {
  const variant = /** @type {string|null} */ (ui.fileDrawer?.variantSelect?.value);
  
  // Update application state with new variant - clear XML to force reload
  await updateState(state, { variant, xml: null });
}

/**
 * Handles label filter input changes
 * @param {ApplicationState} state
 */
async function onLabelFilterChange(state) {
  currentLabelFilter = ui.fileDrawer?.labelFilter?.value || '';
  
  // Repopulate tree with new filter
  await populateFileTree(state);
}

/**
 * Handles file tree selection changes - only updates state
 * @param {Event} event
 * @param {ApplicationState} state
 */
async function onFileTreeSelection(event, state) {
  // @ts-ignore - detail property exists on custom events
  const selectedItems = event.detail.selection;
  if (selectedItems.length === 0) return;
  if (!state.fileData) {
    throw new Error("No file data in state")
  }
  
  const selectedItem = selectedItems[0];
  const type = selectedItem.dataset.type;
  const hash = selectedItem.dataset.hash;
  const pdfHash = selectedItem.dataset.pdfHash;
  const collection = selectedItem.dataset.collection;
  
  // Don't handle section clicks
  if (type === 'section') return;
  
  // Prepare state updates
  const stateUpdates = {};
  
  if (type === 'pdf') {
    // User selected a PDF document
    stateUpdates.pdf = hash;
    stateUpdates.collection = collection;
    
    // Find matching gold file for this PDF and variant
    const selectedFile = findFileByPdfHash(state.fileData, hash);
    if (selectedFile) {
      const matchingGold = findMatchingGold(selectedFile, state.variant);
      if (matchingGold) {
        stateUpdates.xml = matchingGold.hash;
      } else {
        stateUpdates.xml = null;
      }
    }
  } else if (type === 'gold' || type === 'version') {
    // User selected an XML file (gold or version)
    stateUpdates.xml = hash;
    stateUpdates.collection = collection;
    
    // Ensure the corresponding PDF is loaded
    if (pdfHash && pdfHash !== state.pdf) {
      stateUpdates.pdf = pdfHash;
    }
  }

  // Close drawer before changing the state
  close();
  
  // Update state and load the selected files
  console.log("DEBUG tree selection state update", { type, hash, pdfHash, stateUpdates })
  await updateState(state, stateUpdates);
  
  // Actually load the files (similar to file-selection.js)
  const filesToLoad = {};
  if (stateUpdates.pdf && stateUpdates.pdf !== state.pdf) {
    filesToLoad.pdf = stateUpdates.pdf;
  }
  if (stateUpdates.xml && stateUpdates.xml !== state.xml) {
    filesToLoad.xml = stateUpdates.xml;
  }
  
  if (Object.keys(filesToLoad).length > 0) {
    
    try {
      await services.load(state, filesToLoad);
    } catch (error) {
      console.error("Error loading files:", error.message);
      // On error, reset state and reload file data (similar to file-selection.js)
      await updateState(state, { collection: null, pdf: null, xml: null });
      // Note: fileselection.reload() would be called here, but we don't have access to that plugin
      // The error will be handled by services.load() internally
    }
  }

}
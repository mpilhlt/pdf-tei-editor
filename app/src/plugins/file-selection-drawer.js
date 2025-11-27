/**
 * File selection drawer plugin - replacement for selectbox-based file selection
 * Uses a SlDrawer with SlTree for hierarchical file selection
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlSelect, SlTree, SlButton, SlInput, SlTreeItem } from '../ui.js'
 * @import { DocumentItem } from '../modules/file-data-utils.js'
 */

/**
 * The button to trigger the file drawer 
 * @typedef {object} fileDrawerTriggerPart
 */

/**
 * The file drawer 
 * @typedef {object} fileDrawerPart  
 * @property {SlSelect} variantSelect
 * @property {SlInput} labelFilter
 * @property {SlTree} fileTree
 * @property {SlButton} closeDrawer
 */
import ui, { updateUi, SlOption } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'
import { app, logger, updateState, hasStateChanged, services } from '../app.js'
import {
  extractVariants,
  filterFileDataByVariant,
  filterFileDataByLabel,
  groupFilesByCollection,
  findMatchingGold,
  findFileBySourceId
} from '../modules/file-data-utils.js'

/**
 * Creates a label for a document with optional lock icon
 * @param {string} label - The document label
 * @param {boolean} [isLocked] - Whether the document is locked
 * @returns {string} HTML string with label and optional lock icon
 */
function createDocumentLabel(label, isLocked) {
  return isLocked === true
    ? `<span>${label}</span> <sl-icon name="file-lock2"></sl-icon>`
    : `<span>${label}</span>`;
}

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
/** @type {ApplicationState} */
let currentState;
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
  const collections = Object.keys(groupedFiles).sort((a, b) => {
    if (a === "__unfiled") return -1;
    if (b === "__unfiled") return 1;
    return a.localeCompare(b);
  });

  // Clear existing tree
  fileTree.innerHTML = '';

  // Find which nodes should be expanded based on current selections
  /** @type { (collection:string) => boolean} */
  const shouldExpandCollection = (collectionName) => {
    if (!state.pdf && !state.xml) return false;
    const files = groupedFiles[collectionName];
    return files.some(file => {
      // Expand if this collection contains the current source
      if (state.pdf && file.source?.id === state.pdf) return true;
      // Expand if this collection contains the current XML
      if (state.xml) {
        return file.artifacts?.some(artifact => artifact.id === state.xml);
      }
      return false;
    });
  };

  /** @type { (file:DocumentItem) => boolean} */
  const shouldExpandPdf = (file) => {
    if (!state.pdf && !state.xml) return false;
    // Expand if this is the current source
    if (state.pdf && file.source?.id === state.pdf) return true;
    // Expand if this source contains the current XML
    if (state.xml) {
      return file.artifacts?.some(artifact => artifact.id === state.xml);
    }
    return false;
  };

  // Build tree structure programmatically
  for (const collectionName of collections) {
    // Display "Unfiled" for the special __unfiled collection
    const collectionDisplayName = collectionName === "__unfiled" ? "Unfiled" : collectionName.replaceAll("_", " ").trim();
    
    // Create collection item
    const collectionItem = document.createElement('sl-tree-item');
    collectionItem.expanded = shouldExpandCollection(collectionName);
    collectionItem.className = 'collection-item';
    collectionItem.innerHTML = `<sl-icon name="folder"></sl-icon><span>${collectionDisplayName}</span>`;
    
    const files = groupedFiles[collectionName]
      .sort((a, b) => {
        const aLabel = a.source?.label || a.doc_metadata?.title || a.doc_id;
        const bLabel = b.source?.label || b.doc_metadata?.title || b.doc_id;
        return (aLabel < bLabel) ? -1 : (aLabel > bLabel) ? 1 : 0;
      });

    for (const file of files) {
      // Filter artifacts based on variant
      let artifactsToShow = file.artifacts || [];
      if (state.variant === "none") {
        artifactsToShow = artifactsToShow.filter(a => !a.variant);
      } else if (state.variant && state.variant !== "") {
        artifactsToShow = artifactsToShow.filter(a => a.variant === state.variant);
      }

      // Separate gold and versions
      const goldToShow = artifactsToShow.filter(a => a.is_gold_standard);
      const versionsToShow = artifactsToShow.filter(a => !a.is_gold_standard);

      // Create source/PDF document item
      const pdfItem = document.createElement('sl-tree-item');
      pdfItem.expanded = shouldExpandPdf(file);
      pdfItem.className = 'pdf-item';
      // Use actual file type - distinguish between PDF sources and XML-only sources (like RNG)
      pdfItem.dataset.type = file.source?.file_type === 'pdf' ? 'pdf' : 'xml-only';
      pdfItem.dataset.hash = file.source?.id || '';
      pdfItem.dataset.collection = file.collections[0];
      const displayLabel = file.source?.label || file.doc_metadata?.title || file.doc_id;
      // Use appropriate icon based on file type
      const icon = file.source?.file_type === 'pdf' ? 'file-pdf' : 'file-earmark-code';
      pdfItem.innerHTML = `<sl-icon name="${icon}"></sl-icon><span>${displayLabel}</span>`;
      
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
          goldItem.dataset.hash = gold.id;
          goldItem.dataset.pdfHash = file.source?.id || '';
          goldItem.dataset.collection = file.collections[0];
          goldItem.innerHTML = createDocumentLabel(gold.label, gold.is_locked);
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
          versionItem.dataset.hash = version.id;
          versionItem.dataset.pdfHash = file.source?.id || '';
          versionItem.dataset.collection = file.collections[0];
          versionItem.innerHTML = createDocumentLabel(version.label, version.is_locked);
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
  
  // Priority: XML item (gold/version/xml-only) over PDF item
  if (state.xml) {
    // Find XML item (gold, version, or xml-only source) with matching hash
    itemToSelect = fileTree.querySelector(`[data-type="gold"][data-hash="${state.xml}"], [data-type="version"][data-hash="${state.xml}"], [data-type="xml-only"][data-hash="${state.xml}"]`);
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
  await updateState({ variant, xml: null });
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

    // Find matching gold file for this source and variant
    const selectedFile = findFileBySourceId(state.fileData, hash);
    if (selectedFile) {
      const matchingGold = findMatchingGold(selectedFile, state.variant);
      if (matchingGold) {
        stateUpdates.xml = matchingGold.id;
      } else {
        stateUpdates.xml = null;
      }
    }
  } else if (type === 'xml-only') {
    // User selected an XML-only source file (RNG schema, standalone TEI, etc.)
    // The source IS the XML file
    stateUpdates.xml = hash;
    stateUpdates.pdf = null; // Clear PDF for XML-only files
    stateUpdates.collection = collection;
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
  await updateState(stateUpdates);
  
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
      await services.load(filesToLoad);
    } catch (error) {
      logger.error("Error loading files:" + String(error));
      // On error, reset state and reload file data (similar to file-selection.js)
      await app.updateState({ collection: null, pdf: null, xml: null });
      // Note: fileselection.reload() would be called here, but we don't have access to that plugin
      // The error will be handled by services.load() internally
    }
  }

}
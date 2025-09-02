/**
 * File selection drawer plugin - replacement for selectbox-based file selection
 * Uses a SlDrawer with SlTree for hierarchical file selection
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlSelect, SlTree, SlButton, SlInput } from '../ui.js'
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
import { logger, updateState } from '../app.js'
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
let stateCache = null;

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
    onVariantChange(state);
  });
  
  // Handle label filter changes
  ui.fileDrawer.labelFilter.addEventListener('sl-input', () => {
    onLabelFilterChange(state);
  });
  
  // Handle tree selection changes
  drawer.addEventListener('sl-selection-change', (event) => {
    onFileTreeSelection(event, state);
  });
}

/**
 * Opens the file selection drawer
 */
function open() {
  logger.debug("Opening file selection drawer");
  ui.fileDrawer?.show();
}

/**
 * Closes the file selection drawer
 */
function close() {
  logger.debug("Closing file selection drawer");
  ui.fileDrawer?.hide();
}

/**
 * Handles state updates
 * @param {ApplicationState} state
 */
async function update(state) {
  // Check if state has changed
  const { xml, pdf, variant } = state;
  const jsonState = JSON.stringify({ xml, pdf, variant, fileData: !!state.fileData });
  const stateChanged = jsonState !== stateCache;
  
  if (stateChanged && state.fileData) {
    stateCache = jsonState;
    await populateVariantSelect(state);
    await populateFileTree(state);
  }
  
  // Always update selected values
  if (ui.fileDrawer?.variantSelect) {
    ui.fileDrawer.variantSelect.value = state.variant || "";
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
  
  // Set current selection
  variantSelect.value = state.variant || "";
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

  // default state for branches
  const expanded = false;
  
  // Build tree structure programmatically
  for (const collectionName of collections) {
    const collectionDisplayName = collectionName.replaceAll("_", " ").trim();
    
    // Create collection item
    const collectionItem = document.createElement('sl-tree-item');
    collectionItem.expanded = expanded;
    collectionItem.className = 'collection-item';
    collectionItem.innerHTML = `<sl-icon name="folder"></sl-icon><span>${collectionDisplayName}</span>`;
    
    const files = groupedFiles[collectionName]
      .sort((a, b) => (a.label < b.label) ? -1 : (a.label > b.label) ? 1 : 0);
    
    for (const file of files) {
      // Get filtered content for this file
      const { versionsToShow, goldToShow } = filterFileContentByVariant(file, state.variant);
      
      // Create PDF document item
      const pdfItem = document.createElement('sl-tree-item');
      pdfItem.expanded = expanded;
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
          goldItem.textContent = gold.label;
          goldSection.appendChild(goldItem);
        });
        pdfItem.appendChild(goldSection);
      }
      
      // Add Versions section if there are versions
      if (versionsToShow.length > 0) {
        const versionsSection = document.createElement('sl-tree-item');
        versionsSection.expanded = expanded;
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
            versionItem.disabled = true;
            versionItem.textContent = `🔒 ${version.label}`;
          } else {
            versionItem.textContent = version.label;
          }
          versionsSection.appendChild(versionItem);
        });
        pdfItem.appendChild(versionsSection);
      }
      
      collectionItem.appendChild(pdfItem);
    }
    
    fileTree.appendChild(collectionItem);
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
  const variant = ui.fileDrawer?.variantSelect?.value;
  
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
  
  // Update state - let other plugins handle the loading
  console.log("DEBUG tree selection state update", stateUpdates)
  await updateState(state, stateUpdates);
  
  // Close drawer after selection
  close();
}
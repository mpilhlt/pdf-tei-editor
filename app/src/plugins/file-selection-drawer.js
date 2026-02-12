/**
 * File selection drawer plugin - replacement for selectbox-based file selection
 * Uses a SlDrawer with SlTree for hierarchical file selection
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlSelect, SlTree, SlButton, SlInput, SlTreeItem, SlCheckbox, SlDropdown, SlMenu, SlMenuItem, UIPart } from '../ui.js'
 * @import { DocumentItem } from '../modules/file-data-utils.js'
 */

/**
 * The button to trigger the file drawer
 * @typedef {object} fileDrawerTriggerPart
 */

/**
 * @typedef {object} selectAllContainerPart
 * @property {SlCheckbox} selectAllCheckbox
 */

/**
 * @typedef {object} exportMenuPart
 * @property {SlMenuItem} exportDefault
 * @property {SlMenuItem} exportWithVersions
 * @property {SlMenuItem} exportTeiOnly
 * @property {SlMenuItem} exportTeiAllVersions
 * @property {HTMLDivElement} exportFormatCheckboxes
 */

/**
 * @typedef {object} ExportFormatInfo
 * @property {string} id - Format identifier
 * @property {string} label - Display label for the format
 * @property {string} url - URL to the XSLT stylesheet
 */

/**
 * @typedef {object} exportDropdownPart
 * @property {SlButton} exportButton
 * @property {UIPart<SlMenu, exportMenuPart>} exportMenu
 */

/**
 * The file drawer
 * @typedef {object} fileDrawerPart
 * @property {SlSelect} variantSelect
 * @property {SlInput} labelFilter
 * @property {UIPart<HTMLDivElement, selectAllContainerPart>} selectAllContainer
 * @property {SlTree} fileTree
 * @property {SlButton} importButton
 * @property {HTMLInputElement} importFileInput
 * @property {UIPart<SlDropdown, exportDropdownPart>} exportDropdown
 * @property {SlButton} deleteButton
 * @property {SlButton} newCollectionButton
 * @property {SlButton} closeDrawer
 */
import ui, { updateUi, SlOption } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'
import { app, logger, updateState, hasStateChanged, services, dialog, client } from '../app.js'
import {
  extractVariants,
  filterFileDataByVariant,
  filterFileDataByLabel,
  groupFilesByCollection,
  findMatchingGold,
  findFileBySourceId,
  getCollectionName
} from '../modules/file-data-utils.js'
import { notify } from '../modules/sl-utils.js'
import { FiledataPlugin } from '../plugins.js'

/**
 * Creates a label for a document with optional lock icon and variant suffix
 * @param {string} label - The document label
 * @param {boolean} [isLocked] - Whether the document is locked
 * @param {string} [variantId] - Optional variant ID to append in brackets
 * @returns {string} HTML string with label, optional variant suffix, and optional lock icon
 */
function createDocumentLabel(label, isLocked, variantId) {
  const displayLabel = variantId ? `${label} [${variantId}]` : label;
  return isLocked === true
    ? `<span>${displayLabel}</span> <sl-icon name="file-lock2"></sl-icon>`
    : `<span>${displayLabel}</span>`;
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
/** @type {Set<string>} */
let selectedCollections = new Set();
/** @type {ExportFormatInfo[]} */
let availableExportFormats = [];

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

  // Handle select all/none checkbox
  ui.fileDrawer.selectAllContainer.selectAllCheckbox.addEventListener('sl-change', () => {
    onSelectAllChange();
  });

  // Handle export menu selection
  ui.fileDrawer.exportDropdown.exportMenu.addEventListener('sl-select', async (event) => {
    if (!currentState) return;
    // @ts-ignore - detail.item exists on SlMenu sl-select events
    const item = event.detail.item;
    const name = item.getAttribute('name');
    if (name === 'exportDefault') {
      await handleExport(currentState, { includeVersions: false, teiOnly: false });
    } else if (name === 'exportWithVersions') {
      await handleExport(currentState, { includeVersions: true, teiOnly: false });
    } else if (name === 'exportTeiOnly') {
      await handleExport(currentState, { includeVersions: false, teiOnly: true });
    } else if (name === 'exportTeiAllVersions') {
      await handleExport(currentState, { includeVersions: true, teiOnly: true });
    }
  });

  // Handle delete button
  ui.fileDrawer.deleteButton.addEventListener('click', async () => {
    if (currentState) {
      await handleDelete(currentState);
    }
  });

  // Handle import button
  ui.fileDrawer.importButton.addEventListener('click', () => {
    // Trigger hidden file input
    ui.fileDrawer.importFileInput.click();
  });

  // Handle file input change (user selected a file)
  ui.fileDrawer.importFileInput.addEventListener('change', async () => {
    if (currentState) {
      await handleImport(currentState);
    }
  });

  // Handle new collection button
  ui.fileDrawer.newCollectionButton.addEventListener('click', async () => {
    logger.debug("New collection button clicked");
    if (currentState) {
      await handleNewCollection(currentState);
    } else {
      logger.warn("New collection button clicked but no current state available");
    }
  });
}

/**
 * Opens the file selection drawer
 */
async function open() {
  logger.debug("Opening file selection drawer");
  ui.fileDrawer?.show();
  
  // Fetch and populate export formats
  await fetchExportFormats();
  populateExportFormats();
  
  // Update tree if needed when opening
  if (needsTreeUpdate && currentState?.fileData) {
    await populateFileTree(currentState);
    needsTreeUpdate = false;
  }
}

/**
 * Fetches available export formats from plugins using the no-call flag
 */
async function fetchExportFormats() {
  try {
    const pluginManager = app.getPluginManager();
    const results = await pluginManager.invoke('export_formats', []);
    // Flatten the array of arrays into a single array
    const allFormats = [];
    for (const result of results) {
      if (result && Array.isArray(result)) {
        allFormats.push(...result);
      } else {
        allFormats.push(result);
      }
    }
    
    availableExportFormats = allFormats;
    logger.debug(`Fetched ${availableExportFormats.length} export formats`);
  } catch (error) {
    logger.warn(`Failed to fetch export formats: ${error}`);
    availableExportFormats = [];
  }
}

/**
 * Populates the export format checkboxes in the export menu
 */
function populateExportFormats() {
  const container = ui.fileDrawer.exportDropdown.exportMenu.querySelector('[name="exportFormatCheckboxes"]');
  const divider = ui.fileDrawer.exportDropdown.exportMenu.querySelector('[name="exportFormatsDivider"]');
  
  if (!container) return;
  
  // Clear existing checkboxes (keep the title)
  const title = container.querySelector('div');
  container.innerHTML = '';
  if (title) {
    container.appendChild(title);
  }
  
  // Show/hide based on whether we have formats
  if (availableExportFormats.length === 0) {
    container.style.display = 'none';
    if (divider) divider.style.display = 'none';
    return;
  }
  
  // Show the container and divider
  container.style.display = 'block';
  if (divider) divider.style.display = 'block';
  
  // Add checkbox for each format
  availableExportFormats.forEach(format => {
    const div = document.createElement('div');
    let html = `<sl-checkbox size="small" value="${format.id}">${format.label}</sl-checkbox>`;
    div.innerHTML = html;
    container.appendChild(div);
    
    // Stop click propagation to prevent menu closing
    div.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });
}

/**
 * Gets the checked export formats with their URLs
 * @returns {Array<{id: string, url: string}>}
 */
function getCheckedExportFormats() {
  const container = ui.fileDrawer.exportDropdown.exportMenu.querySelector('[name="exportFormatCheckboxes"]');
  if (!container) return [];
  
  const checked = container.querySelectorAll('sl-checkbox[checked]');
  const results = [];
  
  checked.forEach(checkbox => {
    const formatId = checkbox.value;
    const format = availableExportFormats.find(f => f.id === formatId);
    if (format) {
      results.push(format);
    }
  });
  
  return results;
}

/**
 * Closes the file selection drawer
 */
function close() {
  logger.debug("Closing file selection drawer");

  // Clear selected collections on close
  selectedCollections.clear();
  updateExportButtonState();

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
  if (hasStateChanged(state, 'xml', 'pdf', 'variant', 'fileData', 'collections') && state.fileData) {
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

  // Update button visibility based on user role
  updateButtonVisibility(state);
}

/**
 * Updates the visibility of import/export/delete/new buttons based on user role
 * @param {ApplicationState} state
 */
function updateButtonVisibility(state) {
  const user = state.user;
  const hasReviewerRole = user && user.roles && (
    user.roles.includes('*') ||
    user.roles.includes('admin') ||
    user.roles.includes('reviewer')
  );

  // Show buttons only if user has reviewer role or higher
  const importButton = ui.fileDrawer.importButton;
  const exportDropdown = ui.fileDrawer.exportDropdown;
  const deleteButton = ui.fileDrawer.deleteButton;
  const newCollectionButton = ui.fileDrawer.newCollectionButton;

  if (hasReviewerRole) {
    importButton.style.display = '';
    exportDropdown.style.display = '';
    deleteButton.style.display = '';
    newCollectionButton.style.display = '';
  } else {
    importButton.style.display = 'none';
    exportDropdown.style.display = 'none';
    deleteButton.style.display = 'none';
    newCollectionButton.style.display = 'none';
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

  // Get all collections including empty ones from state.collections
  const collectionsSet = new Set(Object.keys(groupedFiles));
  if (state.collections) {
    state.collections.forEach(col => collectionsSet.add(col.id));
  }

  const collections = Array.from(collectionsSet).sort((a, b) => {
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
    if (!files) return false; // Empty collection has no files to expand
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

  // Show/hide select-all container based on whether collections exist
  const selectAllContainer = ui.fileDrawer.selectAllContainer;
  selectAllContainer.style.display = collections.length > 0 ? 'block' : 'none';

  // Build tree structure programmatically
  for (const collectionName of collections) {
    // Display "Unfiled" for the special __unfiled collection
    const collectionDisplayName = getCollectionName(collectionName, state.collections);

    // Create collection item with checkbox
    const collectionItem = document.createElement('sl-tree-item');
    collectionItem.expanded = shouldExpandCollection(collectionName);
    collectionItem.className = 'collection-item';
    collectionItem.dataset.collection = collectionName;

    // Create checkbox
    const checkbox = document.createElement('sl-checkbox');
    checkbox.size = 'small';
    checkbox.checked = selectedCollections.has(collectionName);

    // Stop click events from propagating to prevent tree expansion/collapse
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    checkbox.addEventListener('sl-change', (e) => {
      e.stopPropagation();
      onCollectionCheckboxChange(collectionName, checkbox.checked);
    });

    // Create label with folder icon
    const label = document.createElement('span');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '0.5rem';
    label.innerHTML = `<sl-icon name="folder"></sl-icon><span>${collectionDisplayName}</span>`;

    // Clear and append children
    collectionItem.innerHTML = '';
    collectionItem.appendChild(checkbox);
    collectionItem.appendChild(label);

    // Get files for this collection (may be empty)
    const files = (groupedFiles[collectionName] || [])
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
          // Show variant suffix when filter is "all" (empty string)
          const variantSuffix = (!state.variant || state.variant === "") ? gold.variant : undefined;
          const goldItem = document.createElement('sl-tree-item');
          goldItem.className = 'gold-item';
          goldItem.dataset.type = 'gold';
          goldItem.dataset.hash = gold.id;
          goldItem.dataset.pdfHash = file.source?.id || '';
          goldItem.dataset.collection = file.collections[0];
          goldItem.innerHTML = createDocumentLabel(gold.label, gold.is_locked, variantSuffix);
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
          // Show variant suffix when filter is "all" (empty string)
          const variantSuffix = (!state.variant || state.variant === "") ? version.variant : undefined;
          const versionItem = document.createElement('sl-tree-item');
          versionItem.className = 'version-item';
          versionItem.dataset.type = 'version';
          versionItem.dataset.hash = version.id;
          versionItem.dataset.pdfHash = file.source?.id || '';
          versionItem.dataset.collection = file.collections[0];
          versionItem.innerHTML = createDocumentLabel(version.label, version.is_locked, variantSuffix);
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

  // Update export button state to match current selections
  updateExportButtonState();
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

/**
 * Handles collection checkbox change
 * @param {string} collectionName
 * @param {boolean} checked
 */
function onCollectionCheckboxChange(collectionName, checked) {
  if (checked) {
    selectedCollections.add(collectionName);
  } else {
    selectedCollections.delete(collectionName);
  }
  updateExportButtonState();
}

/**
 * Handles select all/none checkbox change
 */
function onSelectAllChange() {
  const selectAllCheckbox = ui.fileDrawer.selectAllContainer.selectAllCheckbox;
  const fileTree = ui.fileDrawer.fileTree;
  const checked = selectAllCheckbox.checked;

  // Find all collection checkboxes and update them
  const collectionItems = fileTree.querySelectorAll('.collection-item');

  collectionItems.forEach(item => {
    const checkbox = /** @type {SlCheckbox} */ (item.querySelector('sl-checkbox'));
    const collectionName = item.dataset.collection;
    if (checkbox && collectionName) {
      checkbox.checked = checked;

      // Manually update selectedCollections since programmatic checkbox changes don't fire sl-change
      if (checked) {
        selectedCollections.add(collectionName);
      } else {
        selectedCollections.delete(collectionName);
      }
    }
  });

  updateExportButtonState();
}

/**
 * Updates the export and delete button enabled/disabled state based on selected collections
 */
function updateExportButtonState() {
  const exportButton = ui.fileDrawer.exportDropdown.exportButton;
  const deleteButton = ui.fileDrawer.deleteButton;

  const hasSelection = selectedCollections.size > 0;
  exportButton.disabled = !hasSelection;

  // Delete button is enabled when one or more collections are selected
  deleteButton.disabled = !hasSelection;
}

/**
 * Handles export menu selection
 * @param {ApplicationState} state
 * @param {{includeVersions?: boolean, teiOnly?: boolean}} options
 */
async function handleExport(state, { includeVersions = false, teiOnly = false } = {}) {
  if (selectedCollections.size === 0) return;
  if (!state.sessionId) {
    logger.error("Cannot export: no session ID available");
    return;
  }

  const collections = Array.from(selectedCollections).join(',');

  // Build base URL params
  const params = new URLSearchParams({
    sessionId: state.sessionId,
    collections: collections
  });

  // Add variant filter if a specific variant is selected
  const variantSelect = ui.fileDrawer.variantSelect;
  const selectedVariant = variantSelect.value;
  if (selectedVariant && selectedVariant !== '') {
    params.append('variants', selectedVariant);
  }

  if (includeVersions) {
    params.append('include_versions', 'true');
  }

  if (teiOnly) {
    params.append('tei_only', 'true');
  }

  // Get checked additional export formats (id and url pairs)
  const checkedFormats = getCheckedExportFormats();
  if (checkedFormats.length > 0) {
    // Pass as JSON array: [{"id":"csv","url":"/api/plugins/xslt_export/static/html/biblstruct-to-csv.xslt"},...]
    params.append('additional_formats', JSON.stringify(checkedFormats));
    logger.debug(`Additional export formats: ${checkedFormats.map(f => f.id).join(', ')}`);
  }

  logger.debug(`Exporting collections: ${collections}${selectedVariant ? ` (variant: ${selectedVariant})` : ''}${includeVersions ? ' (with versions)' : ''}${teiOnly ? ' (TEI only)' : ''}`);

  // Disable export button during operation
  const exportButton = ui.fileDrawer.exportDropdown.exportButton;
  exportButton.disabled = true;
  exportButton.loading = true;

  try {
    // Step 1: Get export stats (without download)
    const statsUrl = `/api/v1/export?${params.toString()}`;
    const statsResponse = await fetch(statsUrl);

    if (!statsResponse.ok) {
      let errorMessage = `Export failed: ${statsResponse.statusText}`;
      try {
        const errorData = await statsResponse.json();
        if (errorData.detail) {
          errorMessage = errorData.detail;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    const stats = await statsResponse.json();

    // Check if there are files to export
    if (!stats.files_exported || stats.files_exported <= 0) {
      notify("No files to export. The selected collections may be empty or contain no matching files.", "warning", "exclamation-triangle");
      return;
    }

    // Step 2: Download the actual ZIP file
    params.append('download', 'true');
    const downloadUrl = `/api/v1/export?${params.toString()}`;
    const downloadResponse = await fetch(downloadUrl);

    if (!downloadResponse.ok) {
      let errorMessage = `Download failed: ${downloadResponse.statusText}`;
      try {
        const errorData = await downloadResponse.json();
        if (errorData.detail) {
          errorMessage = errorData.detail;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    // Create blob from response and trigger download
    const blob = await downloadResponse.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = 'export.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);

    // Show success notification with stats
    notify(`Exported ${stats.files_exported} files successfully`, "success", "check-circle");
    logger.info(`Export completed: ${stats.files_exported} files exported`);
  } catch (error) {
    logger.error("Export failed: " + String(error));
    notify(error.message || "Export failed", "danger", "exclamation-octagon");
  } finally {
    // Re-enable export button
    exportButton.disabled = selectedCollections.size === 0;
    exportButton.loading = false;
  }
}

/**
 * Handles import button click and file upload
 * @param {ApplicationState} state
 */
async function handleImport(state) {
  const fileInput = ui.fileDrawer.importFileInput;
  const file = fileInput.files?.[0];

  if (!file) {
    logger.debug("No file selected for import");
    return;
  }

  if (!state.sessionId) {
    logger.error("Cannot import: no session ID available");
    notify("Cannot import: not authenticated", "danger", "exclamation-triangle");
    return;
  }

  logger.info(`Importing file: ${file.name} (${file.size} bytes)`);

  try {
    // Disable import button during upload
    const importButton = ui.fileDrawer.importButton;
    importButton.disabled = true;
    importButton.loading = true;

    // Create form data
    const formData = new FormData();
    formData.append('file', file);

    // Upload to import endpoint with recursive_collections enabled
    const url = `/api/v1/import?sessionId=${encodeURIComponent(state.sessionId)}&recursive_collections=true`;
    const response = await fetch(url, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || `Import failed: ${response.statusText}`);
    }

    const stats = await response.json();

    logger.info(
      `Import completed: ${stats.files_imported} imported, ` +
      `${stats.files_skipped} skipped, ${stats.errors?.length || 0} errors`
    );

    // Show success message
    let message = `Imported ${stats.files_imported} files`;
    if (stats.files_skipped > 0) {
      message += `, skipped ${stats.files_skipped}`;
    }
    if (stats.errors && stats.errors.length > 0) {
      message += `, ${stats.errors.length} errors`;
      notify(message, "warning", "exclamation-triangle");
      // Log errors for debugging
      stats.errors.forEach(err => {
        logger.error(`Import error for ${err.doc_id}: ${err.error}`);
      });
    } else {
      notify(message, "success", "check-circle");
    }

    // Clear file input
    fileInput.value = '';

    // Close drawer
    close();

    // Reload file data to show newly imported files
    await FiledataPlugin.getInstance().reload({ refresh: true });

  } catch (error) {
    logger.error("Import failed: " + String(error));
    notify(`Import failed: ${error.message}`, "danger", "exclamation-octagon");

    // Clear file input on error
    fileInput.value = '';
  } finally {
    // Re-enable import button
    const importButton = ui.fileDrawer.importButton;
    importButton.disabled = false;
    importButton.loading = false;
  }
}

/**
 * Handles new collection button click
 * @param {ApplicationState} state
 */
async function handleNewCollection(state) {
  logger.debug("handleNewCollection called");

  const newCollectionId = await dialog.prompt(
    "Enter new collection ID (Only letters, numbers, '-' and '_'):",
    "New Collection",
    "",
    "collection-id"
  );

  logger.debug(`Collection ID from prompt: ${newCollectionId}`);

  if (!newCollectionId) {
    logger.debug("Collection creation cancelled - no ID provided");
    return;
  }

  // Validate collection ID format
  if (!/^[a-zA-Z0-9_-]+$/.test(newCollectionId)) {
    logger.warn(`Invalid collection ID: ${newCollectionId}`);
    notify("Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed.", "danger", "exclamation-triangle");
    return;
  }

  logger.debug("Collection ID validated, showing name prompt");

  const newCollectionName = await dialog.prompt(
    "Enter collection display name (optional, leave blank to use ID):",
    "Collection Name",
    newCollectionId
  );

  logger.debug(`Collection name from prompt: ${newCollectionName}`);

  // If user cancelled the name prompt, treat it as cancellation
  if (newCollectionName === null) {
    logger.debug("Collection creation cancelled - name prompt cancelled");
    return;
  }

  logger.debug("Proceeding with collection creation");

  if (!state.sessionId) {
    logger.error("Cannot create collection: no session ID available");
    notify("Cannot create collection: not authenticated", "danger", "exclamation-triangle");
    return;
  }

  logger.info(`Creating new collection: ${newCollectionId}`);

  try {
    // Disable new collection button during operation
    const newCollectionButton = ui.fileDrawer.newCollectionButton;
    newCollectionButton.disabled = true;
    newCollectionButton.loading = true;

    const result = await client.createCollection(
      newCollectionId,
      newCollectionName || newCollectionId
    );

    if (result) {
      logger.info(`Collection '${newCollectionId}' created successfully`);
      notify(`Collection '${newCollectionName || newCollectionId}' created successfully`, "success", "check-circle");

      // Reload file data to update collections in state
      await FiledataPlugin.getInstance().reload({ refresh: true });
    }
  } catch (error) {
    logger.error("Failed to create collection: " + String(error));
    notify(`Failed to create collection: ${error.message || String(error)}`, "danger", "exclamation-octagon");
  } finally {
    // Re-enable new collection button
    const newCollectionButton = ui.fileDrawer.newCollectionButton;
    newCollectionButton.disabled = false;
    newCollectionButton.loading = false;
  }
}

/**
 * Handles delete button click with confirmation
 * @param {ApplicationState} state
 */
async function handleDelete(state) {
  if (selectedCollections.size === 0) {
    logger.warn("Delete button clicked but no collections selected");
    return;
  }

  const collectionIds = Array.from(selectedCollections);

  // Build confirmation message
  let confirmMessage;
  if (collectionIds.length === 1) {
    const collectionName = getCollectionName(collectionIds[0], state.collections);
    confirmMessage =
      `Do you really want to delete collection '${collectionName}' and its content?\n\n` +
      `This will remove the collection and mark all files that are only in this collection as deleted.`;
  } else {
    const collectionNames = collectionIds.map(id => getCollectionName(id, state.collections)).join(', ');
    confirmMessage =
      `Do you really want to delete ${collectionIds.length} collections (${collectionNames}) and their content?\n\n` +
      `This will remove the collections and mark all files that are only in these collections as deleted.`;
  }

  // Show confirmation dialog
  const confirmed = confirm(confirmMessage);

  if (!confirmed) {
    logger.debug(`Collection deletion cancelled by user: ${collectionIds.join(', ')}`);
    return;
  }

  if (!state.sessionId) {
    logger.error("Cannot delete collections: no session ID available");
    notify("Cannot delete collections: not authenticated", "danger", "exclamation-triangle");
    return;
  }

  logger.info(`Deleting collections: ${collectionIds.join(', ')}`);

  try {
    // Disable delete button during operation
    const deleteButton = ui.fileDrawer.deleteButton;
    deleteButton.disabled = true;
    deleteButton.loading = true;

    let totalFilesUpdated = 0;
    let totalFilesDeleted = 0;
    const errors = [];

    // Delete collections sequentially
    for (const collectionId of collectionIds) {
      try {
        const url = `/api/v1/collections/${encodeURIComponent(collectionId)}`;
        const response = await fetch(url, {
          method: 'DELETE',
          headers: {
            'X-Session-ID': state.sessionId
          }
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.detail || `Delete failed: ${response.statusText}`);
        }

        const result = await response.json();
        totalFilesUpdated += result.files_updated;
        totalFilesDeleted += result.files_deleted;

        logger.info(
          `Collection '${collectionId}' deleted: ${result.files_updated} files updated, ` +
          `${result.files_deleted} files deleted`
        );
      } catch (error) {
        logger.error(`Failed to delete collection '${collectionId}': ${error}`);
        errors.push({ collectionId, error: error.message });
      }
    }

    // Show result message
    if (errors.length === 0) {
      let message;
      if (collectionIds.length === 1) {
        const collectionName = getCollectionName(collectionIds[0], state.collections);
        message = `Collection '${collectionName}' deleted successfully.`;
      } else {
        message = `${collectionIds.length} collections deleted successfully.`;
      }
      if (totalFilesUpdated > 0 || totalFilesDeleted > 0) {
        message += ` ${totalFilesUpdated} files updated, ${totalFilesDeleted} files deleted.`;
      }
      notify(message, "success", "check-circle");
    } else if (errors.length < collectionIds.length) {
      // Partial success
      const successCount = collectionIds.length - errors.length;
      const errorCollections = errors.map(e => getCollectionName(e.collectionId, state.collections)).join(', ');
      notify(
        `${successCount} collections deleted, but ${errors.length} failed: ${errorCollections}`,
        "warning",
        "exclamation-triangle"
      );
    } else {
      // All failed
      notify(`Failed to delete all ${collectionIds.length} collections`, "danger", "exclamation-octagon");
    }

    // Clear selection
    selectedCollections.clear();
    updateExportButtonState();

    // Close drawer
    close();

    // Reload file data to reflect changes
    await FiledataPlugin.getInstance().reload({ refresh: true });

  } catch (error) {
    logger.error("Delete failed: " + String(error));
    notify(`Delete failed: ${error.message}`, "danger", "exclamation-octagon");
  } finally {
    // Re-enable delete button
    const deleteButton = ui.fileDrawer.deleteButton;
    deleteButton.disabled = selectedCollections.size === 0;
    deleteButton.loading = false;
  }
}
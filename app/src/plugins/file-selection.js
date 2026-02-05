/**
 * This implements the UI for the file selection
 */


/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlSelect } from '../ui.js'
 * @import { DocumentItem, Artifact } from '../modules/file-data-utils.js'
 */
import ui from '../ui.js'
import { SlOption, SlDivider, updateUi } from '../ui.js'
import { registerTemplate, createFromTemplate, createHtmlElements } from '../modules/ui-system.js'
import { app, logger, services, dialog, updateState, hasStateChanged } from '../app.js'
import { FiledataPlugin } from '../plugins.js'
import { groupFilesByCollection, getCollectionName } from '../modules/file-data-utils.js'

/**
 * The data about the pdf and xml files on the server
 * @type {DocumentItem[]}
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
    update
  },
  filedata: {
    loading: onFiledataLoading
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

/** @type {ApplicationState} */
let currentState;

//
// Helper functions
//

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
    ? `${displayLabel}<sl-icon name="file-lock2" slot="suffix"></sl-icon>`
    : displayLabel;
}

/**
 * Updates the selected values of the file selectboxes based on current state
 * @param {ApplicationState} state
 */
function updateSelectboxValues(state) {
  isUpdatingProgrammatically = true;
  try {
    // For XML-only files where pdf is null, find the correct source identifier
    let sourceValue = state.pdf || "";
    if (!state.pdf && state.xml && state.fileData) {
      // Find the file that contains this XML and get its identifier
      const xmlFile = state.fileData.find(file =>
        file.artifacts && file.artifacts.some(a => a.id === state.xml)
      );
      if (xmlFile) {
        // For XML-only files, the source identifier is the XML id itself
        if (!xmlFile.source) {
          sourceValue = state.xml;
        }
      }
    }

    ui.toolbar.pdf.value = sourceValue;
    ui.toolbar.xml.value = state.xml || "";
    ui.toolbar.diff.value = state.diff || "";
  } finally {
    isUpdatingProgrammatically = false;
  }
}

/**
 * Sets the loading state on all file selection selectboxes
 * @param {boolean} isLoading - Whether data is being loaded
 */
function setSelectboxLoadingState(isLoading) {
  const selectboxes = [
    ui.toolbar.pdf,
    ui.toolbar.xml,
    ui.toolbar.diff,
    ui.toolbar.variant,
    ui.toolbar.collection
  ];

  for (const select of selectboxes) {
    if (isLoading) {
      select.disabled = true;
      select.classList.add('loading');
    } else {
      select.disabled = false;
      select.classList.remove('loading');
    }
  }
}

/**
 * Endpoint handler for filedata.loading - called when file loading starts/ends
 * @param {boolean} isLoading - Whether loading is in progress
 */
async function onFiledataLoading(isLoading) {
  isFileLoading = isLoading;
  setSelectboxLoadingState(isLoading);

  if (!isLoading) {
    // Loading complete - repopulate selectboxes with actual data
    if (currentState && currentState.fileData) {
      await populateSelectboxes(currentState);
      updateSelectboxValues(currentState);
    }
  }
}

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
  /** @type { Record<string, Number>} */
  const controlPriorities = {
    'pdf': 10,    // High priority - essential (source file)
    'xml': 10,    // High priority - essential (target file)
    'collection': 6, // Medium-high priority (collection filter)
    'variant': 5, // Medium priority
    'diff': 3     // Lower priority
  };

  fileSelectionControls.forEach(control => {
    // Ensure we're working with HTMLElement
    if (control instanceof HTMLElement) {
      const name = control.getAttribute('name');
      const priority = (name && controlPriorities[name]) || 1;
      ui.toolbar.add(control, priority);
    }
  });
  updateUi()

  /**  @type {[SlSelect,function][]} */
  const handlers = [
    [ui.toolbar.collection, onChangeCollectionSelection],
    [ui.toolbar.variant, onChangeVariantSelection],
    [ui.toolbar.pdf, onChangePdfSelection],
    [ui.toolbar.xml, onChangeXmlSelection],
    [ui.toolbar.diff, onChangeDiffSelection]
  ]

  for (const [select, handler] of handlers) {
    // add event handler for the selectbox
    select.addEventListener('sl-change', async evt => {
      
      // Ignore programmatic changes to prevent double-loading
      if (isUpdatingProgrammatically) {
        return;

      }
      // Ignore user changes during reactive state update cycle to prevent infinite loops
      if (isInStateUpdateCycle) {
        return;
      }
      await handler()
    });

    // this works around a problem with the z-index of the select dropdown being bound 
    // to the z-index of the parent toolbar (and therefore being hidden by the editors)
    select.addEventListener('sl-show', () => {
      select.closest('tool-bar')?.classList.add('dropdown-open');
    });

    select.addEventListener('sl-hide', () => {
      select.closest('tool-bar')?.classList.remove('dropdown-open');
    });
  }
}

/**
 * 
 * @param {ApplicationState} state 
 */
async function update(state) {
  // Set flag to prevent event handlers from causing state mutations during reactive updates
  isInStateUpdateCycle = true;

  try {
    // Store current state for use in event handlers
    currentState = state;

    // Note: Don't mutate state directly in update() - that would cause infinite loops
    // The state.collection should be managed by other functions that call updateState()

    // Check if collections state changed - repopulate collection selectbox
    if (hasStateChanged(state, 'collections') && state.collections) {
      await populateCollectionSelectbox(state);
    }

    // Check if relevant state properties have changed
    if (hasStateChanged(state, 'xml', 'pdf', 'diff', 'variant', 'fileData', 'collectionFilter') && state.fileData) {
      const fileDataChanged = hasStateChanged(state, 'fileData');
      const selectionsChanged = hasStateChanged(state, 'xml', 'pdf', 'diff', 'variant', 'collectionFilter');

      if (selectionsChanged || fileDataChanged) {
        await populateSelectboxes(state);
      } else {
        logger.debug("Not repopulating selectboxes.")
      }
    }

    // Always update selected values
    updateSelectboxValues(state);
  } finally {
    // Clear flag after update cycle completes
    isInStateUpdateCycle = false;
  }
}

/**
 * Check if current PDF/XML selections are still valid in the updated fileData
 * @param {ApplicationState} state
 * @returns {boolean} True if current selections are valid
 */
function isCurrentSelectionValid(state) {
  if (!state.fileData || state.fileData.length === 0) {
    return false;
  }

  // Check if current PDF selection exists in fileData
  if (state.pdf) {
    const pdfExists = state.fileData.some(file =>
      file.source && file.source.id === state.pdf
    );
    if (!pdfExists) return false;
  }

  // Check if current XML selection exists in fileData
  if (state.xml) {
    const xmlExists = state.fileData.some(file =>
      file.artifacts && file.artifacts.some(a => a.id === state.xml)
    );
    if (!xmlExists) return false;
  }

  // Check if current diff selection exists in fileData
  if (state.diff) {
    const diffExists = state.fileData.some(file =>
      file.artifacts && file.artifacts.some(a => a.id === state.diff)
    );
    if (!diffExists) return false;
  }

  return true; // All current selections are valid
}

/**
 * Reloads data and then updates based on the application state
 * @param {Object} options - Options for reloading
 * @param {boolean} [options.refresh] - Whether to force refresh of server cache
 */
async function reload(options = {}) {
  await FiledataPlugin.getInstance().reload(options);
  // Note: populateSelectboxes() will be called automatically via the update() method 
  // when reloadFileData() triggers a state update with new fileData
}

/** @type {Set<string>} */
let variants
let collections
let isUpdatingProgrammatically = false
let isInStateUpdateCycle = false
let isPopulatingSelectboxes = false
let isFileLoading = false

/**
 * Populates the collection filter selectbox
 * @param {ApplicationState} state
 */
async function populateCollectionSelectbox(state) {
  if (!state.collections) {
    return;
  }

  // Clear existing options
  ui.toolbar.collection.innerHTML = "";

  // Add "All" option (no filtering)
  const allOption = new SlOption();
  allOption.value = "";
  allOption.textContent = "All";
  // @ts-ignore - size property not in SlOption type definition
  allOption.size = "small";
  ui.toolbar.collection.appendChild(allOption);

  // Add collection options sorted alphabetically
  const sortedCollections = [...state.collections]
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const collection of sortedCollections) {
    const option = new SlOption();
    option.value = collection.id;
    option.textContent = collection.name;
    // @ts-ignore - size property not in SlOption type definition
    option.size = "small";
    ui.toolbar.collection.appendChild(option);
  }

  // Set current selection (with guard to prevent triggering events)
  isUpdatingProgrammatically = true;
  try {
    ui.toolbar.collection.value = state.collectionFilter || "";
  } finally {
    isUpdatingProgrammatically = false;
  }
}

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
    // Add variant from artifacts
    if (file.artifacts) {
      file.artifacts.forEach(artifact => {
        if (artifact.variant) {
          variants.add(artifact.variant);
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
  // Skip population during file loading - the loading indicator should remain visible
  if (isFileLoading) {
    logger.debug("Ignoring populateSelectboxes request - file loading in progress");
    return;
  }

  // Prevent concurrent population
  if (isPopulatingSelectboxes) {
    logger.debug("Ignoring populateSelectboxes request - already in progress");
    return;
  }

  if (!state.fileData) {
    throw new Error("fileData hasn't been loaded yet")
  }

  isPopulatingSelectboxes = true;
  logger.debug("Populating selectboxes")

  // Disable selectboxes and show loading state before clearing/repopulating
  setSelectboxLoadingState(true);

  try {
    // Populate variant selectbox first
    await populateVariantSelectbox(state);

    // Clear existing options
    for (const name of ["pdf", "xml", "diff"]) {
      // @ts-ignore
      ui.toolbar[name].innerHTML = ""
    }

    // If no files, keep selectboxes empty
    if (state.fileData.length === 0) {
      logger.debug("No files to display, selectboxes cleared")
      return
    }

  const fileData = state.fileData;

  // Filter files by collection filter selection
  let filteredFileData = fileData;
  const collectionFilter = state.collectionFilter;

  if (collectionFilter && collectionFilter !== "") {
    // Show only files in the selected collection
    filteredFileData = fileData.filter(file =>
      file.collections && file.collections.includes(collectionFilter)
    );
  }

  // Filter files by variant selection
  const variant = state.variant;

  if (variant === "none") {
    // Show only files without variant in artifacts
    filteredFileData = filteredFileData.filter(file => {
      const hasArtifactVariant = file.artifacts && file.artifacts.some(a => !!a.variant);
      return !hasArtifactVariant;
    });
  } else if (variant && variant !== "") {
    // Show only files with the selected variant in artifacts
    filteredFileData = filteredFileData.filter(file => {
      const matchesArtifact = file.artifacts && file.artifacts.some(a => a.variant === variant);
      return matchesArtifact;
    });
  }
  // If variant is "" (All), show all files

  // sort into groups by collection (now directly from server data)
  const grouped_files = groupFilesByCollection(filteredFileData)

  // save the collections in closure variable, with __unfiled always first
  collections = Object.keys(grouped_files).sort((a, b) => {
    if (a === "__unfiled") return -1;
    if (b === "__unfiled") return 1;
    return a.localeCompare(b);
  });
  ui.toolbar.pdf.dataset.collections = JSON.stringify(collections)

  // Track if we've populated XML/diff dropdowns for the selected file
  // (to prevent duplicates when a file is in multiple collections)
  let hasPopulatedVersionsForSelectedFile = false;

  // get items to be selected from app state or use first element
  for (const collection_name of collections) {
    // Display "Unfiled" for the special __unfiled collection
    const displayName = getCollectionName(collection_name, state.collections);
    await createHtmlElements(`<small>${displayName}</small>`, ui.toolbar.pdf)

    // get a list of file data sorted by label
    const files = grouped_files[collection_name]
      .sort((a, b) => {
        const aLabel = a.source?.label || a.doc_metadata?.title || a.doc_id;
        const bLabel = b.source?.label || b.doc_metadata?.title || b.doc_id;
        return (aLabel < bLabel) ? -1 : (aLabel > bLabel) ? 1 : 0;
      })

    for (const file of files) {
      // Determine file identifier and label based on file type
      let fileIdentifier, displayLabel;

      if (file.source) {
        // Traditional PDF-XML workflow or XML-only with source
        fileIdentifier = file.source.id;
        displayLabel = file.source.label;
      } else if (file.artifacts && file.artifacts.length > 0) {
        // XML-only file without source - use first artifact as identifier
        fileIdentifier = file.artifacts[0].id;
        displayLabel = `📄 ${file.doc_metadata?.title || file.doc_id}`;
      } else {
        continue; // Skip files without identifiable content
      }

      // populate pdf/source select box
      const option = Object.assign(new SlOption, {
        value: fileIdentifier,
        textContent: displayLabel,
        size: "small",
      })

      // save scalar file properties in option
      option.dataset.doc_id = file.doc_id;
      option.dataset.collections = JSON.stringify(file.collections);

      ui.toolbar.pdf.hoist = true
      ui.toolbar.pdf.appendChild(option);

      // Check if this is the currently selected file (either by PDF hash or XML hash for XML-only files)
      const isSelectedFile = (fileIdentifier === state.pdf) ||
                             (file.source && file.source.file_type !== 'pdf' && fileIdentifier === state.xml);

      // Only populate XML/diff dropdowns once for the selected file (prevent duplicates when file is in multiple collections)
      if (isSelectedFile && !hasPopulatedVersionsForSelectedFile) {
        hasPopulatedVersionsForSelectedFile = true;

        // populate the version and diff selectboxes depending on the selected file
        if (file.artifacts) {
          // Filter artifacts based on variant selection
          let artifactsToShow = file.artifacts;
          if (variant === "none") {
            // Show only artifacts without variant
            artifactsToShow = file.artifacts.filter(artifact => !artifact.variant);
          } else if (variant && variant !== "") {
            // Show only artifacts with the selected variant
            artifactsToShow = file.artifacts.filter(artifact => artifact.variant === variant);
          }
          // If variant is "" (All), show all artifacts

          // Separate gold and versions
          const goldToShow = artifactsToShow.filter(a => a.is_gold_standard);
          const versionsToShow = artifactsToShow.filter(a => !a.is_gold_standard);

          // Add gold entries with visual grouping
          if (goldToShow.length > 0) {
            // Add "Gold" group headers for both selectboxes
            await createHtmlElements(`<small>Gold</small>`, ui.toolbar.xml);
            await createHtmlElements(`<small>Gold</small>`, ui.toolbar.diff);

            goldToShow.forEach((gold) => {
              // Show variant suffix when filter is "all" (empty string)
              const variantSuffix = (!variant || variant === "") ? gold.variant : undefined;
              // xml
              let option = new SlOption()
              // @ts-ignore
              option.size = "small"
              option.value = gold.id;  // Use stable ID
              option.innerHTML = createDocumentLabel(gold.label, gold.is_locked, variantSuffix);
              ui.toolbar.xml.appendChild(option);
              // diff
              option = new SlOption()
              // @ts-ignore
              option.size = "small"
              option.value = gold.id;  // Use stable ID
              option.innerHTML = createDocumentLabel(gold.label, gold.is_locked, variantSuffix);
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

            // Sort versions by version number in ascending order (earliest first)
            versionsToShow.sort((a, b) => (a.version || 0) - (b.version || 0));

            versionsToShow.forEach((version) => {
              // Show variant suffix when filter is "all" (empty string)
              const variantSuffix = (!variant || variant === "") ? version.variant : undefined;
              // xml
              let option = new SlOption()
              // @ts-ignore
              option.size = "small"
              option.value = version.id;  // Use stable ID
              option.innerHTML = createDocumentLabel(version.label, version.is_locked, variantSuffix);
              ui.toolbar.xml.appendChild(option);
              // diff
              option = new SlOption()
              // @ts-ignore
              option.size = "small"
              option.value = version.id;  // Use stable ID
              option.innerHTML = createDocumentLabel(version.label, version.is_locked, variantSuffix);
              ui.toolbar.diff.appendChild(option)
            });
          }
        }
      }
    }
    ui.toolbar.pdf.appendChild(new SlDivider);
  }
  } finally {
    isPopulatingSelectboxes = false;
    // Re-enable selectboxes after population is complete
    setSelectboxLoadingState(false);
  }
}

// Event handlers

/**
 * Called when the selection in the PDF/source file selectbox changes
 */
async function onChangePdfSelection() {
  let state = app.getCurrentState()

  if (!state.fileData) {
    throw new Error("fileData hasn't been loaded yet")
  }
  const selectedIdentifier = ui.toolbar.pdf.value;
  const selectedFile = state.fileData.find(file => {
    // Check if it matches source id (traditional workflow)
    if (file.source && file.source.id === selectedIdentifier) {
      return true;
    }
    // Check if it matches any artifact id (XML-only workflow)
    if (file.artifacts && file.artifacts.some(a => a.id === selectedIdentifier)) {
      return true;
    }
    return false;
  });

  if (!selectedFile) {
    return;
  }

  const collection = selectedFile.collections[0];
  let pdf = null;
  let xml = null;

  // Determine file type from source
  if (selectedFile.source && selectedFile.source.id === selectedIdentifier) {
    // Check if source is a PDF or an XML-only file (like RNG schema)
    if (selectedFile.source.file_type === 'pdf') {
      // Traditional PDF-XML workflow
      pdf = selectedIdentifier;
    } else {
      // XML-only file (RNG, standalone TEI, etc.) - source IS the XML
      xml = selectedIdentifier;
    }
  } else {
    // Selected identifier matches an artifact, not the source
    xml = selectedIdentifier;
  }

  // For PDF files, find the appropriate XML file
  if (pdf && selectedFile.artifacts) {
    const { variant } = state;
    let matchingGold;

    if (variant === "none") {
      // Find gold without variant
      matchingGold = selectedFile.artifacts.find(a => a.is_gold_standard && !a.variant);
    } else if (variant && variant !== "") {
      // Find gold with matching variant
      matchingGold = selectedFile.artifacts.find(a => a.is_gold_standard && a.variant === variant);
    } else {
      // No variant filter - use first gold file
      matchingGold = selectedFile.artifacts.find(a => a.is_gold_standard);
    }

    xml = matchingGold?.id;
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
      await services.removeMergeView()
      // For XML-only files, clear PDF state but keep collection and XML
      const stateUpdate = { collection };
      if (pdf) {
        stateUpdate.pdf = pdf;
      } else {
        stateUpdate.pdf = null; // Clear PDF for XML-only files
      }
      await app.updateState(stateUpdate)
      await services.load(filesToLoad)
    }
    catch (error) {
      logger.error(String(error))
      await app.updateState({ collection: null, pdf: null, xml: null })
      await reload({ refresh: true })
    }
  }
}


/**
 * Called when the selection in the XML/target selectbox changes
 */
async function onChangeXmlSelection() {
  const state = app.getCurrentState()
  if (!state.fileData) {
    throw new Error("fileData hasn't been loaded yet")
  }
  const xml = ui.toolbar.xml.value
  if (xml && typeof xml == "string" && xml !== state.xml) {
    try {
      // Find the collection for this XML file by searching fileData
      for (const file of state.fileData) {
        const hasArtifactMatch = file.artifacts && file.artifacts.some(artifact => artifact.id === xml);

        if (hasArtifactMatch) {
          await app.updateState({ collection: file.collections[0] });
          break;
        }
      }


      await services.removeMergeView()
      await services.load({ xml })
      await app.updateState({ xml })
    } catch (error) {
      console.error(String(error))
      await reload({ refresh: true })
      await app.updateState({ xml: null })
      dialog.error(String(error))
    }
  }
}

/**
 * Called when the selection in the diff version selectbox  changes
 */
async function onChangeDiffSelection() {
  const state = app.getCurrentState()
  const diff = String(ui.toolbar.diff.value)
  if (diff && typeof diff == "string" && diff !== ui.toolbar.xml.value) {
    try {
      await services.showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
  } else {
    await services.removeMergeView()
  }
  await app.updateState({ diff: diff })
}

/**
 * Called when the selection in the variant selectbox changes
 */
async function onChangeVariantSelection() {
  const variant = String(ui.toolbar.variant.value)
  await app.updateState({ variant, xml: null })
}

/**
 * Called when the selection in the collection filter selectbox changes
 */
async function onChangeCollectionSelection() {
  const state = app.getCurrentState()
  const collectionFilter = String(ui.toolbar.collection.value)

  // Set collection to the selected value, or null if "All" is selected
  const collection = collectionFilter || null

  // Check if current file is in the selected collection
  let shouldClearSelection = false
  if (collectionFilter && state.pdf && state.fileData) {
    const currentFile = state.fileData.find(file =>
      file.source && file.source.id === state.pdf
    )
    if (currentFile && !currentFile.collections.includes(collectionFilter)) {
      shouldClearSelection = true
    }
  }

  if (shouldClearSelection) {
    await services.removeMergeView()
    await app.updateState({ collectionFilter, collection, pdf: null, xml: null, diff: null })
  } else {
    await app.updateState({ collectionFilter, collection })
  }
}
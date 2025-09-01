/**
 * File selection drawer plugin - replacement for selectbox-based file selection
 * Uses a SlDrawer with SlTree for hierarchical file selection
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlSelect, SlTree, SlButton } from '../ui.js'
 */

/**
 * @typedef {object} fileDrawerTriggerPart
 */

/**
 * @typedef {object} fileDrawerPart  
 * @property {HTMLDivElement} drawerContent
 * @property {SlSelect} variantSelect
 * @property {SlTree} fileTree
 * @property {SlButton} closeDrawer
 */
import ui, { updateUi } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'
import { logger } from '../app.js'

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
  // Update variant selection and file tree based on state
  if (ui.fileDrawer?.variantSelect) {
    ui.fileDrawer.variantSelect.value = state.variant || "";
  }
  
  // TODO: Update file tree based on selected files in state
  console.log("File selection drawer state updated", {
    pdf: state.pdf,
    xml: state.xml,
    variant: state.variant
  });
}

/**
 * Handles variant selection changes
 * @param {ApplicationState} state
 */
function onVariantChange(state) {
  const variant = ui.fileDrawer?.variantSelect?.value;
  console.log("Variant selection changed:", variant);
  
  // TODO: Update file tree based on variant selection
  // TODO: Update application state with new variant
}

/**
 * Handles file tree selection changes
 * @param {Event} event
 * @param {ApplicationState} state
 */
function onFileTreeSelection(event, state) {
  // @ts-ignore
  logger.debug("File tree selection changed:", event.detail);
  
  // TODO: Handle file selection from tree
  // TODO: Load selected PDF/XML files
}
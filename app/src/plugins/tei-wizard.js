/**
 * This plugin provides a TEI Wizard to enhance the XML document.
 * It runs a series of modular enhancements defined in the /tei-wizard/enhancements/ directory.
 * TODO - this should be converted to a frontend extension of the backend TEI wizard plugin
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 * @import { SlButton } from '../ui.js'
 */

//
// UI Parts
//

/**
 * TEI Wizard dialog navigation properties
 * @typedef {object} teiWizardDialogPart
 * @property {HTMLDivElement} enhancementList - Container for enhancement checkboxes
 * @property {SlButton} selectAll - Select all checkboxes button
 * @property {SlButton} selectNone - Select none checkboxes button
 * @property {SlButton} executeBtn - Execute wizard button
 * @property {SlButton} cancel - Cancel button
 */
import ui from '../ui.js';
import { xmlEditor, logger, app } from '../app.js';
import { registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js';
import { getEnhancements } from '../modules/enhancement-registry.js';
import { notify } from '../modules/sl-utils.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'
import { config } from '../plugins.js';
import { encodeXmlEntities, escapeXml } from '../modules/tei-utils.js';


const plugin = {
  name: "tei-wizard",
  install,
  state: {update},
  deps: ['services']
}

export { plugin }
export default plugin

//
// UI
//

// Register templates
await registerTemplate('tei-wizard-button', 'tei-wizard-button.html');
await registerTemplate('tei-wizard-dialog', 'tei-wizard-dialog.html');

let teiWizardButton;

/**
 * @type {ApplicationState}
 */
let currentState;


/**
 * Load enhancements from the backend plugin system
 * @returns {Promise<void>}
 */
async function loadEnhancements() {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = '/api/plugins/tei-wizard/enhancements.js';
    script.onload = () => {
      logger.debug(`Loaded ${getEnhancements().length} TEI enhancements from backend`);
      resolve();
    };
    script.onerror = (err) => {
      logger.warn('Failed to load TEI enhancements from backend:', err);
      resolve(); // Don't fail installation if enhancements can't be loaded
    };
    document.head.appendChild(script);
  });
}

/**
 * Populate the enhancement list in the dialog
 */
function populateEnhancementList() {
  /** @type {teiWizardDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.teiWizardDialog);

  // Clear existing items
  dialog.enhancementList.innerHTML = '';

  const enhancements = getEnhancements();
  enhancements.forEach(enhancement => {
    // Escape XML entities for display text and attribute values to prevent HTML injection
    // Use encodeQuotes for attributes to prevent breaking out of the attribute value
    const escapedNameForAttr = escapeXml(enhancement.name, { encodeQuotes: true });
    const escapedNameForText = escapeXml(enhancement.name);
    const escapedDescription = escapeXml(enhancement.description, { encodeQuotes: true });
    // Browser decodes entities when reading dataset, so lookup works with original name
    const checkboxHtml = `
    <sl-tooltip content="${escapedDescription}" hoist placement="right">
      <sl-checkbox data-enhancement="${escapedNameForAttr}" size="medium">${escapedNameForText}</sl-checkbox>
    </sl-tooltip>
    <br />`;
    dialog.enhancementList.insertAdjacentHTML('beforeend', checkboxHtml);
  });
}

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Load enhancements from backend before setting up UI
  await loadEnhancements();

  // Create UI elements
  teiWizardButton = createSingleFromTemplate('tei-wizard-button');
  createSingleFromTemplate('tei-wizard-dialog', document.body);

  // Add TEI wizard button to XML editor toolbar (priority 51.5, between validateBtn at 51 and spacer at 50)
  ui.xmlEditor.toolbar.add(teiWizardButton, 51.5);
  updateUi()

  ui.xmlEditor.toolbar.teiWizardBtn.addEventListener("widget-click", runTeiWizard)

  /** @type {teiWizardDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.teiWizardDialog);

  // Populate enhancement list
  populateEnhancementList();

  // Select all and none buttons
  dialog.selectAll.addEventListener('click', () => {
    const checkboxes = dialog.enhancementList.querySelectorAll('sl-checkbox');
    checkboxes.forEach(checkbox => checkbox.checked = true);
  });
  dialog.selectNone.addEventListener('click', () => {
    const checkboxes = dialog.enhancementList.querySelectorAll('sl-checkbox');
    checkboxes.forEach(checkbox => checkbox.checked = false);
  });
}


/**
 * @param {ApplicationState} state 
 */
async function update(state) {
  currentState = state
  const isAnnotator = userHasRole(state.user, ["admin", "reviewer", "annotator"]);
  const isReviewer = userHasRole(state.user, ["admin", "reviewer"]);
  ui.xmlEditor.toolbar.teiWizardBtn.disabled = state.editorReadOnly || !isAnnotator || (isGoldFile(state.xml) && !isReviewer)
}

async function getSelectedEnhancements() {
  /** @type {teiWizardDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.teiWizardDialog);
  dialog.show();
  return new Promise((resolve) => {
    dialog.cancel.addEventListener('click', () => dialog.hide() && resolve([]));
    dialog.executeBtn.addEventListener('click', () => {
      const enhancements = getEnhancements();
      const enhancementFunctions = Array.from(dialog.enhancementList.querySelectorAll('sl-checkbox'))
        .filter(checkbox => checkbox.checked)
        .map(checkbox => enhancements.find(e => e.name === checkbox.dataset.enhancement));
      dialog.hide()
      resolve(enhancementFunctions);
    });
  });
}

async function runTeiWizard() {
  let teiDoc = xmlEditor.getXmlTree();
  if (!teiDoc) {
    console.error("TEI document not available.");
    return;
  }

  const selectedEnhancements = await getSelectedEnhancements();

  if (selectedEnhancements.length === 0) {
    console.log("No enhancements selected. Exiting TEI Wizard.");
    return;
  }
  console.log(`Running ${selectedEnhancements.length} TEI enhancement(s)...`);

  // Get config map for enhancements
  const configMap = config.toMap();

  // Sequentially apply each enhancement (supports both sync and async execute)
  for (const enhancement of selectedEnhancements) {
    try {
      console.log(`- Applying: ${enhancement.name}`);
      const result = enhancement.execute(teiDoc, currentState, configMap);
      if (result instanceof Promise) {
        ui.spinner.show(`Applying: ${enhancement.name}`);
        teiDoc = await result;
        ui.spinner.hide();
      } else {
        teiDoc = result;
      }
    } catch (error) {
      ui.spinner.hide();
      console.error(`Error during enhancement "${enhancement.name}":`, error);
      notify(`Enhancement "${enhancement.name}" failed: ${error.message}`, "danger");
      return;
    }
  }

  // Serialize the modified TEI document back to a string and remove xml namespace declarations outside the TEI root element
  //@ts-ignore
  let xmlstring = (new XMLSerializer()).serializeToString(teiDoc)
  xmlstring = xmlstring.replace(/(?<!<TEI[^>]*)\sxmlns=".+?"/, '');

  // Apply entity encoding if configured (respects xml.encode-quotes setting)
  if (await config.get('xml.encode-entities.client')) {
    const encodeQuotes = await config.get('xml.encode-quotes', false);
    xmlstring = encodeXmlEntities(xmlstring, { encodeQuotes });
  }

  // Display the result in the merge view
  xmlEditor.showMergeView(xmlstring);

  notify(`${selectedEnhancements.length} TEI enhancements applied successfully.`, "success");
}

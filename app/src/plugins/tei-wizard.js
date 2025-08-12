/**
 * This plugin provides a TEI Wizard to enhance the XML document.
 * It runs a series of modular enhancements defined in the /tei-wizard/enhancements/ directory.
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton } from '../ui.js'
 * @import { UIElement } from '../ui.js'
 */

//
// UI Components
//

/**
 * TEI Wizard dialog navigation properties
 * @typedef {object} teiWizardDialogComponent
 * @property {HTMLDivElement} enhancementList - Container for enhancement checkboxes
 * @property {SlButton} selectAll - Select all checkboxes button
 * @property {SlButton} selectNone - Select none checkboxes button
 * @property {SlButton} executeBtn - Execute wizard button
 * @property {SlButton} cancel - Cancel button
 */
import ui from '../ui.js';
import { xmlEditor, logger } from '../app.js';
import { createHtmlElements, updateUi } from '../ui.js';
import enhancements from './tei-wizard/enhancements.js';
import { notify } from '../modules/sl-utils.js'


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

const teiWizardButton = (await createHtmlElements("tei-wizard-button.html"))[0];

const teiWizardDialog = (await createHtmlElements("tei-wizard-dialog.html"))[0];


/**
 * @param {ApplicationState} state 
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // button
  ui.toolbar.teiActions.append(teiWizardButton)
  document.body.append(teiWizardDialog)
  updateUi()

  ui.toolbar.teiActions.teiWizard.addEventListener("click", runTeiWizard)

  /** @type {teiWizardDialogComponent & SlDialog} */
  const dialog = /** @type {any} */(ui.teiWizardDialog);

  // Populate enhancement list
  enhancements.forEach(async enhancement => {
    const checkboxHtml = `
    <sl-tooltip content="${enhancement.description}" hoist placement="right">
      <sl-checkbox data-enhancement="${enhancement.name}" size="medium">${enhancement.name}</sl-checkbox>
    </sl-tooltip>
    <br />`;
    await createHtmlElements(checkboxHtml, dialog.enhancementList);
  });

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
  // @ts-ignore
  teiWizardButton.disabled = state.editorReadOnly
  //console.warn(plugin.name,"done")
}

async function getSelectedEnhancements() {
  /** @type {teiWizardDialogComponent & SlDialog} */
  const dialog = /** @type {any} */(ui.teiWizardDialog);
  dialog.show();
  return new Promise((resolve) => {
    dialog.cancel.addEventListener('click', () => dialog.hide() && resolve([]));
    dialog.executeBtn.addEventListener('click', () => {
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

  // Sequentially apply each enhancement
  for (const enhancement of selectedEnhancements) {
    try {
      console.log(`- Applying: ${enhancement.name}`);
      teiDoc = enhancement.execute(teiDoc);
    } catch (error) {
      console.error(`Error during enhancement "${enhancement.name}":`, error);
      // Optionally, stop the process or notify the user
      return;
    }
  }

  // Serialize the modified TEI document back to a string and remove xml namespace declarations outside the TEI root element
  //@ts-ignore
  let xmlstring = (new XMLSerializer()).serializeToString(teiDoc)
  xmlstring = xmlstring.replace(/(?<!<TEI[^>]*)\sxmlns=".+?"/, '');

  // Display the result in the merge view
  xmlEditor.showMergeView(xmlstring);

  // enable diff navigation buttons
  ui.floatingPanel.diffNavigation
    .querySelectorAll("button")
    .forEach(node => node.disabled = false);

  notify(`${selectedEnhancements.length} TEI enhancements applied successfully.`, "success");
}

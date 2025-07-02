/**
 * This plugin provides a TEI Wizard to enhance the XML document.
 * It runs a series of modular enhancements defined in the /tei-wizard/enhancements/ directory.
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 */
import ui from '../ui.js';
import { xmlEditor } from '../app.js';
import { appendHtml } from '../ui.js';
import enhancements from './tei-wizard/enhancements.js';
import { notify } from '../modules/sl-utils.js'

const  buttonHtml = `
  <sl-tooltip content="Enhance TEI, i.e. add missing attributes">
    <sl-button name="teiWizard" size="small">
      <sl-icon name="magic"></sl-icon>
    </sl-button>
  </sl-tooltip> 
`
const dialogHtml = `
<sl-dialog name="teiWizardDialog" label="TEI Wizard" class="dialog-width" style="--width: 50vw;">
  <div name="enhancementList"></div>
  <sl-button slot="footer" name="selectAll">Select All</sl-button>
  <sl-button slot="footer" name="selectNone">Select None</sl-button>
  <sl-button slot="footer" name="cancel" variant="neutral">Cancel</sl-button>
  <sl-button slot="footer" name="executeBtn" variant="primary">Execute</sl-button>
</sl-dialog>
`;

const plugin = {
  name: "tei-wizard",
  install
}

export { plugin }
export default plugin

/**
 * @param {ApplicationState} state 
 */
async function install(state) {
  // button
  appendHtml(buttonHtml, ui.toolbar.teiActions.self);
  // @ts-ignore
  ui.toolbar.teiActions.teiWizard.addEventListener("click", runTeiWizard)

  // dialog
  appendHtml(dialogHtml);
  // @ts-ignore
  const dialog = ui.teiWizardDialog;  

  // Populate enhancement list
  enhancements.forEach(enhancement => {
    const checkboxHtml = `
    <sl-tooltip content="${enhancement.description}" hoist placement="right">
      <sl-checkbox data-enhancement="${enhancement.name}" 
        size="medium" checked>${enhancement.name}</sl-checkbox>
    </sl-tooltip>
    <br />`;
    appendHtml(checkboxHtml, dialog.enhancementList);
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


async function getSelectedEnhancements() {
  // @ts-ignore
  const dialog = ui.teiWizardDialog;
  dialog.self.show();
  return new Promise((resolve) => {  
    dialog.cancel.addEventListener('click', () => dialog.self.hide() && resolve([])); 
    dialog.executeBtn.addEventListener('click', () => {
      const enhancementFunctions = Array.from(dialog.enhancementList.querySelectorAll('sl-checkbox'))
        .filter(checkbox => checkbox.checked)
        .map(checkbox => enhancements.find(e => e.name === checkbox.dataset.enhancement));
      dialog.self.hide()
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
  ui.floatingPanel.diffNavigation.self
    .querySelectorAll("button")
    .forEach(node => node.disabled = false);

  notify(`${selectedEnhancements.length} TEI enhancements applied successfully.`, "success");
}

/**
 * This plugin allows moving files to a different collection.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton, SlSelect, SlOption, SlDialog } from '../ui.js'
 */
import { app, client, services, dialog, fileselection, updateState, logger } from '../app.js'
import { notify } from '../modules/sl-utils.js'
import { registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js'
import ui from '../ui.js'

const plugin = {
  name: "move-files",
  deps: ['services'],
  install,
  state: { update }
}

export { plugin }
export default plugin

// Current state for use in event handlers  
let currentState = null

//
// UI
//

const moveBtn = Object.assign(document.createElement('sl-button'), {
  innerHTML: `<sl-icon name="folder-symlink"></sl-icon>`,
  variant: 'default',
  size: 'small',
  name: 'moveFiles'
});

/**
 * @typedef {object} MoveFilesDialog
 * @property {SlSelect} collectionName
 * @property {SlButton} newCollectionBtn
 * @property {SlButton} cancel
 * @property {SlButton} submit
 */

// Register template
await registerTemplate('move-files-dialog', 'move-files-dialog.html');


//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create dialog and add button & dialog to UI
  const moveFilesDialog = createSingleFromTemplate('move-files-dialog', document.body);
  ui.toolbar.documentActions.append(moveBtn)
  updateUi() // Update UI so moveFilesDialog navigation is available

  // add event listener
  moveBtn.addEventListener('click', () => {
    if (currentState) showMoveFilesDialog(currentState);
  })
  ui.moveFilesDialog.newCollectionBtn.addEventListener('click', () => {
    const newCollectionName = prompt("Enter new collection name (Only letters, numbers, '-' and '_'):");
    if (newCollectionName) {
      if (!/^[a-zA-Z0-9_-]+$/.test(newCollectionName)) {
        dialog.error("Invalid collection name. Only lowercase letters, numbers, hyphens, and underscores are allowed.");
        return;
      }
      const option = Object.assign(document.createElement('sl-option'), {
        value: newCollectionName,
        textContent: newCollectionName.replaceAll("_", " ").trim()
      });
      ui.moveFilesDialog.collectionName.append(option);
      ui.moveFilesDialog.collectionName.value = newCollectionName;
    }
  });
}

/**
 * @param {ApplicationState} state
 */
async function showMoveFilesDialog(state) {
  const { xml, pdf } = state;
  if (!xml || !pdf) {
    dialog.error("Cannot move files, PDF or XML path is missing.");
    return;
  }

  const currentCollection = pdf.split('/')[3];

  const collectionSelectBox = ui.moveFilesDialog.collectionName;
  collectionSelectBox.innerHTML = "";
  const collections = JSON.parse(ui.toolbar.pdf.dataset.collections || '[]').filter(c => c !== currentCollection);
  for (const collection_name of collections) {
    const option = Object.assign(document.createElement('sl-option'), {
      value: collection_name,
      textContent: collection_name.replaceAll("_", " ").trim()
    });
    collectionSelectBox.append(option);
  }

  try {
    ui.moveFilesDialog.show();
    await new Promise((resolve, reject) => {
      ui.moveFilesDialog.submit.addEventListener('click', resolve, { once: true });
      ui.moveFilesDialog.cancel.addEventListener('click', reject, { once: true });
      ui.moveFilesDialog.addEventListener('sl-hide', e => e.preventDefault(), { once: true });
    });
  } catch (e) {
    logger.warn("User cancelled move files dialog");
    return;
  } finally {
    ui.moveFilesDialog.hide();
  }

  const destinationCollection = String(collectionSelectBox.value);
  if (!destinationCollection) {
    dialog.error("No collection selected.");
    return;
  }

  ui.spinner.show('Moving files, please wait...');
  try {
    state = app.getCurrentState()
    const { new_pdf_path, new_xml_path } = await client.moveFiles(pdf, xml, destinationCollection);
    await fileselection.reload();
    await services.load({ pdf: new_pdf_path, xml: new_xml_path });
    notify(`Files moved  to "${destinationCollection}"`);
  } catch (error) {
    dialog.error(`Error moving files: ${error.message}`);
  } finally {
    ui.spinner.hide();
  }
}

/**
 * State update handler
 * @param {ApplicationState} state
 */
async function update(state) {
  // Store current state for use in event handlers
  currentState = state;
}

/**
 * This plugin allows moving files to a different collection.
 */

/**
 * @import { ApplicationState } from '../app.js'
 * @import { SlButton, SlSelect, SlOption, SlDialog } from '../ui.js'
 */
import { client, services, dialog, fileselection, updateState, logger } from '../app.js'
import { createHtmlElements, updateUi } from '../ui.js'
import ui from '../ui.js'

const plugin = {
  name: "move-files",
  deps: ['services'],
  install
}

export { plugin }
export default plugin

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
 * @property {SlDialog} self
 * @property {SlSelect} collectionName
 * @property {SlButton} newCollectionBtn
 * @property {SlButton} cancel
 * @property {SlButton} submit
 */

/** @type {SlDialog & MoveFilesDialog} */
// @ts-ignore
const moveFilesDialog = (await createHtmlElements('move-files-dialog.html'))[0];


//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // install button & dialog
  ui.toolbar.documentActions.self.append(moveBtn)
  document.body.append(moveFilesDialog)
  updateUi()

  // add event listener
  moveBtn.addEventListener('click', () => showMoveFilesDialog(state))
  moveFilesDialog.newCollectionBtn.addEventListener('click', () => {
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
      moveFilesDialog.collectionName.append(option);
      moveFilesDialog.collectionName.value = newCollectionName;
    }
  });
}

/**
 * @param {ApplicationState} state
 */
async function showMoveFilesDialog(state) {
  const { xmlPath, pdfPath } = state;
  if (!xmlPath || !pdfPath) {
    dialog.error("Cannot move files, PDF or XML path is missing.");
    return;
  }

  const currentCollection = pdfPath.split('/')[3];

  const collectionSelectBox = moveFilesDialog.collectionName;
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
    moveFilesDialog.show();
    await new Promise((resolve, reject) => {
      moveFilesDialog.submit.addEventListener('click', resolve, { once: true });
      moveFilesDialog.cancel.addEventListener('click', reject, { once: true });
      moveFilesDialog.self.addEventListener('sl-hide', e => e.preventDefault(), { once: true });
    });
  } catch (e) {
    logger.warn("User cancelled move files dialog");
    return;
  } finally {
    moveFilesDialog.hide();
  }

  const destinationCollection = String(collectionSelectBox.value);
  if (!destinationCollection) {
    dialog.error("No collection selected.");
    return;
  }

  ui.spinner.show('Moving files, please wait...');
  try {
    const { new_pdf_path, new_xml_path } = await client.moveFiles(pdfPath, xmlPath, destinationCollection);
    await fileselection.reload(state);
    await services.load(state, { pdf: new_pdf_path, xml: new_xml_path });
    dialog.success("Files moved successfully.");
  } catch (error) {
    dialog.error(`Error moving files: ${error.message}`);
  } finally {
    ui.spinner.hide();
  }
}

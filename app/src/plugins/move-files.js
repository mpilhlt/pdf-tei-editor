/**
 * This plugin allows moving files to a different collection.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton, SlSelect, SlOption, SlDialog } from '../ui.js'
 */
import { app, client, services, dialog, fileselection, logger } from '../app.js'
import { notify } from '../modules/sl-utils.js'
import { registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js'
import ui from '../ui.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'

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
 * @property {import('../ui.js').SlCheckbox} copyMode
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
  ui.moveFilesDialog.newCollectionBtn.addEventListener('click', async () => {
    const newCollectionId = prompt("Enter new collection ID (Only letters, numbers, '-' and '_'):");
    if (newCollectionId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(newCollectionId)) {
        dialog.error("Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed.");
        return;
      }

      const newCollectionName = prompt("Enter collection display name (optional, leave blank to use ID):");

      try {
        const result = await client.createCollection(newCollectionId, newCollectionName || newCollectionId);
        if (result.success) {
          // Remove placeholder option if it exists
          const placeholderOption = ui.moveFilesDialog.collectionName.querySelector('sl-option[disabled]');
          if (placeholderOption) {
            placeholderOption.remove();
          }

          // Add new collection to select box
          const option = Object.assign(document.createElement('sl-option'), {
            value: newCollectionId,
            textContent: newCollectionName || newCollectionId
          });
          ui.moveFilesDialog.collectionName.append(option);
          ui.moveFilesDialog.collectionName.value = newCollectionId;
          notify(result.message);

          // Reload file data to update collections in state
          await fileselection.reload();
        }
      } catch (error) {
        dialog.error(`Error creating collection: ${String(error)}`);
      }
    }
  });

  // Update button label when copy mode changes
  ui.moveFilesDialog.copyMode.addEventListener('sl-change', () => {
    const isCopyMode = ui.moveFilesDialog.copyMode.checked;
    const submitLabel = ui.moveFilesDialog.querySelector('[name="submitLabel"]');
    if (submitLabel) {
      submitLabel.textContent = isCopyMode ? 'Copy' : 'Move';
    }
  });
}


/**
 * @param {ApplicationState} state
 */
async function showMoveFilesDialog(state) {
  const { xml, pdf, collections } = state;
  if (!xml || !pdf) {
    dialog.error("Cannot move/copy files, PDF or XML path is missing.");
    return;
  }

  // Reset copy mode checkbox and button label
  ui.moveFilesDialog.copyMode.checked = false;
  const submitLabel = ui.moveFilesDialog.querySelector('[name="submitLabel"]');
  if (submitLabel) {
    submitLabel.textContent = 'Move';
  }

  // Populate collections from state
  const collectionSelectBox = ui.moveFilesDialog.collectionName;
  collectionSelectBox.innerHTML = "";

  if (!collections || collections.length === 0) {
    // No collections available - show a message but allow creating new one
    const placeholderOption = Object.assign(document.createElement('sl-option'), {
      value: '',
      textContent: '(No collections available - click "New" to create one)',
      disabled: true
    });
    collectionSelectBox.append(placeholderOption);
    collectionSelectBox.value = '';
  } else {
    // Add all accessible collections
    for (const collection of collections) {
      const option = Object.assign(document.createElement('sl-option'), {
        value: collection.id,
        textContent: collection.name
      });
      collectionSelectBox.append(option);
    }
  }

  try {
    ui.moveFilesDialog.show();
    await new Promise((resolve, reject) => {
      ui.moveFilesDialog.submit.addEventListener('click', resolve, { once: true });
      ui.moveFilesDialog.cancel.addEventListener('click', reject, { once: true });
      ui.moveFilesDialog.addEventListener('sl-hide', e => e.preventDefault(), { once: true });
    });
  } catch (e) {
    logger.warn("User cancelled move/copy files dialog");
    return;
  } finally {
    ui.moveFilesDialog.hide();
  }

  const destinationCollection = String(collectionSelectBox.value);
  if (!destinationCollection) {
    dialog.error("No collection selected. Please select a collection or create a new one.");
    return;
  }

  const isCopyMode = ui.moveFilesDialog.copyMode.checked;
  const operationName = isCopyMode ? 'Copying' : 'Moving';

  ui.spinner.show(`${operationName} files, please wait...`);
  try {
    state = app.getCurrentState()
    let result;
    if (isCopyMode) {
      result = await client.copyFiles(pdf, xml, destinationCollection);
    } else {
      result = await client.moveFiles(pdf, xml, destinationCollection);
    }

    // Reload file data to reflect changes
    await fileselection.reload();

    // Load the files at their new/copied location (IDs remain the same)
    await services.load({ pdf: result.new_pdf_id, xml: result.new_xml_id });

    // Get collection name for notification
    const destCollection = collections.find(c => c.id === destinationCollection);
    const collectionName = destCollection ? destCollection.name : destinationCollection;

    notify(`Files ${isCopyMode ? 'copied' : 'moved'} to "${collectionName}"`);
  } catch (error) {
    dialog.error(`Error ${isCopyMode ? 'copying' : 'moving'} files: ${String(error)}`);
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
  const isReviewer = userHasRole(currentState.user, ["admin", "reviewer"])
  moveBtn.disabled = !state.xml || !isReviewer
}

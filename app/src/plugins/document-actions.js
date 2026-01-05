/**
 * Document Actions Plugin - Handles document operations (save, version, delete)
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 * @import { SlButton, SlInput, SlDialog, SlCheckbox, SlSelect } from '../ui.js'
 * @import { RespStmt, RevisionChange, Edition} from '../modules/tei-utils.js'
 */

import { app } from '../app.js'
import ui, { updateUi } from '../ui.js'
import {
  client, logger, dialog, authentication,
  xmlEditor, sync, accessControl, testLog, fileselection
} from '../app.js'
import FiledataPlugin from './filedata.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../ui.js'
import { notify } from '../modules/sl-utils.js'
import * as tei_utils from '../modules/tei-utils.js'
import { prettyPrintXmlDom } from './tei-wizard/enhancements/pretty-print-xml.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'

/**
 * plugin API
 */
const api = {
  saveRevision,
  createNewVersion,
  deleteCurrentVersion,
  deleteAllVersions,
  deleteAll,
  addTeiHeaderInfo,
  editFileMetadata
}

/**
 * component plugin
 * @type {PluginConfig}
 */
const plugin = {
  name: "document-actions",
  deps: ['file-selection', 'authentication', 'access-control'],
  install,
  onStateUpdate
}

export { plugin, api }
export default plugin

// Current state for use in event handlers
/** @type {ApplicationState|null} */
let currentState = null

//
// UI Typedefs
//

/**
 * Document actions button group navigation properties
 * @typedef {object} documentActionsPart
 * @property {SlButton} saveRevision - Save current revision button
 * @property {SlButton} createNewVersion - Create new version button
 * @property {SlButton} deleteBtn - Delete dropdown button
 * @property {SlButton} deleteCurrentVersion - Delete current version button
 * @property {SlButton} deleteAllVersions - Delete all versions button
 * @property {SlButton} deleteAll - Delete all files button
 * @property {SlButton} editMetadata - Edit file metadata button
 */

/**
 * Dialog for creating a new version
 * @typedef {object} newVersionDialogPart
 * @property {SlInput} versionName
 * @property {SlInput} persName
 * @property {SlInput} persId
 * @property {SlInput} editionNote
 * @property {SlButton} submit
 * @property {SlButton} cancel
 */

/**
 * Dialog for documenting a revision navigation properties
 * @typedef {object} newRevisionChangeDialogPart
 * @property {SlInput} persId - Person ID input
 * @property {SlInput} persName - Person name input
 * @property {SlInput} changeDesc - Change description input
 * @property {SlSelect} status - Status select
 * @property {SlCheckbox} saveAsGold - Save as gold version checkbox
 * @property {SlButton} submit - Submit button
 * @property {SlButton} cancel - Cancel button
 */

/**
 * Dialog for editing file metadata
 * @typedef {object} editMetadataDialogPart
 * @property {SlInput} docTitle - Document title input (readonly)
 * @property {SlInput} label - Extraction label input
 * @property {SlInput} source - Source input
 * @property {SlButton} submit - Submit button
 * @property {SlButton} cancel - Cancel button
 */

// Register templates
await registerTemplate('document-action-buttons', 'document-action-buttons.html');
await registerTemplate('new-version-dialog', 'new-version-dialog.html');
await registerTemplate('save-revision-dialog', 'save-revision-dialog.html');
await registerTemplate('edit-metadata-dialog', 'edit-metadata-dialog.html');

//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create UI elements
  const documentActionButtons = createFromTemplate('document-action-buttons');
  createSingleFromTemplate('new-version-dialog', document.body);
  createSingleFromTemplate('save-revision-dialog', document.body);
  createSingleFromTemplate('edit-metadata-dialog', document.body);

  // Add document action buttons to toolbar with medium priority
  documentActionButtons.forEach(buttonGroup => {
    if (buttonGroup instanceof HTMLElement) {
      ui.toolbar.add(buttonGroup, 8);
    }
  });
  updateUi() // Update UI so navigation objects are available

  const da = ui.toolbar.documentActions

  // save a revision
  da.saveRevision.addEventListener('click', () => {
    if (currentState) saveRevision(currentState);
  });

  // delete
  da.deleteCurrentVersion.addEventListener("click", () => {
    if (currentState) deleteCurrentVersion(currentState);
  })
  da.deleteAllVersions.addEventListener('click', () => {
    if (currentState) deleteAllVersions(currentState);
  })
  da.deleteAll.addEventListener('click', () => {
    if (currentState) deleteAll(currentState);
  })

  // new version
  da.createNewVersion.addEventListener("click", () => {
    if (currentState) createNewVersion(currentState);
  })

  // edit metadata
  da.editMetadata.addEventListener("click", () => {
    if (currentState) editFileMetadata(currentState);
  })
}

/**
 * @param {(keyof ApplicationState)[]} changedKeys
 * @param {ApplicationState} state
 */
async function onStateUpdate(changedKeys, state) {
  // Store current state for use in event handlers
  currentState = state;

  const da = ui.toolbar.documentActions

  da.childNodes.forEach(el => {
    if (el instanceof HTMLElement && 'disabled' in el) {
      // @ts-ignore
      el.disabled = state.offline
    }
  })
  if (state.offline) {
    return
  }

  const isReviewer = userHasRole(currentState.user, ["admin", "reviewer"])
  const isAnnotator = userHasRole(currentState.user, ["admin", "reviewer", "annotator"])

  // disable/enable delete buttons
  if (isAnnotator || isReviewer) {
    da.deleteAll.disabled = !Boolean(state.pdf && state.xml) || !isReviewer // Disable if no pdf and no xml)
    da.deleteAllVersions.disabled = !isReviewer || ui.toolbar.xml.querySelectorAll("sl-option").length  < 2 // disable if only one document left (gold version)
    da.deleteCurrentVersion.disabled = !state.xml || state.editorReadOnly || (isGoldFile(currentState.xml) && !isReviewer)
  } else {
    for (let btn of [da.deleteAll, da.deleteAllVersions, da.deleteCurrentVersion]) {
      btn.disabled = true
    }
  }

  da.deleteBtn.disabled =
    da.deleteCurrentVersion.disabled &&
    da.deleteAllVersions.disabled &&
    da.deleteAll.disabled

  // Allow new version or revisions only if we have an xml path
  if (isAnnotator) {
    da.saveRevision.disabled =  !Boolean(state.xml) || state.editorReadOnly
    da.createNewVersion.disabled = !Boolean(state.xml)
  } else {
    for (let btn of [da.saveRevision, da.createNewVersion]) {
      btn.disabled = true
    }
  }

  // Edit metadata - allow for annotators and reviewers when XML is loaded
  if (isAnnotator || isReviewer) {
    da.editMetadata.disabled = !Boolean(state.xml) || state.editorReadOnly
  } else {
    da.editMetadata.disabled = true
  }
}

/**
 * Deletes the current version of the document
 * This will remove the XML file from the server and reload the gold version
 * @param {ApplicationState} state
 */
async function deleteCurrentVersion(state) {
  // Handle both PDF-XML files and XML-only files
  let xmlValue = ui.toolbar.xml.value;
  let selectedOption = ui.toolbar.xml.selectedOptions[0];

  // For XML-only files, the XML might be selected in the PDF dropdown instead
  if (!xmlValue && state.xml && !state.pdf) {
    xmlValue = state.xml;
    // Find the option in the PDF dropdown that corresponds to this XML file
    selectedOption = ui.toolbar.pdf.selectedOptions[0];
  }

  if (!xmlValue) {
    dialog.error("No file selected for deletion")
    return
  }

  // Use helper function to check if this is a gold file
  // XML-only files (where state.pdf is null) can always be deleted
  if (state.pdf && typeof xmlValue === 'string') {

    // Only check for gold status if this is a PDF-XML file
    const fileData = getFileDataById(xmlValue);
    if (fileData && fileData.type === 'gold' && !userHasRole(state.user, ['admin', 'reviewer'])) {
      dialog.error("You cannot delete the gold version")
    }
  }

  const filePathsToDelete = [xmlValue]
  if (filePathsToDelete.length > 0) {
    const versionName = selectedOption ? selectedOption.textContent : 'current version';
    const msg = `Are you sure you want to delete the current version "${versionName}"?`
    if (!confirm(msg)) return; // todo use dialog

    const { services } = await import('../app.js')
    services.removeMergeView()
    // delete the file
    await client.deleteFiles(/** @type {string[]} */ (filePathsToDelete))
    try {
      // Clear current XML state after successful deletion
      await app.updateState({ xml: null })
      // update the file data
      await fileselection.reload()
      // load the gold version
      // @ts-ignore
      const xml = ui.toolbar.xml.firstChild?.value
      await services.load({ xml })
      notify(`Version "${versionName}" has been deleted.`)
      sync.syncFiles(state)
        .then(summary => summary && console.debug(summary))
        .catch(e => console.error(e))
    } catch (error) {
      console.error(error)
      const errorMessage = String(error);
      dialog.error(errorMessage)
    }
  }
}

/**
 * Deletes all versions of the document, leaving only the gold standard version
 * Only deletes versions that match the current variant filter
 */
async function deleteAllVersions() {
  if (!currentState?.fileData) {
    throw new Error("No file data");
  }
  // Get the current source to find all its versions
  const currentSource = ui.toolbar.pdf.value;
  const selectedFile = currentState.fileData.find(file => file.source?.id === currentSource);

  if (!selectedFile || !selectedFile.artifacts) {
    return; // No artifacts to delete
  }

  // Filter artifacts to get only versions (non-gold) based on current variant selection
  let artifactsToDelete = selectedFile.artifacts.filter(/** @param {any} a */ a => !a.is_gold_standard);
  const { variant } = currentState;

  if (variant === "none") {
    // Delete only versions without variant
    artifactsToDelete = artifactsToDelete.filter(/** @param {any} artifact */ artifact => !artifact.variant);
  } else if (variant && variant !== "") {
    // Delete only versions with the selected variant
    artifactsToDelete = artifactsToDelete.filter(/** @param {any} artifact */ artifact => artifact.variant === variant);
  }
  // If variant is "" (All), delete all versions

  const filePathsToDelete = artifactsToDelete.map(/** @param {any} artifact */ artifact => artifact.id);

  if (filePathsToDelete.length > 0) {
    const variantText = variant === "none" ? "without variant" :
                      variant && variant !== "" ? `with variant "${variant}"` : "";
    const msg = `Are you sure you want to delete ${filePathsToDelete.length} version(s) ${variantText}? This cannot be undone.`
    if (!confirm(msg)) return; // todo use dialog
  } else {
    // No versions match the current variant filter
    const variantText = variant === "none" ? "without variant" : `with variant "${variant}"`;
    notify(`No versions ${variantText} found to delete.`);
    return;
  }

  const { services } = await import('../app.js')
  services.removeMergeView()
  // delete
  await client.deleteFiles(filePathsToDelete)
  try {
    // Clear current XML state after successful deletion
    await app.updateState({ xml: null })
    // update the file data
    await fileselection.reload()

    // Find and load the appropriate gold version for the current variant
    let goldToLoad = null;
    if (selectedFile.artifacts) {
      const goldArtifacts = selectedFile.artifacts.filter(/** @param {any} a */ a => a.is_gold_standard);
      if (variant === "none") {
        // Load gold version without variant
        goldToLoad = goldArtifacts.find(/** @param {any} gold */ gold => !gold.variant);
      } else if (variant && variant !== "") {
        // Load gold version with matching variant
        goldToLoad = goldArtifacts.find(/** @param {any} gold */ gold => gold.variant === variant);
      } else {
        // Load first available gold version
        goldToLoad = goldArtifacts[0];
      }
    }

    if (goldToLoad) {
      await services.load({ xml: goldToLoad.id });
    }

    const variantText = variant === "none" ? "without variant" :
                      variant && variant !== "" ? `with variant "${variant}"` : "";
    notify(`All versions ${variantText} have been deleted`)
    sync.syncFiles(currentState)
      .then(summary => summary && console.debug(summary))
      .catch(e => console.error(e))
  } catch (error) {
    console.error(error)
    const errorMessage = String(error);
    dialog.error(errorMessage)
  }
}

/**
 * Deletes all versions of the document and the PDF file
 * @param {ApplicationState} state
 */
async function deleteAll(state) {

  if (ui.toolbar.pdf.childElementCount < 2) {
    throw new Error("Cannot delete all files, at least one PDF must be present")
  }

  // @ts-ignore
  const filePathsToDelete = Array.from(new Set([ui.toolbar.pdf.value]
    // @ts-ignore
    .concat(Array.from(ui.toolbar.xml.childNodes).map(option => option.value))
    // @ts-ignore
    .concat(Array.from(ui.toolbar.diff.childNodes).map(option => option.value))))
    .filter(Boolean)

  if (filePathsToDelete.length > 0) {
    const msg = `Are you sure you want to delete ${filePathsToDelete.length} files? This cannot be undone.`
    if (!confirm(msg)) return; // todo use dialog
  }

  const { services } = await import('../app.js')
  services.removeMergeView()
  logger.debug("Deleting files:" + filePathsToDelete.join(", "))

  try {
    await client.deleteFiles(/** @type {string[]} */ (filePathsToDelete))
    notify(`${filePathsToDelete.length} files have been deleted.`)
    sync.syncFiles(state)
      .then(summary => summary && console.debug(summary))
      .catch(e => console.error(e))
  } catch (error) {
    const errorMessage = String(error);
    console.error(errorMessage)
    notify(errorMessage, "warning")
  } finally {
    // update the file data
    await fileselection.reload({refresh:true})
    // remove xml and pdf
    await app.updateState({xml: null, pdf: null})
  }
}

/**
 * Called when the "saveRevision" button is executed
 * @param {ApplicationState} state
 */
async function saveRevision(state) {

  // @ts-ignore
  const revDlg = ui.newRevisionChangeDialog;
  revDlg.changeDesc.value = "Corrections"

  try {
    const user = authentication.getUser()
    if (user) {
      const userData = /** @type {any} */ (user);
      revDlg.persId.disabled = revDlg.persName.disabled = true
      revDlg.persId.value = userData.username
      revDlg.persName.value = userData.fullname

      // Pre-fill status from current TEI document
      const xmlDoc = xmlEditor.getXmlTree()
      if (xmlDoc) {
        const lastChange = xmlDoc.querySelector('revisionDesc change:last-of-type')
        if (lastChange) {
          const currentStatus = lastChange.getAttribute('status') || 'draft'
          revDlg.status.value = currentStatus
        } else {
          revDlg.status.value = 'draft'
        }
      }

      // Disable restricted status options based on user role
      const isReviewer = userHasRole(userData, ["admin", "reviewer"])
      const restrictedOptions = ['approved', 'candidate', 'published']
      Array.from(revDlg.status.querySelectorAll('sl-option')).forEach(option => {
        if (!isReviewer && restrictedOptions.includes(option.value)) {
          option.disabled = true
        }
      })

      // Show/hide gold version checkbox based on user role
      revDlg.saveAsGold.style.display = isReviewer ? 'block' : 'none'
      revDlg.saveAsGold.checked = false
    }
    revDlg.show()
    await new Promise((resolve, reject) => {
      revDlg.submit.addEventListener('click', resolve, { once: true })
      revDlg.cancel.addEventListener('click', reject, { once: true })
      // Only reject on dialog hide, not on nested component events
      const handleHide = (e) => {
        // Check if the hide event is from the dialog itself, not a child component
        if (e.target === revDlg) {
          reject()
        }
      }
      revDlg.addEventListener('sl-hide', handleHide, { once: true })
    })
  } catch (e) {
    console.warn("User cancelled")
    return
  } finally {
    revDlg.hide()
  }

  revDlg.hide()

  /** @type {RespStmt} */
  const respStmt = {
    persId: revDlg.persId.value,
    persName: revDlg.persName.value,
    resp: "Annotator"
  }

  /** @type {RevisionChange} */
  const revisionChange = {
    status: revDlg.status.value,
    persId: revDlg.persId.value,
    desc: revDlg.changeDesc.value
  }

  const saveAsGold = revDlg.saveAsGold.checked

  ui.toolbar.documentActions.saveRevision.disabled = true
  try {
    await addTeiHeaderInfo(respStmt, undefined, revisionChange)
    if (!state.xml) throw new Error('No XML file loaded')

    // Mark editor as clean to prevent autosave from triggering
    // (addTeiHeaderInfo updates the editor, which triggers editorUpdateDelayed and autosave)
    xmlEditor.markAsClean()

    const filedata = FiledataPlugin.getInstance()
    await filedata.saveXml(state.xml)

    testLog('REVISION_SAVED', {
      changeDescription: revDlg.changeDesc.value,
      status: revDlg.status.value
    });

    // Verify revision was added to XML content (self-contained for bundle removal)
    testLog('REVISION_IN_XML_VERIFIED', {
      changeDescription: revDlg.changeDesc.value,
      xmlContainsRevision: xmlEditor.getXML().includes(revDlg.changeDesc.value)
    });

    // Set as gold standard if checkbox was checked
    if (saveAsGold) {
      try {
        await client.apiClient.filesGoldStandard(state.xml)
        testLog('GOLD_STANDARD_SET', { fileId: state.xml })
        // Reload file data to update UI with new gold status
        await fileselection.reload({ refresh: true })
        notify("Revision saved and marked as Gold version")
      } catch (goldError) {
        console.error("Failed to set gold standard:", goldError)
        notify("Revision saved, but failed to set as Gold version", "warning")
      }
    } else {
      notify("Revision saved successfully")
    }

    sync.syncFiles(state)
      .then(summary => summary && console.debug(summary))
      .catch(e => console.error(e))

    // dirty state
    xmlEditor.markAsClean()
  } catch (error) {
    console.error(error)
    dialog.error(String(error))
  } finally {
    ui.toolbar.documentActions.saveRevision.disabled = false
  }
}

/**
 * Called when the "Create new version" button is executed
 * @param {ApplicationState} state
 */
async function createNewVersion(state) {

  // @ts-ignore
  const newVersiondialog = ui.newVersionDialog;
  try {
    const userData = authentication.getUser()
    if (userData) {
      newVersiondialog.persId.value =  userData.username
      newVersiondialog.persName.value = userData.fullname
    }
    newVersiondialog.show()
    await new Promise((resolve, reject) => {
      newVersiondialog.submit.addEventListener('click', resolve, { once: true })
      newVersiondialog.cancel.addEventListener('click', reject, { once: true })
      // Only reject on dialog hide, not on nested component events
      const handleHide = (e) => {
        if (e.target === newVersiondialog) {
          reject()
        }
      }
      newVersiondialog.addEventListener('sl-hide', handleHide, { once: true })
    })
  } catch (e) {
    console.warn("User cancelled")
    return
  } finally {
    newVersiondialog.hide()
  }

  /** @type {RespStmt} */
  const respStmt = {
    persId: newVersiondialog.persId.value,
    persName: newVersiondialog.persName.value,
    resp: "Annotator"
  }

  /** @type {Edition} */
  const editionStmt = {
    title: newVersiondialog.versionName.value,
    note: newVersiondialog.editionNote.value
  }

  ui.toolbar.documentActions.saveRevision.disabled = true
  try {
    if (!state.xml) throw new Error('No XML file loaded');

    // Keep reference to current file (used to determine doc_id for the new version)
    const currentFileId = state.xml

    // Modify the header FIRST, before saving as new version
    // This ensures the new version has unique content (won't conflict with existing content hash)
    await addTeiHeaderInfo(respStmt, editionStmt)

    // Mark editor as clean to prevent autosave from triggering
    // (addTeiHeaderInfo updates the editor, which triggers editorUpdateDelayed and autosave)
    // We want to explicitly control the save with new_version=true below
    xmlEditor.markAsClean()

    // Save as new version with the modified content
    // The backend will:
    // 1. Resolve doc_id from currentFileId (the source file)
    // 2. Create a new version file with incremented version number
    // 3. Return the new file's stable_id
    const filedata = FiledataPlugin.getInstance()
    let { file_id: newFileId } = await filedata.saveXml(currentFileId, /* save as new version */ true)

    testLog('NEW_VERSION_CREATED', { oldFileId: currentFileId, newFileId });

    // Mark as clean since we just saved
    xmlEditor.markAsClean()

    // Reload the file data first to include the new version
    await fileselection.reload({refresh:true})

    // Then update state to reflect the new file_id
    // (editor already has the correct content from addTeiHeaderInfo)
    // This will trigger file-selection update with the refreshed fileData
    await app.updateState({ xml: newFileId })

    notify("Document was duplicated. You are now editing the copy.")

    // sync the new file to the WebDav server
    if (state.webdavEnabled) {
      sync.syncFiles(state)
      .then(/** @param {any} summary */ summary => {
        if (summary) {
          logger.debug(summary);
        }
      })
      .catch(e => console.error(e))
    }
  } catch (e) {
    console.error(e)
    const errorMessage = e instanceof Error ? e.message : String(e);
    dialog.error(errorMessage)
  } finally {
    ui.toolbar.documentActions.saveRevision.disabled = false
    newVersiondialog.hide()
  }
}

/**
 * Add information on responsibitiy, edition or revisions to the document
 * @param {RespStmt} [respStmt] - Optional responsible statement details.
 * @param {Edition} [edition] - Optional edition statement details.
 * @param {RevisionChange} [revisionChange] - Optional revision statement details.
 * @throws {Error} If any of the operations to add teiHeader info fail
 */
async function addTeiHeaderInfo(respStmt, edition, revisionChange) {

  const xmlDoc = xmlEditor.getXmlTree()
  if (!xmlDoc) {
    throw new Error("No XML document loaded")
  }

  // update document: <respStmt>
  if (respStmt) {
    if (!respStmt || tei_utils.getRespStmtById(xmlDoc, respStmt.persId)) {
      console.warn("No persId or respStmt already exists for this persId")
    } else {
      tei_utils.addRespStmt(xmlDoc, respStmt)
    }
  }

  // update document: <edition>
  if (edition && currentState?.fileData) {
    const versionName = edition.title
    const editionTitleElements = xmlDoc.querySelectorAll('edition > title')
    const nameExistsInDoc = Array.from(editionTitleElements).some(elem => elem.textContent === versionName)
    const nameExistsInVersions = currentState.fileData.some(file => file.label === versionName)
    if (nameExistsInDoc || nameExistsInVersions) {
      throw new Error(`The version name "${versionName}" is already being used, pick another one.`)
    }
    tei_utils.addEdition(xmlDoc, edition)
  }
  if (revisionChange) {
    tei_utils.addRevisionChange(xmlDoc, revisionChange)
  }
  prettyPrintXmlDom(xmlDoc, 'teiHeader')
  await xmlEditor.updateEditorFromXmlTree()
}

/**
 * Edit file metadata (label from edition title, source from bibl)
 * @param {ApplicationState} state
 */
async function editFileMetadata(state) {
  if (!state.xml) {
    dialog.error("No file loaded")
    return
  }

  // @ts-ignore
  const metadataDlg = ui.editMetadataDialog;

  // Get current XML document to read TEI header
  const xmlDoc = xmlEditor.getXmlTree()
  if (!xmlDoc) {
    dialog.error("No XML document loaded")
    return
  }

  // Extract current values from TEI header
  const titleEl = xmlDoc.querySelector('teiHeader fileDesc titleStmt title')
  const editionTitleEl = xmlDoc.querySelector('teiHeader fileDesc editionStmt edition title')
  const biblEl = xmlDoc.querySelector('teiHeader fileDesc sourceDesc bibl')

  // Pre-fill form with current values from TEI header
  metadataDlg.docTitle.value = titleEl?.textContent || ""
  metadataDlg.label.value = editionTitleEl?.textContent || ""
  metadataDlg.source.value = biblEl?.textContent || ""

  try {
    metadataDlg.show()
    await new Promise((resolve, reject) => {
      metadataDlg.submit.addEventListener('click', resolve, { once: true })
      metadataDlg.cancel.addEventListener('click', reject, { once: true })
      // Only reject on dialog hide, not on nested component events
      const handleHide = (e) => {
        if (e.target === metadataDlg) {
          reject()
        }
      }
      metadataDlg.addEventListener('sl-hide', handleHide, { once: true })
    })
  } catch (e) {
    console.warn("User cancelled")
    return
  } finally {
    metadataDlg.hide()
  }

  // Gather updated values
  const updatedLabel = metadataDlg.label.value.trim()
  const updatedSource = metadataDlg.source.value.trim()

  ui.toolbar.documentActions.editMetadata.disabled = true
  try {
    // Update label in TEI header (editionStmt/edition/title)
    if (updatedLabel !== (editionTitleEl?.textContent || "")) {
      if (editionTitleEl) {
        editionTitleEl.textContent = updatedLabel
      } else {
        // Create the structure if it doesn't exist
        let editionStmt = xmlDoc.querySelector('teiHeader fileDesc editionStmt')
        if (!editionStmt) {
          const fileDesc = xmlDoc.querySelector('teiHeader fileDesc')
          if (fileDesc) {
            editionStmt = xmlDoc.createElement('editionStmt')
            // Insert after titleStmt
            const titleStmt = xmlDoc.querySelector('teiHeader fileDesc titleStmt')
            if (titleStmt && titleStmt.nextSibling) {
              fileDesc.insertBefore(editionStmt, titleStmt.nextSibling)
            } else {
              fileDesc.appendChild(editionStmt)
            }
          }
        }
        if (editionStmt) {
          let edition = editionStmt.querySelector('edition')
          if (!edition) {
            edition = xmlDoc.createElement('edition')
            editionStmt.appendChild(edition)
          }
          const newTitle = xmlDoc.createElement('title')
          newTitle.textContent = updatedLabel
          edition.appendChild(newTitle)
        }
      }
    }

    // Update source in TEI header (sourceDesc/bibl)
    if (updatedSource !== (biblEl?.textContent || "")) {
      if (biblEl) {
        biblEl.textContent = updatedSource
      } else {
        // Create the structure if it doesn't exist
        let sourceDesc = xmlDoc.querySelector('teiHeader fileDesc sourceDesc')
        if (!sourceDesc) {
          const fileDesc = xmlDoc.querySelector('teiHeader fileDesc')
          if (fileDesc) {
            sourceDesc = xmlDoc.createElement('sourceDesc')
            fileDesc.appendChild(sourceDesc)
          }
        }
        if (sourceDesc) {
          const newBibl = xmlDoc.createElement('bibl')
          newBibl.textContent = updatedSource
          sourceDesc.appendChild(newBibl)
        }
      }
    }

    prettyPrintXmlDom(xmlDoc, 'teiHeader')
    await xmlEditor.updateEditorFromXmlTree()

    // Mark editor as clean to prevent autosave from triggering
    xmlEditor.markAsClean()

    // Save the updated XML - the backend will automatically extract and save the label
    // from editionStmt/edition/title when processing the save
    const filedata = FiledataPlugin.getInstance()
    await filedata.saveXml(state.xml)

    // Reload file data to reflect changes (label will be updated automatically by backend)
    await fileselection.reload({refresh: true})

    notify("File metadata updated successfully")

    sync.syncFiles(state)
      .then(summary => summary && console.debug(summary))
      .catch(e => console.error(e))

    xmlEditor.markAsClean()
  } catch (error) {
    console.error(error)
    dialog.error(String(error))
  } finally {
    ui.toolbar.documentActions.editMetadata.disabled = false
  }
}

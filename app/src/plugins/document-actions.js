/**
 * Document Actions Plugin - Handles document operations (save, version, delete)
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 * @import { SlButton, SlInput, SlDialog } from '../ui.js'
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
 * @property {SlButton} submit - Submit button
 * @property {SlButton} cancel - Cancel button
 */

/**
 * Dialog for editing file metadata
 * @typedef {object} editMetadataDialogPart
 * @property {SlInput} fileref - File reference (filename) input
 * @property {SlInput} title - Document title input
 * @property {SlInput} doi - DOI input
 * @property {SlInput} variant - Variant input
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
 * Given a user object, get an id (typically by using the initials)
 * @param {any} userData
 */
function getIdFromUser(userData) {
  let names = userData.fullname
  if (names && names.trim() !== "") {
    names = userData.fullname.split(" ")
  } else {
    return userData.username
  }
  if (names.length > 1) {
    return names.map(/** @param {any} n */ n => n[0]).join("").toLocaleLowerCase()
  }
  return names[0].slice(0, 3)
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
    }
    revDlg.show()
    await new Promise((resolve, reject) => {
      revDlg.submit.addEventListener('click', resolve, { once: true })
      revDlg.cancel.addEventListener('click', reject, { once: true })
      revDlg.addEventListener('sl-hide', reject, { once: true })
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
    status: "draft",
    persId: revDlg.persId.value,
    desc: revDlg.changeDesc.value
  }
  ui.toolbar.documentActions.saveRevision.disabled = true
  try {
    await addTeiHeaderInfo(respStmt, undefined, revisionChange)
    if (!state.xml) throw new Error('No XML file loaded')

    // Mark editor as clean to prevent autosave from triggering
    // (addTeiHeaderInfo updates the editor, which triggers editorUpdateDelayed and autosave)
    xmlEditor.markAsClean()

    const filedata = FiledataPlugin.getInstance()
    await filedata.saveXml(state.xml)

    testLog('REVISION_SAVED', { changeDescription: revDlg.changeDesc.value });

    // Verify revision was added to XML content (self-contained for bundle removal)
    testLog('REVISION_IN_XML_VERIFIED', {
      changeDescription: revDlg.changeDesc.value,
      xmlContainsRevision: xmlEditor.getXML().includes(revDlg.changeDesc.value)
    });

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
      newVersiondialog.addEventListener('sl-hide', reject, { once: true })
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
 * Edit file metadata (fileref, title, DOI, variant)
 * @param {ApplicationState} state
 */
async function editFileMetadata(state) {
  if (!state.xml) {
    dialog.error("No file loaded")
    return
  }

  // @ts-ignore
  const metadataDlg = ui.editMetadataDialog;

  // Load current metadata
  const fileData = getFileDataById(state.xml);
  if (!fileData) {
    dialog.error("Could not load file metadata")
    return
  }

  // Pre-fill form with current values
  metadataDlg.fileref.value = fileData.file?.fileref || ""
  metadataDlg.title.value = fileData.file?.title || ""
  metadataDlg.doi.value = fileData.file?.doi || ""
  metadataDlg.variant.value = fileData.item?.variant || ""

  try {
    metadataDlg.show()
    await new Promise((resolve, reject) => {
      metadataDlg.submit.addEventListener('click', resolve, { once: true })
      metadataDlg.cancel.addEventListener('click', reject, { once: true })
      metadataDlg.addEventListener('sl-hide', reject, { once: true })
    })
  } catch (e) {
    console.warn("User cancelled")
    return
  } finally {
    metadataDlg.hide()
  }

  // Gather updated values
  const updatedMetadata = {
    fileref: metadataDlg.fileref.value.trim(),
    title: metadataDlg.title.value.trim(),
    doi: metadataDlg.doi.value.trim(),
    variant: metadataDlg.variant.value.trim()
  }

  ui.toolbar.documentActions.editMetadata.disabled = true
  try {
    // Update TEI header with new metadata
    const xmlDoc = xmlEditor.getXmlTree()
    if (!xmlDoc) {
      throw new Error("No XML document loaded")
    }

    // Update title in TEI header
    if (updatedMetadata.title !== fileData.file?.title) {
      const titleEl = xmlDoc.querySelector('teiHeader titleStmt title')
      if (titleEl) {
        titleEl.textContent = updatedMetadata.title
      }
    }

    // Update DOI in TEI header
    if (updatedMetadata.doi !== fileData.file?.doi) {
      let idnoEl = xmlDoc.querySelector('teiHeader publicationStmt idno[type="DOI"]')
      if (!idnoEl && updatedMetadata.doi) {
        // Create idno element if it doesn't exist
        const publicationStmt = xmlDoc.querySelector('teiHeader publicationStmt')
        if (publicationStmt) {
          idnoEl = xmlDoc.createElement('idno')
          idnoEl.setAttribute('type', 'DOI')
          publicationStmt.appendChild(idnoEl)
        }
      }
      if (idnoEl) {
        idnoEl.textContent = updatedMetadata.doi
      }
    }

    prettyPrintXmlDom(xmlDoc, 'teiHeader')
    await xmlEditor.updateEditorFromXmlTree()

    // Mark editor as clean to prevent autosave from triggering
    xmlEditor.markAsClean()

    // Save the updated XML
    const filedata = FiledataPlugin.getInstance()
    await filedata.saveXml(state.xml)

    // Update database metadata via API
    await client.filesMetadata(state.xml, updatedMetadata)

    // Reload file data to reflect changes
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

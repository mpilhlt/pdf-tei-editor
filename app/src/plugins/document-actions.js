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
  endpoints as ep, client, logger, dialog, authentication,
  xmlEditor, accessControl, testLog, fileselection, config, services
} from '../app.js'
import FiledataPlugin from './filedata.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../ui.js'
import { notify } from '../modules/sl-utils.js'
import * as tei_utils from '../modules/tei-utils.js'
import { prettyPrintXmlDom } from '../modules/xml-utils.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'


/**
 * plugin API
 */
const api = {
  saveDocument,
  deleteCurrentVersion,
  deleteAllVersions,
  deleteAll,
  addTeiHeaderInfo
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
 * @property {SlButton} deleteBtn - Delete dropdown button
 * @property {SlButton} deleteCurrentVersion - Delete current version button
 * @property {SlButton} deleteAllVersions - Delete all versions button
 * @property {SlButton} deleteAll - Delete all files button
 */

/**
 * @typedef {object} saveToNewCopySectionPart
 * @property {SlCheckbox} saveToNewCopy - Save to a new personal copy checkbox
 * @property {SlInput} copyLabel - Label for the new copy
 */

/**
 * @typedef {object} saveAsGoldSectionPart
 * @property {SlCheckbox} saveAsGold - Save as gold version checkbox
 */

/**
 * @typedef {object} optionsSectionPart
 * @property {HTMLDivElement & saveToNewCopySectionPart} saveToNewCopySection - New-copy option
 * @property {HTMLDivElement & saveAsGoldSectionPart} saveAsGoldSection - Gold version option, shown only to reviewers
 */

/**
 * Dialog for saving a revision (and optionally forking to a personal copy)
 * @typedef {object} saveDocumentDialogPart
 * @property {SlInput} changeDesc - Change description input
 * @property {SlSelect} status - Status select
 * @property {HTMLDivElement & optionsSectionPart} options - Options section containing copy and gold checkboxes
 * @property {SlButton} submit - Submit button
 * @property {SlButton} cancel - Cancel button
 */

// Register templates
await registerTemplate('document-action-buttons', 'document-action-buttons.html');
await registerTemplate('save-document-dialog', 'save-document-dialog.html');

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
  createSingleFromTemplate('save-document-dialog', document.body);

  // Add document action buttons to toolbar with medium priority
  documentActionButtons.forEach(buttonGroup => {
    if (buttonGroup instanceof HTMLElement) {
      ui.toolbar.add(buttonGroup, 8);
    }
  });
  updateUi() // Update UI so navigation objects are available

  const da = ui.toolbar.documentActions

  // save a revision (or fork to new copy)
  da.saveRevision.addEventListener('click', () => {
    if (currentState) saveDocument(currentState);
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

  // Allow save revision only if we have an xml path
  if (isAnnotator) {
    da.saveRevision.disabled = !Boolean(state.xml)
  } else {
    da.saveRevision.disabled = true
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
      app.invokePluginEndpoint(ep.sync.syncFiles, state)
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
  try {
    await client.deleteFiles(filePathsToDelete)
  } catch (err) {
    notify(err.message || 'Failed to delete files.', 'danger', 'exclamation-octagon')
    await fileselection.reload()
    return;
  }
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
    app.invokePluginEndpoint(ep.sync.syncFiles, currentState)
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
    app.invokePluginEndpoint(ep.sync.syncFiles, state)
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
 * Called when the "Save Revision" button is executed.
 * Combines saving a revision record with an optional fork to a new personal copy.
 * @param {ApplicationState} state
 */
async function saveDocument(state) {

  // @ts-ignore
  const dlg = ui.saveDocumentDialog;
  const userData = /** @type {any} */ (authentication.getUser())

  try {
    if (userData) {
      // Determine whether to auto-check and lock the "save to new copy" checkbox
      const isOwnerBasedMode = accessControl.getMode() === 'owner-based'
      const fileData = getFileDataById(state.xml, state.fileData)
      const isOwner = fileData?.item?.created_by === userData.username
      const forceCopy = isOwnerBasedMode && !isOwner
      dlg.options.saveToNewCopySection.saveToNewCopy.checked = forceCopy
      dlg.options.saveToNewCopySection.saveToNewCopy.disabled = forceCopy

      // Default copy label: v{N} (userId) where N = non-gold artifact count + 1
      const nonGoldCount = /** @type {any[]} */ (fileData?.file?.artifacts ?? [])
        .filter(a => !a.is_gold_standard).length
      dlg.options.saveToNewCopySection.copyLabel.value = `v${nonGoldCount + 1} (${userData.username})`

      // Toggle copyLabel visibility based on checkbox
      const updateCopyLabelVisibility = () => {
        dlg.options.saveToNewCopySection.copyLabel.style.display = dlg.options.saveToNewCopySection.saveToNewCopy.checked ? '' : 'none'
      }
      updateCopyLabelVisibility()
      dlg.options.saveToNewCopySection.saveToNewCopy.addEventListener('sl-change', updateCopyLabelVisibility, { once: false })

      // Get current status and last change description from TEI document
      const xmlDoc = xmlEditor.getXmlTree()
      let currentStatus = 'draft'
      let lastChangeDesc = ''
      if (xmlDoc) {
        const lastChange = xmlDoc.querySelector('revisionDesc change:last-of-type')
        if (lastChange) {
          currentStatus = lastChange.getAttribute('status') || 'draft'
          const descEl = lastChange.querySelector('desc')
          if (descEl?.textContent?.trim()) {
            lastChangeDesc = descEl.textContent.trim()
          }
        }
      }

      // Fetch lifecycle config
      const lifecycleOrder = await config.get('annotation.lifecycle.order')
      const changeDescriptions = /** @type {string[]} */ (await config.get('annotation.lifecycle.change-descriptions', []))

      // Build status → default description map (index-aligned with lifecycle order)
      /** @type {Object.<string, string>} */
      const statusDescMap = Object.fromEntries(
        lifecycleOrder.map((/** @type {string} */ s, /** @type {number} */ i) => [s, changeDescriptions[i] ?? ''])
      )

      // Annotators must not save with status 'extraction' — advance to the next lifecycle step
      if (currentStatus === 'extraction') {
        const idx = lifecycleOrder.indexOf('extraction')
        currentStatus = (idx >= 0 && idx < lifecycleOrder.length - 1)
          ? lifecycleOrder[idx + 1]
          : 'unfinished'
      }

      // Default change description: last XML <change><desc> has precedence over configured default,
      // unless it equals the extraction description (index 0) — in that case use the configured default.
      const extractionDesc = changeDescriptions[0] ?? ''
      const reuseLastDesc = lastChangeDesc && lastChangeDesc !== extractionDesc
      const defaultChangeDesc = reuseLastDesc ? lastChangeDesc : (statusDescMap[currentStatus] || '')

      // Collect allowed statuses for user's roles
      const userRoles = userData.roles || []
      let allowedStatuses = []

      for (const role of userRoles) {
        try {
          const roleStatuses = await config.get(`annotation.lifecycle.role.${role}`)
          if (roleStatuses) {
            allowedStatuses = [...allowedStatuses, ...roleStatuses]
          }
        } catch (e) {
          // Skip roles without lifecycle configuration
          continue
        }
      }

      // Remove duplicates
      allowedStatuses = [...new Set(allowedStatuses)]

      // Always include current status if not already in allowed list
      if (!allowedStatuses.includes(currentStatus)) {
        allowedStatuses.push(currentStatus)
      }

      // Clear existing options
      dlg.status.innerHTML = ''

      // Add options from lifecycle order, enabling only allowed statuses
      for (const status of lifecycleOrder) {
        const option = document.createElement('sl-option')
        option.value = status
        option.textContent = status.charAt(0).toUpperCase() + status.slice(1)
        option.disabled = !allowedStatuses.includes(status)
        dlg.status.appendChild(option)
      }

      // Set current status as selected
      dlg.status.value = currentStatus

      // Set default change description
      dlg.changeDesc.value = defaultChangeDesc
      dlg._changeDescManuallyEdited = false
      dlg.changeDesc.addEventListener('sl-input', () => { dlg._changeDescManuallyEdited = true }, { once: true })

      // Show/hide gold version section based on user role
      const isReviewer = userHasRole(userData, ["admin", "reviewer"])
      dlg.options.saveAsGoldSection.style.display = isReviewer ? '' : 'none'

      // Pre-check if current document is already a gold version
      const isCurrentlyGold = state.xml ? isGoldFile(state.xml) : false
      dlg.options.saveAsGoldSection.saveAsGold.checked = isCurrentlyGold
    }
    // Wait for dialog to be fully visible (attach listener before showing)
    const dialogShown = new Promise(resolve => dlg.addEventListener('sl-after-show', resolve, { once: true }))
    dlg.show()
    await dialogShown
    await new Promise((resolve, reject) => {
      dlg.submit.addEventListener('click', resolve, { once: true })
      dlg.cancel.addEventListener('click', reject, { once: true })
      // Only reject on dialog hide, not on nested component events
      const handleHide = (e) => {
        if (e.target === dlg) {
          reject()
        }
      }
      dlg.addEventListener('sl-hide', handleHide, { once: true })
    })
  } catch (e) {
    if (e instanceof Error) {
      console.error("Error in saveDocument:", e)
      throw e
    }
    console.warn("User cancelled")
    return
  } finally {
    dlg.hide()
    // Clean up manual-edit tracking flag
    delete dlg._changeDescManuallyEdited
  }

  dlg.hide()

  const saveToNewCopy = dlg.options.saveToNewCopySection.saveToNewCopy.checked

  /** @type {RespStmt} */
  const respStmt = {
    persId: userData.username,
    persName: userData.fullname,
    resp: "Annotator"
  }

  /** @type {RevisionChange} */
  const revisionChange = {
    status: dlg.status.value,
    persId: userData.username,
    desc: dlg.changeDesc.value,
    label: saveToNewCopy ? (dlg.options.saveToNewCopySection.copyLabel.value.trim() || undefined) : undefined
  }

  const saveAsGold = dlg.options.saveAsGoldSection.saveAsGold.checked

  ui.toolbar.documentActions.saveRevision.disabled = true
  try {
    if (saveToNewCopy) {
      if (!state.xml) throw new Error('No XML file loaded');

      // Keep reference to current file (used to determine doc_id for the new version)
      const currentFileId = state.xml

      // Get the source file's variant to preserve it in the new copy
      const sourceFile = getFileDataById(currentFileId, state.fileData)
      const sourceVariant = sourceFile?.variant

      // Modify the header FIRST, before saving as new copy.
      // Pass edition with no title so only date + fileref are updated.
      await addTeiHeaderInfo(respStmt, /** @type {Edition} */ ({ title: undefined, note: undefined }), revisionChange)

      // Ensure variant is preserved in the XML if the source file had a variant
      if (sourceVariant) {
        const xmlDoc = xmlEditor.getXmlTree()
        if (xmlDoc) {
          tei_utils.ensureExtractorVariant(xmlDoc, sourceVariant)
          await xmlEditor.updateEditorFromXmlTree()
        }
      }

      // Mark editor as clean to prevent autosave from triggering
      xmlEditor.markAsClean()

      // Save as new version (fork)
      const filedata = FiledataPlugin.getInstance()
      let { file_id: newFileId } = await filedata.saveXml(currentFileId, /* save as new version */ true)

      testLog('NEW_VERSION_CREATED', { oldFileId: currentFileId, newFileId });

      xmlEditor.markAsClean()

      // Reload file data and load the new copy
      await fileselection.reload({refresh:true})
      await services.load({ xml: newFileId })

      testLog('NEW_VERSION_LOADED', { fileId: newFileId, editorReadOnly: app.getCurrentState().editorReadOnly });

      notify("Document was duplicated. You are now editing the copy.")

    } else {
      // Save revision in-place
      await addTeiHeaderInfo(respStmt, undefined, revisionChange)
      if (!state.xml) throw new Error('No XML file loaded')

      // Mark editor as clean to prevent autosave from triggering
      xmlEditor.markAsClean()

      const filedata = FiledataPlugin.getInstance()
      await filedata.saveXml(state.xml)

      testLog('REVISION_SAVED', {
        changeDescription: dlg.changeDesc.value,
        status: dlg.status.value
      });

      testLog('REVISION_IN_XML_VERIFIED', {
        changeDescription: dlg.changeDesc.value,
        xmlContainsRevision: xmlEditor.getXML().includes(dlg.changeDesc.value)
      });

      // Set as gold standard if checkbox was checked
      if (saveAsGold) {
        try {
          await client.apiClient.filesGoldStandard(state.xml)
          testLog('GOLD_STANDARD_SET', { fileId: state.xml })
          await fileselection.reload({ refresh: true })
          notify("Revision saved and marked as Gold version")
        } catch (goldError) {
          console.error("Failed to set gold standard:", goldError)
          notify("Revision saved, but failed to set as Gold version", "warning")
        }
      } else {
        notify("Revision saved successfully")
      }
    }

    app.invokePluginEndpoint(ep.sync.syncFiles, state)
      .then(summary => summary && console.debug(summary))
      .catch(e => console.error(e))

    xmlEditor.markAsClean()
  } catch (error) {
    console.error(error)
    notify(`Save failed: ${String(error)}`, 'danger', 'exclamation-octagon');
  } finally {
    ui.toolbar.documentActions.saveRevision.disabled = false
  }
}

/**
 * Add information on responsibility, edition or revisions to the document
 * @param {RespStmt} [respStmt] - Optional responsible statement details.
 * @param {Edition} [edition] - Optional edition statement details.
 * @param {RevisionChange} [revisionChange] - Optional revision statement details.
 * @throws {Error} If any of the operations to add teiHeader info fail
 */
async function addTeiHeaderInfo(respStmt, _edition, revisionChange) {

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

  if (revisionChange) {
    tei_utils.addRevisionChange(xmlDoc, revisionChange)
  }
  prettyPrintXmlDom(xmlDoc, 'teiHeader')
  await xmlEditor.updateEditorFromXmlTree()
}


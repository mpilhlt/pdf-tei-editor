/**
 * Document Actions Plugin - Handles document operations (save, version, delete)
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton, SlInput, SlCheckbox, SlSelect } from '../ui.js'
 * @import { RespStmt, RevisionChange, Edition} from '../modules/tei-utils.js'
 * @import { Artifact } from '../modules/file-data-utils.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ui, { updateUi } from '../ui.js'
import ep from '../extension-points.js'
import { testLog } from '../modules/test-log.js'
import FiledataPlugin from './filedata.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'
import { notify } from '../modules/sl-utils.js'
import * as tei_utils from '../modules/tei-utils.js'
import { prettyPrintXmlDom } from '../modules/xml-utils.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'
import { api as clientApi } from './client.js'
import { api as servicesApi } from './services.js'
import { api as xmlEditor } from './xmleditor.js'

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
await registerTemplate('document-action-buttons', 'document-action-buttons.html')
await registerTemplate('save-document-dialog', 'save-document-dialog.html')

class DocumentActionsPlugin extends Plugin {
  static extensionPoints = [ep.toolbar.contentItems]

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'document-actions', deps: ['file-selection', 'authentication', 'access-control', 'config', 'logger', 'dialog'] })
  }

  /** @type {HTMLSpanElement & Record<string, any>} */
  #ui = null

  /** @type {HTMLElement & Record<string, any>} */
  #dialogUi = null

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "document-actions"`)

    const span = createSingleFromTemplate('document-action-buttons')
    this.#ui = this.createUi(span)
    // Add to toolbar now so that other plugins installing after this one
    // can access ui.toolbar.documentActions during their own install() phase.
    ui.toolbar.add(span, 8)
    updateUi()

    const dialog = createSingleFromTemplate('save-document-dialog', document.body)
    this.#dialogUi = this.createUi(dialog)

    const da = this.#ui.documentActions
    da.saveRevision.addEventListener('click', () => this.saveRevision())
    da.deleteCurrentVersion.addEventListener('click', () => this.deleteCurrentVersion())
    da.deleteAllVersions.addEventListener('click', () => this.deleteAllVersions())
    da.deleteAll.addEventListener('click', () => this.deleteAll())
  }

  /**
   * Contribute toolbar buttons to the main toolbar.
   * Called by ToolbarPlugin.start() via the toolbar.contentItems extension point.
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  contentItems() {
    return [{ element: this.#ui, priority: 8, position: 'center' }]
  }

  /**
   * @param {string[]} _changedKeys
   */
  async onStateUpdate(_changedKeys) {
    const state = this.state
    const da = this.#ui.documentActions

    da.childNodes.forEach(el => {
      if (el instanceof HTMLElement && 'disabled' in el) {
        // @ts-ignore
        el.disabled = state.offline
      }
    })
    if (state.offline) return

    const isReviewer = userHasRole(state.user, ["admin", "reviewer"])
    const isAnnotator = userHasRole(state.user, ["admin", "reviewer", "annotator"])

    if (isAnnotator || isReviewer) {
      da.deleteAll.disabled = !Boolean(state.pdf && state.xml) || !isReviewer
      da.deleteAllVersions.disabled = !isReviewer || ui.toolbar.xml.querySelectorAll("sl-option").length < 2
      da.deleteCurrentVersion.disabled = !state.xml || state.editorReadOnly || (isGoldFile(state.xml) && !isReviewer)
    } else {
      for (const btn of [da.deleteAll, da.deleteAllVersions, da.deleteCurrentVersion]) {
        btn.disabled = true
      }
    }

    da.deleteBtn.disabled =
      da.deleteCurrentVersion.disabled &&
      da.deleteAllVersions.disabled &&
      da.deleteAll.disabled

    da.saveRevision.disabled = isAnnotator ? !Boolean(state.xml) : true
  }

  /**
   * Deletes the current version of the document
   */
  async deleteCurrentVersion() {
    const state = this.state
    let xmlValue = ui.toolbar.xml.value
    let selectedOption = ui.toolbar.xml.selectedOptions[0]

    if (!xmlValue && state.xml && !state.pdf) {
      xmlValue = state.xml
      selectedOption = ui.toolbar.pdf.selectedOptions[0]
    }

    if (!xmlValue) {
      this.getDependency('dialog').error("No file selected for deletion")
      return
    }

    if (state.pdf && typeof xmlValue === 'string') {
      const fileData = getFileDataById(xmlValue)
      if (fileData && fileData.type === 'gold' && !userHasRole(state.user, ['admin', 'reviewer'])) {
        this.getDependency('dialog').error("You cannot delete the gold version")
      }
    }

    const filePathsToDelete = [xmlValue]
    if (filePathsToDelete.length > 0) {
      const versionName = selectedOption ? selectedOption.textContent : 'current version'
      const msg = `Are you sure you want to delete the current version "${versionName}"?`
      if (!confirm(msg)) return

      servicesApi.removeMergeView()
      await clientApi.deleteFiles(/** @type {string[]} */ (filePathsToDelete))
      try {
        await this.dispatchStateChange({ xml: null })
        await this.getDependency('file-selection').reload()
        // @ts-ignore
        const xml = ui.toolbar.xml.firstChild?.value
        await servicesApi.load({ xml })
        notify(`Version "${versionName}" has been deleted.`)
        this.context.invokePluginEndpoint(ep.sync.syncFiles, state)
          .then(summary => summary && console.debug(summary))
          .catch(e => console.error(e))
      } catch (error) {
        console.error(error)
        this.getDependency('dialog').error(String(error))
      }
    }
  }

  /**
   * Deletes all versions of the document, leaving only the gold standard version
   */
  async deleteAllVersions() {
    const state = this.state
    if (!state?.fileData) throw new Error("No file data")

    const currentSource = ui.toolbar.pdf.value
    const selectedFile = state.fileData.find(file => file.source?.id === currentSource)

    if (!selectedFile || !selectedFile.artifacts) return

    let artifactsToDelete = selectedFile.artifacts.filter(/** @param {any} a */ a => !a.is_gold_standard)
    const { variant } = state

    if (variant === "none") {
      artifactsToDelete = artifactsToDelete.filter(/** @param {any} artifact */ artifact => !artifact.variant)
    } else if (variant && variant !== "") {
      artifactsToDelete = artifactsToDelete.filter(/** @param {any} artifact */ artifact => artifact.variant === variant)
    }

    const filePathsToDelete = artifactsToDelete.map(/** @param {any} artifact */ artifact => artifact.id)

    if (filePathsToDelete.length > 0) {
      const variantText = variant === "none" ? "without variant" :
        variant && variant !== "" ? `with variant "${variant}"` : ""
      const msg = `Are you sure you want to delete ${filePathsToDelete.length} version(s) ${variantText}? This cannot be undone.`
      if (!confirm(msg)) return
    } else {
      const variantText = variant === "none" ? "without variant" : `with variant "${variant}"`
      notify(`No versions ${variantText} found to delete.`)
      return
    }

    servicesApi.removeMergeView()
    try {
      await clientApi.deleteFiles(filePathsToDelete)
    } catch (err) {
      notify(err.message || 'Failed to delete files.', 'danger', 'exclamation-octagon')
      await this.getDependency('file-selection').reload()
      return
    }
    try {
      await this.dispatchStateChange({ xml: null })
      await this.getDependency('file-selection').reload()

      let goldToLoad = null
      if (selectedFile.artifacts) {
        const goldArtifacts = selectedFile.artifacts.filter(/** @param {any} a */ a => a.is_gold_standard)
        if (variant === "none") {
          goldToLoad = goldArtifacts.find(/** @param {any} gold */ gold => !gold.variant)
        } else if (variant && variant !== "") {
          goldToLoad = goldArtifacts.find(/** @param {any} gold */ gold => gold.variant === variant)
        } else {
          goldToLoad = goldArtifacts[0]
        }
      }

      if (goldToLoad) {
        await servicesApi.load({ xml: goldToLoad.id })
      }

      const variantText = variant === "none" ? "without variant" :
        variant && variant !== "" ? `with variant "${variant}"` : ""
      notify(`All versions ${variantText} have been deleted`)
      this.context.invokePluginEndpoint(ep.sync.syncFiles, state)
        .then(summary => summary && console.debug(summary))
        .catch(e => console.error(e))
    } catch (error) {
      console.error(error)
      this.getDependency('dialog').error(String(error))
    }
  }

  /**
   * Deletes all versions of the document and the PDF file
   */
  async deleteAll() {
    const state = this.state

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
      if (!confirm(msg)) return
    }

    servicesApi.removeMergeView()
    this.getDependency('logger').debug("Deleting files:" + filePathsToDelete.join(", "))

    try {
      await clientApi.deleteFiles(/** @type {string[]} */ (filePathsToDelete))
      notify(`${filePathsToDelete.length} files have been deleted.`)
      this.context.invokePluginEndpoint(ep.sync.syncFiles, state)
        .then(summary => summary && console.debug(summary))
        .catch(e => console.error(e))
    } catch (error) {
      const errorMessage = String(error)
      console.error(errorMessage)
      notify(errorMessage, "warning")
    } finally {
      await this.getDependency('file-selection').reload({ refresh: true })
      await this.dispatchStateChange({ xml: null, pdf: null })
    }
  }

  /**
   * Called when the "Save Revision" button is executed.
   */
  async saveRevision() {
    const state = this.state
    const dlg = this.#dialogUi
    const userData = /** @type {any} */ (this.getDependency('authentication').getUser())

    try {
      if (userData) {
        const isOwnerBasedMode = this.getDependency('access-control').getMode() === 'owner-based'
        const fileData = getFileDataById(state.xml, state.fileData)
        const isOwner = fileData?.item?.created_by === userData.username
        const forceCopy = isOwnerBasedMode && !isOwner
        dlg.options.saveToNewCopySection.saveToNewCopy.checked = forceCopy
        dlg.options.saveToNewCopySection.saveToNewCopy.disabled = forceCopy

        const nonGoldCount = /** @type {Artifact[]} */ (fileData?.file?.artifacts ?? [])
          .filter(a => !a.is_gold_standard && a.variant === state.variant).length
        dlg.options.saveToNewCopySection.copyLabel.value = `v${nonGoldCount + 1} (${userData.username})`

        const updateCopyLabelVisibility = () => {
          dlg.options.saveToNewCopySection.copyLabel.style.display = dlg.options.saveToNewCopySection.saveToNewCopy.checked ? '' : 'none'
        }
        updateCopyLabelVisibility()
        dlg.options.saveToNewCopySection.saveToNewCopy.addEventListener('sl-change', updateCopyLabelVisibility, { once: false })

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

        const config = this.getDependency('config')
        const lifecycleOrder = await config.get('annotation.lifecycle.order')
        const changeDescriptions = /** @type {string[]} */ (await config.get('annotation.lifecycle.change-descriptions', []))

        /** @type {Object.<string, string>} */
        const statusDescMap = Object.fromEntries(
          lifecycleOrder.map((/** @type {string} */ s, /** @type {number} */ i) => [s, changeDescriptions[i] ?? ''])
        )

        if (currentStatus === 'extraction') {
          const idx = lifecycleOrder.indexOf('extraction')
          currentStatus = (idx >= 0 && idx < lifecycleOrder.length - 1)
            ? lifecycleOrder[idx + 1]
            : 'unfinished'
        }

        const extractionDesc = changeDescriptions[0] ?? ''
        const reuseLastDesc = lastChangeDesc && lastChangeDesc !== extractionDesc
        const defaultChangeDesc = reuseLastDesc ? lastChangeDesc : (statusDescMap[currentStatus] || '')

        const userRoles = userData.roles || []
        let allowedStatuses = []

        for (const role of userRoles) {
          try {
            const roleStatuses = await config.get(`annotation.lifecycle.role.${role}`)
            if (roleStatuses) {
              allowedStatuses = [...allowedStatuses, ...roleStatuses]
            }
          } catch (e) {
            continue
          }
        }

        allowedStatuses = [...new Set(allowedStatuses)]
        if (!allowedStatuses.includes(currentStatus)) {
          allowedStatuses.push(currentStatus)
        }

        dlg.status.innerHTML = ''
        for (const status of lifecycleOrder) {
          const option = document.createElement('sl-option')
          option.value = status
          option.textContent = status.charAt(0).toUpperCase() + status.slice(1)
          option.disabled = !allowedStatuses.includes(status)
          dlg.status.appendChild(option)
        }

        dlg.status.value = currentStatus
        dlg.changeDesc.value = defaultChangeDesc
        dlg._changeDescManuallyEdited = false
        dlg.changeDesc.addEventListener('sl-input', () => { dlg._changeDescManuallyEdited = true }, { once: true })

        const isReviewer = userHasRole(userData, ["admin", "reviewer"])
        dlg.options.saveAsGoldSection.style.display = isReviewer ? '' : 'none'

        const isCurrentlyGold = state.xml ? isGoldFile(state.xml) : false
        dlg.options.saveAsGoldSection.saveAsGold.checked = isCurrentlyGold
      }

      const dialogShown = new Promise(resolve => dlg.addEventListener('sl-after-show', resolve, { once: true }))
      dlg.show()
      await dialogShown
      await new Promise((resolve, reject) => {
        dlg.submit.addEventListener('click', resolve, { once: true })
        dlg.cancel.addEventListener('click', reject, { once: true })
        const handleHide = (e) => {
          if (e.target === dlg) reject()
        }
        dlg.addEventListener('sl-hide', handleHide, { once: true })
      })
    } catch (e) {
      if (e instanceof Error) {
        console.error("Error in saveRevision:", e)
        throw e
      }
      console.warn("User cancelled")
      return
    } finally {
      dlg.hide()
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

    this.#ui.documentActions.saveRevision.disabled = true
    try {
      if (saveToNewCopy) {
        if (!state.xml) throw new Error('No XML file loaded')

        const currentFileId = state.xml
        const sourceFile = getFileDataById(currentFileId, state.fileData)
        const sourceVariant = sourceFile?.variant

        await this.addTeiHeaderInfo(respStmt, /** @type {Edition} */ ({ title: undefined, note: undefined }), revisionChange)

        if (sourceVariant) {
          const xmlDoc = xmlEditor.getXmlTree()
          if (xmlDoc) {
            tei_utils.ensureExtractorVariant(xmlDoc, sourceVariant)
            await xmlEditor.updateEditorFromXmlTree()
          }
        }

        xmlEditor.markAsClean()

        const filedata = FiledataPlugin.getInstance()
        let { file_id: newFileId } = await filedata.saveXml(currentFileId, true)

        testLog('NEW_VERSION_CREATED', { oldFileId: currentFileId, newFileId })

        xmlEditor.markAsClean()

        await this.getDependency('file-selection').reload({ refresh: true })
        await servicesApi.load({ xml: newFileId })

        testLog('NEW_VERSION_LOADED', { fileId: newFileId, editorReadOnly: this.state.editorReadOnly })

        notify("Document was duplicated. You are now editing the copy.")
      } else {
        await this.addTeiHeaderInfo(respStmt, undefined, revisionChange)
        if (!state.xml) throw new Error('No XML file loaded')

        xmlEditor.markAsClean()

        const filedata = FiledataPlugin.getInstance()
        await filedata.saveXml(state.xml)

        testLog('REVISION_SAVED', {
          changeDescription: dlg.changeDesc.value,
          status: dlg.status.value
        })

        testLog('REVISION_IN_XML_VERIFIED', {
          changeDescription: dlg.changeDesc.value,
          xmlContainsRevision: xmlEditor.getXML().includes(dlg.changeDesc.value)
        })

        if (saveAsGold) {
          try {
            await clientApi.apiClient.filesGoldStandard(state.xml)
            testLog('GOLD_STANDARD_SET', { fileId: state.xml })
            await this.getDependency('file-selection').reload({ refresh: true })
            notify("Revision saved and marked as Gold version")
          } catch (goldError) {
            console.error("Failed to set gold standard:", goldError)
            notify("Revision saved, but failed to set as Gold version", "warning")
          }
        } else {
          notify("Revision saved successfully")
        }
      }

      this.context.invokePluginEndpoint(ep.sync.syncFiles, state)
        .then(summary => summary && console.debug(summary))
        .catch(e => console.error(e))

      xmlEditor.markAsClean()
    } catch (error) {
      console.error(error)
      notify(`Save failed: ${String(error)}`, 'danger', 'exclamation-octagon')
    } finally {
      this.#ui.documentActions.saveRevision.disabled = false
    }
  }

  /**
   * Add information on responsibility, edition or revisions to the document
   * @param {RespStmt} [respStmt]
   * @param {Edition} [_edition]
   * @param {RevisionChange} [revisionChange]
   * @throws {Error} If any of the operations to add teiHeader info fail
   */
  async addTeiHeaderInfo(respStmt, _edition, revisionChange) {
    const xmlDoc = xmlEditor.getXmlTree()
    if (!xmlDoc) throw new Error("No XML document loaded")

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
}

export default DocumentActionsPlugin

/** @deprecated Use getDependency('document-actions') instead */
export const api = new Proxy({}, {
  get(_, prop) {
    const instance = DocumentActionsPlugin.getInstance()
    const value = instance[prop]
    return typeof value === 'function' ? value.bind(instance) : value
  },
  set(_, prop, value) {
    DocumentActionsPlugin.getInstance()[prop] = value
    return true
  }
})

export const plugin = DocumentActionsPlugin

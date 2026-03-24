/**
 * This plugin allows moving files to a different collection.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton, SlSelect, SlOption, SlDialog } from '../ui.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { notify } from '../modules/sl-utils.js'
import { registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js'
import ui from '../ui.js'
import { userHasRole } from '../modules/acl-utils.js'
import { api as clientApi } from './client.js'
import { api as servicesApi } from './services.js'

/**
 * @typedef {object} MoveFilesDialog
 * @property {SlSelect} collectionName
 * @property {SlButton} newCollectionBtn
 * @property {import('../ui.js').SlCheckbox} copyMode
 * @property {SlButton} cancel
 * @property {SlButton} submit
 */

// Register template
await registerTemplate('move-files-dialog', 'move-files-dialog.html')

class MoveFilesPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'move-files', deps: ['services', 'file-selection', 'logger', 'dialog'] })
  }

  /** @type {SlButton} */
  #moveBtn = Object.assign(document.createElement('sl-button'), {
    innerHTML: `<sl-icon name="folder-symlink"></sl-icon>`,
    variant: 'default',
    size: 'small',
    name: 'moveFiles'
  })

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "move-files"`)

    createSingleFromTemplate('move-files-dialog', document.body)
    ui.toolbar.documentActions.append(this.#moveBtn)
    updateUi()

    this.#moveBtn.addEventListener('click', () => this.#showMoveFilesDialog())

    ui.moveFilesDialog.newCollectionBtn.addEventListener('click', async () => {
      const newCollectionId = prompt("Enter new collection ID (Only letters, numbers, '-' and '_'):")
      if (newCollectionId) {
        if (!/^[a-zA-Z0-9_-]+$/.test(newCollectionId)) {
          this.getDependency('dialog').error("Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed.")
          return
        }
        const newCollectionName = prompt("Enter collection display name (optional, leave blank to use ID):")
        try {
          const result = await clientApi.createCollection(newCollectionId, newCollectionName || newCollectionId)
          if (result.success) {
            const placeholderOption = ui.moveFilesDialog.collectionName.querySelector('sl-option[disabled]')
            if (placeholderOption) placeholderOption.remove()
            const option = Object.assign(document.createElement('sl-option'), {
              value: newCollectionId,
              textContent: newCollectionName || newCollectionId
            })
            ui.moveFilesDialog.collectionName.append(option)
            ui.moveFilesDialog.collectionName.value = newCollectionId
            notify(result.message)
            await this.getDependency('file-selection').reload()
          }
        } catch (error) {
          this.getDependency('dialog').error(`Error creating collection: ${String(error)}`)
        }
      }
    })

    ui.moveFilesDialog.copyMode.addEventListener('sl-change', () => {
      const isCopyMode = ui.moveFilesDialog.copyMode.checked
      const submitLabel = ui.moveFilesDialog.querySelector('[name="submitLabel"]')
      if (submitLabel) submitLabel.textContent = isCopyMode ? 'Copy' : 'Move'
    })
  }

  async onStateUpdate(_changedKeys) {
    const isReviewer = userHasRole(this.state.user, ["admin", "reviewer"])
    this.#moveBtn.disabled = !this.state.xml || !isReviewer
  }

  async #showMoveFilesDialog() {
    const state = this.state
    const { xml, pdf, collections } = state
    if (!xml || !pdf) {
      this.getDependency('dialog').error("Cannot move/copy files, PDF or XML path is missing.")
      return
    }

    ui.moveFilesDialog.copyMode.checked = false
    const submitLabel = ui.moveFilesDialog.querySelector('[name="submitLabel"]')
    if (submitLabel) submitLabel.textContent = 'Move'

    const collectionSelectBox = ui.moveFilesDialog.collectionName
    collectionSelectBox.innerHTML = ""

    if (!collections || collections.length === 0) {
      const placeholderOption = Object.assign(document.createElement('sl-option'), {
        value: '',
        textContent: '(No collections available - click "New" to create one)',
        disabled: true
      })
      collectionSelectBox.append(placeholderOption)
      collectionSelectBox.value = ''
    } else {
      for (const collection of collections) {
        const option = Object.assign(document.createElement('sl-option'), {
          value: collection.id,
          textContent: collection.name
        })
        collectionSelectBox.append(option)
      }
    }

    try {
      ui.moveFilesDialog.show()
      await new Promise((resolve, reject) => {
        ui.moveFilesDialog.submit.addEventListener('click', resolve, { once: true })
        ui.moveFilesDialog.cancel.addEventListener('click', reject, { once: true })
        ui.moveFilesDialog.addEventListener('sl-hide', e => e.preventDefault(), { once: true })
      })
    } catch (e) {
      this.getDependency('logger').warn("User cancelled move/copy files dialog")
      return
    } finally {
      ui.moveFilesDialog.hide()
    }

    const destinationCollection = String(collectionSelectBox.value)
    if (!destinationCollection) {
      this.getDependency('dialog').error("No collection selected. Please select a collection or create a new one.")
      return
    }

    const isCopyMode = ui.moveFilesDialog.copyMode.checked
    const operationName = isCopyMode ? 'Copying' : 'Moving'

    ui.spinner.show(`${operationName} files, please wait...`)
    try {
      let result
      if (isCopyMode) {
        result = await clientApi.copyFiles(pdf, xml, destinationCollection)
      } else {
        result = await clientApi.moveFiles(pdf, xml, destinationCollection)
      }

      await this.getDependency('file-selection').reload()
      await servicesApi.load({ pdf: result.new_pdf_id, xml: result.new_xml_id })

      const destCollection = collections.find(c => c.id === destinationCollection)
      const collectionName = destCollection ? destCollection.name : destinationCollection
      notify(`Files ${isCopyMode ? 'copied' : 'moved'} to "${collectionName}"`)
    } catch (error) {
      this.getDependency('dialog').error(`Error ${isCopyMode ? 'copying' : 'moving'} files: ${String(error)}`)
    } finally {
      ui.spinner.hide()
    }
  }
}

export default MoveFilesPlugin

export const plugin = MoveFilesPlugin

/**
 * This plugin allows moving files to a different collection.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton } from '../ui.js'
 * @import { moveFilesDialogPart } from '../templates/move-files-dialog.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { notify } from '../modules/sl-utils.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'
import ui from '../ui.js'
import { userHasRole } from '../modules/acl-utils.js'

// Register template
await registerTemplate('move-files-dialog', 'move-files-dialog.html')

class MoveFilesPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'move-files', deps: ['services', 'file-selection', 'logger', 'dialog', 'document-actions'] })
  }

  get #client()          { return this.getDependency('client') }
  get #services()        { return this.getDependency('services') }
  get #logger()          { return this.getDependency('logger') }
  get #dialog()          { return this.getDependency('dialog') }
  get #fileSelection()   { return this.getDependency('file-selection') }
  get #documentActions() { return this.getDependency('document-actions') }

  /** @type {SlButton} */
  #moveBtn = Object.assign(document.createElement('sl-button'), {
    innerHTML: `<sl-icon name="folder-symlink"></sl-icon>`,
    variant: 'default',
    size: 'small',
    name: 'moveFiles'
  })

  /** @type {import('../ui.js').SlDialog & moveFilesDialogPart} */
  #dialogUi = null

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.#logger.debug(`Installing plugin "move-files"`)

    const dialog = createSingleFromTemplate('move-files-dialog', document.body)
    this.#dialogUi = this.createUi(dialog)

    this.#documentActions.addButton(this.#moveBtn)
    this.#moveBtn.addEventListener('click', () => this.#showMoveFilesDialog())

    this.#dialogUi.newCollectionBtn.addEventListener('click', async () => {
      const newCollectionId = prompt("Enter new collection ID (Only letters, numbers, '-' and '_'):")
      if (newCollectionId) {
        if (!/^[a-zA-Z0-9_-]+$/.test(newCollectionId)) {
          this.#dialog.error("Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed.")
          return
        }
        const newCollectionName = prompt("Enter collection display name (optional, leave blank to use ID):")
        try {
          const result = await this.#client.createCollection(newCollectionId, newCollectionName || newCollectionId)
          if (result.success) {
            const placeholderOption = this.#dialogUi.collectionName.querySelector('sl-option[disabled]')
            if (placeholderOption) placeholderOption.remove()
            const option = Object.assign(document.createElement('sl-option'), {
              value: newCollectionId,
              textContent: newCollectionName || newCollectionId
            })
            this.#dialogUi.collectionName.append(option)
            this.#dialogUi.collectionName.value = newCollectionId
            notify(result.message)
            await this.#fileSelection.reload()
          }
        } catch (error) {
          this.#dialog.error(`Error creating collection: ${String(error)}`)
        }
      }
    })

    this.#dialogUi.copyMode.addEventListener('sl-change', () => {
      const isCopyMode = this.#dialogUi.copyMode.checked
      this.#dialogUi.submit.submitLabel.textContent = isCopyMode ? 'Copy' : 'Move'
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
      this.#dialog.error("Cannot move/copy files, PDF or XML path is missing.")
      return
    }

    this.#dialogUi.copyMode.checked = false
    this.#dialogUi.submit.submitLabel.textContent = 'Move'

    const collectionSelectBox = this.#dialogUi.collectionName
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
      this.#dialogUi.show()
      await new Promise((resolve, reject) => {
        this.#dialogUi.submit.addEventListener('click', resolve, { once: true })
        this.#dialogUi.cancel.addEventListener('click', reject, { once: true })
        this.#dialogUi.addEventListener('sl-hide', e => e.preventDefault(), { once: true })
      })
    } catch (e) {
      this.#logger.info("User cancelled move/copy files dialog")
      return
    } finally {
      this.#dialogUi.hide()
    }

    const destinationCollection = String(collectionSelectBox.value)
    if (!destinationCollection) {
      this.#dialog.error("No collection selected. Please select a collection or create a new one.")
      return
    }

    const isCopyMode = this.#dialogUi.copyMode.checked
    const operationName = isCopyMode ? 'Copying' : 'Moving'

    ui.spinner.show(`${operationName} files, please wait...`)
    try {
      let result
      if (isCopyMode) {
        result = await this.#client.copyFiles(pdf, xml, destinationCollection)
      } else {
        result = await this.#client.moveFiles(pdf, xml, destinationCollection)
      }

      await this.#fileSelection.reload()
      await this.#services.load({ pdf: result.new_pdf_id, xml: result.new_xml_id })

      const destCollection = collections.find(c => c.id === destinationCollection)
      const collectionName = destCollection ? destCollection.name : destinationCollection
      notify(`Files ${isCopyMode ? 'copied' : 'moved'} to "${collectionName}"`)
    } catch (error) {
      this.#dialog.error(`Error ${isCopyMode ? 'copying' : 'moving'} files: ${String(error)}`)
    } finally {
      ui.spinner.hide()
    }
  }
}

export default MoveFilesPlugin

export const plugin = MoveFilesPlugin

/**
 * Service plugin for moving/copying files between collections.
 * Exposes showBatchDialog() for use by FileSelectionDrawerPlugin.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { CollectionInfo, ProjectInfo } from '../state.js'
 * @import { moveFilesDialogPart } from '../templates/move-files-dialog.types.js'
 * @import { SlDialog, SlCheckbox } from '../ui.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { notify } from '../modules/sl-utils.js'
import { registerTemplate, createSingleFromTemplate } from '../ui.js'

await registerTemplate('move-files-dialog', 'move-files-dialog.html')

class MoveFilesPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'move-files', deps: ['logger', 'dialog', 'client'] })
  }

  get #client() { return this.getDependency('client') }
  get #logger() { return this.getDependency('logger') }
  get #dialog() { return this.getDependency('dialog') }

  /** @type {SlDialog & moveFilesDialogPart} */
  #dialogUi = null

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.#logger.debug(`Installing plugin "move-files"`)

    const dialog = createSingleFromTemplate('move-files-dialog', document.body)
    this.#dialogUi = this.createUi(dialog)

    this.#dialogUi.newCollectionBtn.addEventListener('click', async () => {
      const newCollectionId = prompt("Enter new collection ID (Only letters, numbers, '-' and '_'):")
      if (!newCollectionId) return
      if (!/^[a-zA-Z0-9_-]+$/.test(newCollectionId)) {
        this.#dialog.error("Invalid collection ID. Only letters, numbers, hyphens, and underscores are allowed.")
        return
      }
      const newCollectionName = prompt("Enter collection display name (optional, leave blank to use ID):")
      if (newCollectionName === null) return
      try {
        await this.#client.createCollection(newCollectionId, newCollectionName || newCollectionId)
        this.#appendCollectionCheckbox(newCollectionId, newCollectionName || newCollectionId, true)
        notify(`Collection '${newCollectionName || newCollectionId}' created`, 'success', 'check-circle')
      } catch (error) {
        this.#dialog.error(`Error creating collection: ${String(error)}`)
      }
    })
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {boolean} [checked]
   */
  #appendCollectionCheckbox(id, name, checked = false) {
    const div = document.createElement('div')
    div.style.cssText = 'display: flex; align-items: center; padding: 0.25rem 0;'
    const checkbox = /** @type {SlCheckbox} */ (document.createElement('sl-checkbox'))
    checkbox.size = 'small'
    checkbox.textContent = name
    checkbox.checked = checked
    checkbox.dataset.collectionId = id
    checkbox.addEventListener('sl-change', () => this.#updateButtonStates())
    div.appendChild(checkbox)
    this.#dialogUi.collectionsList.appendChild(div)
    this.#updateButtonStates()
  }

  #updateButtonStates() {
    const checkboxes = /** @type {SlCheckbox[]} */ ([
      ...this.#dialogUi.collectionsList.querySelectorAll('sl-checkbox')
    ])
    const checkedCount = checkboxes.filter(cb => cb.checked).length
    this.#dialogUi.moveBtn.disabled = checkedCount !== 1
    this.#dialogUi.copyBtn.disabled = checkedCount === 0
  }

  /**
   * Opens a dialog to select target collection(s) for batch move/copy.
   * @param {{
   *   pdfIds: string[],
   *   collections: CollectionInfo[],
   *   projects: ProjectInfo[]
   * }} params
   * @returns {Promise<{action: 'move'|'copy', targetCollections: string[]}|null>}
   */
  async showBatchDialog({ pdfIds, collections, projects }) {
    const dlg = this.#dialogUi
    dlg.docCount.textContent = String(pdfIds.length)
    dlg.collectionsList.innerHTML = ''

    /** @param {CollectionInfo[]} cols */
    const appendGroup = (cols) => {
      for (const col of cols) {
        this.#appendCollectionCheckbox(col.id, col.name)
      }
    }

    const headingStyle = 'font-weight: bold; padding: 0.5rem 0 0.15rem; font-size: 0.85em; text-transform: uppercase; color: var(--sl-color-neutral-500);'
    const renderedIds = new Set()
    for (const project of (projects || [])) {
      const projectCols = /** @type {CollectionInfo[]} */ (
        (project.collections || []).map(id => collections.find(c => c.id === id)).filter(Boolean)
      )
      if (projectCols.length === 0) continue
      const heading = document.createElement('div')
      heading.style.cssText = headingStyle
      heading.textContent = project.name
      dlg.collectionsList.appendChild(heading)
      appendGroup(projectCols)
      projectCols.forEach(c => renderedIds.add(c.id))
    }

    const orphans = collections.filter(c => !renderedIds.has(c.id))
    if (orphans.length > 0) {
      if (renderedIds.size > 0) {
        const heading = document.createElement('div')
        heading.style.cssText = headingStyle
        heading.textContent = 'No project'
        dlg.collectionsList.appendChild(heading)
      }
      appendGroup(orphans)
    }

    if (collections.length === 0) {
      const msg = document.createElement('p')
      msg.style.color = 'var(--sl-color-neutral-500)'
      msg.textContent = 'No collections available. Click "New" to create one.'
      dlg.collectionsList.appendChild(msg)
    }

    this.#updateButtonStates()

    const preventClose = (e) => e.preventDefault()
    dlg.addEventListener('sl-request-close', preventClose)

    /** @type {'move'|'copy'|null} */
    let action = null
    try {
      dlg.show()
      action = await new Promise((resolve, reject) => {
        dlg.moveBtn.addEventListener('click', () => resolve('move'), { once: true })
        dlg.copyBtn.addEventListener('click', () => resolve('copy'), { once: true })
        dlg.cancel.addEventListener('click', reject, { once: true })
      })
    } catch {
      this.#logger.info("User cancelled batch move/copy dialog")
      return null
    } finally {
      dlg.removeEventListener('sl-request-close', preventClose)
      dlg.hide()
    }

    const checkboxes = /** @type {SlCheckbox[]} */ ([
      ...dlg.collectionsList.querySelectorAll('sl-checkbox')
    ])
    const targetCollections = checkboxes
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.collectionId)
      .filter(id => Boolean(id))

    return { action, targetCollections }
  }
}

export default MoveFilesPlugin
export const plugin = MoveFilesPlugin

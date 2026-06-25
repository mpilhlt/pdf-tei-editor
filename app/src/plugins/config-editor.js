/**
 * Configuration Editor Plugin
 *
 * Provides a visual interface for editing application configuration values.
 * Only accessible to admin users.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { configEditorDialogPart } from '../templates/config-editor-dialog.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'
import { createValueEditor, createMaskedValueEditor, applyReadOnlyStyle } from '../modules/config-value-editor.js'

// Register templates
await registerTemplate('config-editor-dialog', 'config-editor-dialog.html')
await registerTemplate('config-editor-menu-item', 'config-editor-menu-item.html')

// Icons used in config-editor templates (needed for build system to include them)
// <sl-icon name="gear"></sl-icon>
// <sl-icon name="search"></sl-icon>
// <sl-icon name="check-circle"></sl-icon>
// <sl-icon name="arrow-counterclockwise"></sl-icon>
// <sl-icon name="pencil"></sl-icon>

class ConfigEditorPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'config-editor', deps: ['client', 'tools', 'logger'] })
  }

  get #logger() { return this.getDependency('logger') }

  /** @type {SlDialog & configEditorDialogPart} */
  #dialogUi = null

  /** @type {Record<string, any>} */
  #originalConfig = {}

  /** @type {Record<string, any>} */
  #modifiedConfig = {}

  /** @type {Set<string>} */
  #modifiedKeys = new Set()

  /** @type {string | null} */
  #editingKey = null

  /** @type {HTMLElement | null} */
  #menuItem = null

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.#logger.debug(`Installing plugin "config-editor"`)

    const dialog = createSingleFromTemplate('config-editor-dialog', document.body)
    this.#dialogUi = this.createUi(dialog)
    this.#setupDialogListeners()
  }

  async start() {
    this.#menuItem = createSingleFromTemplate('config-editor-menu-item')
    this.getDependency('tools').addMenuItems([this.#menuItem], 'administration')
    this.#menuItem.addEventListener('click', () => this.#openDialog())
    this.#menuItem.style.display = userIsAdmin(this.state.user) ? '' : 'none'
  }

  /**
   * @param {any} newUser
   */
  async onUserChange(newUser) {
    if (this.#menuItem) {
      this.#menuItem.style.display = userIsAdmin(newUser) ? '' : 'none'
    }
  }

  /** Set up dialog event listeners */
  #setupDialogListeners() {
    this.#dialogUi.closeBtn.addEventListener('click', () => this.#dialogUi.hide())
    this.#dialogUi.searchInput.addEventListener('input', () => this.#handleSearch())
  }

  /** Open the config editor dialog */
  async #openDialog() {
    try {
      await this.#loadConfig()
      this.#renderConfigList(this.#dialogUi.searchInput.value)
      this.#dialogUi.show()
    } catch (error) {
      this.#logger.error('Failed to open config editor:', String(error))
      notify('Failed to load configuration', 'danger', 'exclamation-octagon')
    }
  }

  /** Load configuration from API */
  async #loadConfig() {
    try {
      const response = await this.getDependency('client').apiClient.configList()
      this.#originalConfig = response || {}
      this.#modifiedConfig = JSON.parse(JSON.stringify(this.#originalConfig))
      this.#modifiedKeys.clear()
      this.#editingKey = null
    } catch (error) {
      this.#logger.error('Failed to load config:', error)
      throw error
    }
  }

  /**
   * Render the config list
   * @param {string} [filterText]
   */
  #renderConfigList(filterText = '') {
    const tbody = this.#dialogUi.configTable.configTableBody

    tbody.innerHTML = ''

    const configKeys = Object.keys(this.#originalConfig)
      .filter(key => !key.endsWith('.type') && !key.endsWith('.values') && !key.endsWith('.description') && !key.endsWith('.masked'))
      .filter(key => !filterText || (
        key.toLowerCase().includes(filterText.toLowerCase()) ||
        (this.#originalConfig[`${key}.description`] || '').toLowerCase().includes(filterText.toLowerCase())
      ))
      .sort()

    if (configKeys.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-500);">No configuration entries found</td></tr>'
      return
    }

    configKeys.forEach(key => {
      const row = this.#createConfigRow(key)
      tbody.appendChild(row)
    })
  }

  /**
   * Create a config table row
   * @param {string} key
   * @returns {HTMLTableRowElement}
   */
  #createConfigRow(key) {
    const value = this.#modifiedConfig[key]
    const isModified = this.#modifiedKeys.has(key)
    const isEditing = this.#editingKey === key

    const valuesKey = `${key}.values`
    const allowedValues = this.#originalConfig[valuesKey]

    const row = document.createElement('tr')
    row.dataset.key = key
    row.style.cssText = `
      border-bottom: 1px solid var(--sl-color-neutral-200);
      background: ${isModified ? 'var(--sl-color-warning-50)' : 'white'};
    `
    row.addEventListener('mouseenter', () => {
      if (!isModified) row.style.background = 'var(--sl-color-neutral-50)'
    })
    row.addEventListener('mouseleave', () => {
      if (!isModified) row.style.background = 'white'
    })

    const nameCell = document.createElement('td')
    nameCell.style.cssText = 'padding: 0.5rem; font-family: monospace; font-size: 0.85em; word-break: break-word;'
    nameCell.textContent = key
    row.appendChild(nameCell)

    const descriptionCell = document.createElement('td')
    descriptionCell.style.cssText = 'padding: 0.5rem; font-size: 0.8em; color: var(--sl-color-neutral-600); white-space: normal; word-wrap: break-word; vertical-align: top; max-width: 200px;'
    descriptionCell.textContent = this.#originalConfig[`${key}.description`] || ''
    row.appendChild(descriptionCell)

    const valueCell = document.createElement('td')
    valueCell.style.cssText = 'padding: 0.5rem;'
    const isReadOnly = !isEditing && !isModified
    const { container, setReadOnly } = this.#createValueEditor(key, value, allowedValues, isReadOnly)
    valueCell.appendChild(container)
    if (setReadOnly) {
      requestAnimationFrame(() => setReadOnly(isReadOnly))
    }
    valueCell.addEventListener('dblclick', () => {
      if (!isEditing && !isModified) {
        this.#enableEditing(key)
      }
    })
    row.appendChild(valueCell)

    const actionsCell = document.createElement('td')
    actionsCell.style.cssText = 'padding: 0.5rem; text-align: center;'

    const editBtn = document.createElement('sl-icon-button')
    if (isEditing || isModified) {
      editBtn.setAttribute('name', 'check-circle')
      editBtn.setAttribute('label', 'Save')
      editBtn.style.cssText = 'color: var(--sl-color-success-600);'
      editBtn.addEventListener('click', () => this.#saveValue(key))
    } else {
      editBtn.setAttribute('name', 'pencil')
      editBtn.setAttribute('label', 'Edit')
      editBtn.addEventListener('click', () => this.#enableEditing(key))
    }
    actionsCell.appendChild(editBtn)

    if (isModified || isEditing) {
      const resetBtn = document.createElement('sl-icon-button')
      resetBtn.setAttribute('name', 'arrow-counterclockwise')
      resetBtn.setAttribute('label', 'Reset')
      resetBtn.addEventListener('click', () => this.#resetValue(key))
      actionsCell.appendChild(resetBtn)
    }

    row.appendChild(actionsCell)

    return row
  }

  /**
   * Create value editor based on type and constraints.
   * Uses a password-style input for masked keys.
   * @param {string} key
   * @param {any} value
   * @param {any[] | undefined} allowedValues
   * @param {boolean} isReadOnly
   * @returns {{container: HTMLElement, setReadOnly?: (readonly: boolean) => void}}
   */
  #createValueEditor(key, value, allowedValues, isReadOnly = true) {
    const isMasked = this.#originalConfig[`${key}.masked`] === true
    if (isMasked) {
      return createMaskedValueEditor(key, value, isReadOnly, (k, v) => this.#handleValueChange(k, v))
    }
    return createValueEditor(
      key, value, allowedValues, isReadOnly,
      (k, v) => this.#handleValueChange(k, v)
    )
  }

  /**
   * @param {string} key
   * @param {any} newValue
   */
  #handleValueChange(key, newValue) {
    this.#modifiedConfig[key] = newValue

    if (JSON.stringify(newValue) !== JSON.stringify(this.#originalConfig[key])) {
      this.#modifiedKeys.add(key)
    } else {
      this.#modifiedKeys.delete(key)
    }

    this.#updateRowState(key)
  }

  /**
   * @param {string} key
   */
  #updateRowState(key) {
    const tbody = this.#dialogUi.configTable.configTableBody
    const row = tbody.querySelector(`tr[data-key="${CSS.escape(key)}"]`)
    if (!row) return

    const isModified = this.#modifiedKeys.has(key)
    row.style.background = isModified ? 'var(--sl-color-warning-50)' : 'white'
  }

  /**
   * @param {string} key
   */
  async #saveValue(key) {
    try {
      let valueToSave = this.#modifiedConfig[key]

      if (valueToSave === '****') {
        notify(`Cannot save placeholder value for ${key}`, 'warning', 'exclamation-triangle')
        return
      }

      const originalType = typeof this.#originalConfig[key]
      if (originalType === 'object' && typeof valueToSave === 'string') {
        try {
          valueToSave = JSON.parse(valueToSave)
        } catch (e) {
          notify(`Invalid JSON for ${key}: ${e.message}`, 'danger', 'exclamation-octagon')
          return
        }
      }

      await this.getDependency('client').apiClient.configSet({ key, value: valueToSave })

      this.#originalConfig[key] = valueToSave
      this.#modifiedConfig[key] = valueToSave
      this.#modifiedKeys.delete(key)
      this.#editingKey = null

      notify(`Saved ${key}`, 'success', 'check-circle')
      this.#renderConfigList(this.#dialogUi.searchInput.value)
    } catch (error) {
      this.#logger.error('Failed to save config value:', error)
      notify(`Failed to save ${key}`, 'danger', 'exclamation-octagon')
    }
  }

  /**
   * @param {string} key
   */
  #resetValue(key) {
    this.#modifiedConfig[key] = this.#originalConfig[key]
    this.#modifiedKeys.delete(key)
    this.#editingKey = null
    this.#renderConfigList(this.#dialogUi.searchInput.value)
  }

  /**
   * @param {string} key
   */
  #enableEditing(key) {
    this.#editingKey = key
    this.#renderConfigList(this.#dialogUi.searchInput.value)
  }

  #handleSearch() {
    const filterText = this.#dialogUi.searchInput.value
    this.#renderConfigList(filterText)
  }

  /**
   * @param {HTMLElement} element
   * @param {boolean} readonly
   */
  #applyReadOnlyStyle(element, readonly) {
    applyReadOnlyStyle(element, readonly)
  }
}

export default ConfigEditorPlugin

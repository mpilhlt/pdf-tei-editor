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
      this.#renderConfigList()
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
      .filter(key => !key.endsWith('.type') && !key.endsWith('.values'))
      .filter(key => !filterText || key.toLowerCase().includes(filterText.toLowerCase()))
      .sort()

    if (configKeys.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-500);">No configuration entries found</td></tr>'
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
   * Create value editor based on type and constraints
   * @param {string} key
   * @param {any} value
   * @param {any[] | undefined} allowedValues
   * @param {boolean} isReadOnly
   * @returns {{container: HTMLElement, setReadOnly?: (readonly: boolean) => void}}
   */
  #createValueEditor(key, value, allowedValues, isReadOnly = true) {
    const container = document.createElement('div')
    container.style.width = '100%'

    if (allowedValues && Array.isArray(allowedValues)) {
      const select = document.createElement('sl-select')
      select.setAttribute('size', 'small')
      select.value = value
      select.disabled = isReadOnly

      allowedValues.forEach(val => {
        const option = document.createElement('sl-option')
        option.value = val
        option.textContent = val
        select.appendChild(option)
      })

      if (!isReadOnly) {
        select.addEventListener('sl-change', () => {
          this.#handleValueChange(key, select.value)
        })
      }

      container.appendChild(select)
      return {
        container,
        setReadOnly: (readonly) => { select.disabled = readonly }
      }
    }

    const actualType = typeof value

    if (actualType === 'boolean') {
      const checkbox = document.createElement('sl-checkbox')
      checkbox.checked = Boolean(value)
      checkbox.disabled = isReadOnly
      if (!isReadOnly) {
        checkbox.addEventListener('sl-change', () => {
          this.#handleValueChange(key, checkbox.checked)
        })
      }
      container.appendChild(checkbox)
      return {
        container,
        setReadOnly: (readonly) => { checkbox.disabled = readonly }
      }
    } else if (actualType === 'number') {
      const input = document.createElement('sl-input')
      input.setAttribute('type', 'number')
      input.setAttribute('size', 'small')
      input.value = value != null ? String(value) : ''
      if (!isReadOnly) {
        input.addEventListener('sl-input', () => {
          const numValue = parseFloat(input.value)
          this.#handleValueChange(key, isNaN(numValue) ? null : numValue)
        })
      }
      container.appendChild(input)
      return {
        container,
        setReadOnly: (readonly) => {
          input.readonly = readonly
          this.#applyReadOnlyStyle(input, readonly)
        }
      }
    } else if (this.#isStringArray(value)) {
      const input = document.createElement('sl-input')
      input.setAttribute('size', 'small')
      input.value = this.#arrayToCommaSeparated(value)
      input.style.fontFamily = 'monospace'
      if (!isReadOnly) {
        input.addEventListener('sl-input', () => {
          try {
            const parsed = this.#commaSeparatedToArray(input.value)
            this.#handleValueChange(key, parsed)
          } catch (e) {
            this.#logger.error('Failed to parse array:', e)
          }
        })
      }
      container.appendChild(input)
      return {
        container,
        setReadOnly: (readonly) => {
          input.readonly = readonly
          this.#applyReadOnlyStyle(input, readonly)
        }
      }
    } else if (actualType === 'object') {
      const input = document.createElement('sl-input')
      input.setAttribute('size', 'small')
      input.value = JSON.stringify(value)
      input.style.fontFamily = 'monospace'
      if (!isReadOnly) {
        input.addEventListener('sl-input', () => {
          this.#handleValueChange(key, input.value)
        })
      }
      container.appendChild(input)
      return {
        container,
        setReadOnly: (readonly) => {
          input.readonly = readonly
          this.#applyReadOnlyStyle(input, readonly)
        }
      }
    } else {
      const input = document.createElement('sl-input')
      input.setAttribute('size', 'small')
      input.value = value != null ? String(value) : ''
      if (!isReadOnly) {
        input.addEventListener('sl-input', () => {
          this.#handleValueChange(key, input.value)
        })
      }
      container.appendChild(input)
      return {
        container,
        setReadOnly: (readonly) => {
          input.readonly = readonly
          this.#applyReadOnlyStyle(input, readonly)
        }
      }
    }
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

  // --- Utility helpers ---

  /**
   * @param {any[]} arr
   * @returns {string}
   */
  #arrayToCommaSeparated(arr) {
    return arr.map(item => {
      const str = String(item)
      if (str.includes(' ') || str.includes(',')) {
        return `"${str.replace(/"/g, '\\"')}"`
      }
      return str
    }).join(', ')
  }

  /**
   * @param {string} str
   * @returns {any[]}
   */
  #commaSeparatedToArray(str) {
    const items = []
    let current = ''
    let inQuotes = false
    let escaped = false

    for (let i = 0; i < str.length; i++) {
      const char = str[i]
      if (escaped) { current += char; escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') { inQuotes = !inQuotes; continue }
      if (char === ',' && !inQuotes) {
        if (current.trim()) items.push(current.trim())
        current = ''
        continue
      }
      current += char
    }

    if (current.trim()) items.push(current.trim())
    return items
  }

  /**
   * @param {any} value
   * @returns {boolean}
   */
  #isStringArray(value) {
    return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')
  }

  /**
   * @param {HTMLElement} element
   * @param {boolean} readonly
   */
  #applyReadOnlyStyle(element, readonly) {
    if (readonly) {
      element.style.setProperty('--sl-input-border-width', '0')
      element.style.setProperty('--sl-input-border-color', 'transparent')
      element.style.setProperty('--sl-input-border-color-hover', 'transparent')
      element.style.setProperty('--sl-input-border-color-focus', 'transparent')
      element.style.setProperty('--sl-input-background-color', 'transparent')
      element.style.setProperty('--sl-input-background-color-hover', 'transparent')
      element.style.setProperty('--sl-input-background-color-focus', 'transparent')
      element.style.setProperty('--sl-focus-ring-width', '0')
      element.style.setProperty('--sl-focus-ring-color', 'transparent')
      element.style.setProperty('--sl-input-focus-ring-width', '0')
      element.style.setProperty('--sl-input-focus-ring-color', 'transparent')
      element.style.cursor = 'default'
      element.style.pointerEvents = 'none'
    } else {
      element.style.removeProperty('--sl-input-border-width')
      element.style.removeProperty('--sl-input-border-color')
      element.style.removeProperty('--sl-input-border-color-hover')
      element.style.removeProperty('--sl-input-border-color-focus')
      element.style.removeProperty('--sl-input-background-color')
      element.style.removeProperty('--sl-input-background-color-hover')
      element.style.removeProperty('--sl-input-background-color-focus')
      element.style.removeProperty('--sl-focus-ring-width')
      element.style.removeProperty('--sl-focus-ring-color')
      element.style.removeProperty('--sl-input-focus-ring-width')
      element.style.removeProperty('--sl-input-focus-ring-color')
      element.style.cursor = ''
      element.style.pointerEvents = ''
    }
  }
}

export default ConfigEditorPlugin

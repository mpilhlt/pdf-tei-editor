/**
 * Configuration Editor Plugin
 *
 * Provides a visual interface for editing application configuration values.
 * Only accessible to admin users.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton, SlDialog, SlInput } from '../ui.js'
 */

import ui, { updateUi } from '../ui.js'
import { logger, client } from '../app.js'
import { registerTemplate, createSingleFromTemplate, createFromTemplate } from '../modules/ui-system.js'
import { userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'

/**
 * Configuration Editor dialog structure
 * @typedef {object} configEditorDialogPart
 * @property {SlInput} searchInput - Search/filter input
 * @property {HTMLTableElement} configTable - Config table element
 * @property {HTMLTableSectionElement} configTableBody - Table body for config entries
 * @property {SlButton} closeBtn - Close dialog button
 */

const plugin = {
  name: 'config-editor',
  install,
  state: { update },
  deps: ['client', 'toolbar']
}

export { plugin }
export default plugin

// Register templates
await registerTemplate('config-editor-dialog', 'config-editor-dialog.html')
await registerTemplate('config-editor-menu-item', 'config-editor-menu-item.html')

// Icons used in config-editor templates (needed for build system to include them)
// <sl-icon name="gear"></sl-icon>
// <sl-icon name="search"></sl-icon>
// <sl-icon name="check-circle"></sl-icon>
// <sl-icon name="arrow-counterclockwise"></sl-icon>
// <sl-icon name="pencil"></sl-icon>

// Plugin state
/** @type {Record<string, any>} Original config data */
let originalConfig = {}

/** @type {Record<string, any>} Current modified config data */
let modifiedConfig = {}

/** @type {Set<string>} Set of modified keys */
let modifiedKeys = new Set()

/** @type {string | null} Key currently being edited */
let editingKey = null

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create UI elements
  createSingleFromTemplate('config-editor-dialog', document.body)
  createFromTemplate('config-editor-menu-item', ui.toolbar.toolbarMenu.menu)

  updateUi()

  logger.debug('Config editor menu item added to toolbar menu')

  // Set up event listeners
  setupEventListeners()

  // Initially hide menu item until we check admin status
  ui.toolbar.toolbarMenu.menu.configEditorMenuItem.style.display = 'none'
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  // Only admins can access config editor - hide menu item for non-admins
  const isAdmin = userIsAdmin(state.user)
  if (ui.toolbar?.toolbarMenu?.menu?.configEditorMenuItem) {
    ui.toolbar.toolbarMenu.menu.configEditorMenuItem.style.display = isAdmin ? '' : 'none'
  }
}

/**
 * Set up all event listeners
 */
function setupEventListeners() {
  logger.debug('Setting up event listeners for config editor')

  // Check if menu item exists
  if (!ui.toolbar?.toolbarMenu?.menu?.configEditorMenuItem) {
    logger.error('Config editor menu item not found in UI')
    return
  }

  // Open dialog menu item
  ui.toolbar.toolbarMenu.menu.configEditorMenuItem.addEventListener('click', openDialog)
  logger.debug('Added click listener to config editor menu item')

  /** @type {configEditorDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.configEditorDialog)

  if (!dialog) {
    logger.error('Config editor dialog not found in UI')
    return
  }

  // Close dialog
  dialog.closeBtn.addEventListener('click', () => dialog.hide())

  // Search input
  dialog.searchInput.addEventListener('input', handleSearch)

  logger.debug('Config editor event listeners set up successfully')
}

/**
 * Open the config editor dialog
 */
async function openDialog() {
  /** @type {configEditorDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.configEditorDialog)

  try {
    logger.debug('Opening config editor dialog...')

    // Load config data
    logger.debug('Loading config...')
    await loadConfig()
    logger.debug('Config loaded successfully')

    // Render config entries
    logger.debug('Rendering config list...')
    renderConfigList()
    logger.debug('Config list rendered')

    // Show dialog
    logger.debug('Showing dialog...')
    dialog.show()
  } catch (error) {
    logger.error('Failed to open config editor')
    logger.error('Error type:', typeof error)
    logger.error('Error toString:', String(error))
    logger.error('Error JSON:', JSON.stringify(error, null, 2))
    console.error('Raw error object:', error)
    notify('Failed to load configuration', 'danger', 'exclamation-octagon')
  }
}

/**
 * Load configuration from API
 */
async function loadConfig() {
  try {
    const response = await client.apiClient.configList()
    originalConfig = response || {}
    modifiedConfig = JSON.parse(JSON.stringify(originalConfig))
    modifiedKeys.clear()
    editingKey = null
    logger.debug('Loaded config:', originalConfig)
  } catch (error) {
    logger.error('Failed to load config:', error)
    throw error
  }
}

/**
 * Render the config list
 * @param {string} [filterText] - Optional filter text
 */
function renderConfigList(filterText = '') {
  /** @type {configEditorDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.configEditorDialog)

  // Access tbody through querySelector since it's nested
  const tbody = dialog.querySelector('[name="configTableBody"]')
  if (!tbody) {
    logger.error('Config table body not found')
    return
  }

  // Clear existing content
  tbody.innerHTML = ''

  // Get all config keys, excluding metadata keys and filtering by search
  const configKeys = Object.keys(originalConfig)
    .filter(key => !key.endsWith('.type') && !key.endsWith('.values'))
    .filter(key => !filterText || key.toLowerCase().includes(filterText.toLowerCase()))
    .sort()

  if (configKeys.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="padding: 2rem; text-align: center; color: var(--sl-color-neutral-500);">No configuration entries found</td></tr>'
    return
  }

  // Create config entry for each key
  configKeys.forEach(key => {
    const row = createConfigRow(key)
    tbody.appendChild(row)
  })
}

/**
 * Create a config table row
 * @param {string} key - Config key
 * @returns {HTMLTableRowElement}
 */
function createConfigRow(key) {
  const value = modifiedConfig[key]
  const originalValue = originalConfig[key]
  const isModified = modifiedKeys.has(key)
  const isEditing = editingKey === key

  // Check for constraints
  const valuesKey = `${key}.values`
  const allowedValues = originalConfig[valuesKey]

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

  // Preference name cell
  const nameCell = document.createElement('td')
  nameCell.style.cssText = 'padding: 0.5rem; font-family: monospace; font-size: 0.85em; word-break: break-word;'
  nameCell.textContent = key
  row.appendChild(nameCell)

  // Value cell
  const valueCell = document.createElement('td')
  valueCell.style.cssText = 'padding: 0.5rem;'
  const isReadOnly = !isEditing && !isModified
  const { container, setReadOnly } = createValueEditor(key, value, allowedValues, isReadOnly)
  valueCell.appendChild(container)
  // Set readonly after appending to DOM for Shoelace components
  if (setReadOnly) {
    requestAnimationFrame(() => setReadOnly(isReadOnly))
  }
  // Double-click to enable editing
  valueCell.addEventListener('dblclick', () => {
    if (!isEditing && !isModified) {
      enableEditing(key)
    }
  })
  row.appendChild(valueCell)

  // Actions cell
  const actionsCell = document.createElement('td')
  actionsCell.style.cssText = 'padding: 0.5rem; text-align: center;'

  // Edit/Save button
  const editBtn = document.createElement('sl-icon-button')
  if (isEditing || isModified) {
    editBtn.setAttribute('name', 'check-circle')
    editBtn.setAttribute('label', 'Save')
    editBtn.style.cssText = 'color: var(--sl-color-success-600);'
    editBtn.addEventListener('click', () => saveValue(key))
  } else {
    editBtn.setAttribute('name', 'pencil')
    editBtn.setAttribute('label', 'Edit')
    editBtn.addEventListener('click', () => enableEditing(key))
  }
  actionsCell.appendChild(editBtn)

  // Reset button (only show if modified or editing)
  if (isModified || isEditing) {
    const resetBtn = document.createElement('sl-icon-button')
    resetBtn.setAttribute('name', 'arrow-counterclockwise')
    resetBtn.setAttribute('label', 'Reset')
    resetBtn.addEventListener('click', () => resetValue(key))
    actionsCell.appendChild(resetBtn)
  }

  row.appendChild(actionsCell)

  return row
}

/**
 * Convert array of strings to comma-separated string (quote if needed)
 * @param {any[]} arr - Array to convert
 * @returns {string}
 */
function arrayToCommaSeparated(arr) {
  return arr.map(item => {
    const str = String(item)
    // Quote if contains space or comma
    if (str.includes(' ') || str.includes(',')) {
      return `"${str.replace(/"/g, '\\"')}"`
    }
    return str
  }).join(', ')
}

/**
 * Parse comma-separated string to array (handle quotes)
 * @param {string} str - String to parse
 * @returns {any[]}
 */
function commaSeparatedToArray(str) {
  const items = []
  let current = ''
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < str.length; i++) {
    const char = str[i]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (char === ',' && !inQuotes) {
      if (current.trim()) {
        items.push(current.trim())
      }
      current = ''
      continue
    }

    current += char
  }

  if (current.trim()) {
    items.push(current.trim())
  }

  return items
}

/**
 * Check if array contains only strings
 * @param {any} value - Value to check
 * @returns {boolean}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')
}

/**
 * Apply borderless styling to read-only inputs
 * @param {HTMLElement} element - Input element
 * @param {boolean} readonly - Whether the input is read-only
 */
function applyReadOnlyStyle(element, readonly) {
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

/**
 * Create value editor based on type and constraints
 * @param {string} key - Config key
 * @param {any} value - Current value
 * @param {any[] | undefined} allowedValues - Allowed values (if constrained)
 * @param {boolean} isReadOnly - Whether the editor should be read-only
 * @returns {{container: HTMLElement, setReadOnly?: (readonly: boolean) => void}}
 */
function createValueEditor(key, value, allowedValues, isReadOnly = true) {
  const container = document.createElement('div')
  container.style.width = '100%'

  // If there are allowed values, use a select
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
        handleValueChange(key, select.value)
      })
    }

    container.appendChild(select)
    return {
      container,
      setReadOnly: (readonly) => {
        select.disabled = readonly
      }
    }
  }

  // Determine editor based on value type
  const actualType = typeof value

  if (actualType === 'boolean') {
    const checkbox = document.createElement('sl-checkbox')
    checkbox.checked = Boolean(value)
    checkbox.disabled = isReadOnly
    if (!isReadOnly) {
      checkbox.addEventListener('sl-change', () => {
        handleValueChange(key, checkbox.checked)
      })
    }
    container.appendChild(checkbox)
    return {
      container,
      setReadOnly: (readonly) => {
        checkbox.disabled = readonly
      }
    }
  } else if (actualType === 'number') {
    const input = document.createElement('sl-input')
    input.setAttribute('type', 'number')
    input.setAttribute('size', 'small')
    input.value = value != null ? String(value) : ''
    if (!isReadOnly) {
      input.addEventListener('sl-input', () => {
        const numValue = parseFloat(input.value)
        handleValueChange(key, isNaN(numValue) ? null : numValue)
      })
    }
    container.appendChild(input)
    return {
      container,
      setReadOnly: (readonly) => {
        input.readonly = readonly
        applyReadOnlyStyle(input, readonly)
      }
    }
  } else if (isStringArray(value)) {
    // Array of strings - use comma-separated input
    const input = document.createElement('sl-input')
    input.setAttribute('size', 'small')
    input.value = arrayToCommaSeparated(value)
    input.style.fontFamily = 'monospace'
    if (!isReadOnly) {
      input.addEventListener('sl-input', () => {
        try {
          const parsed = commaSeparatedToArray(input.value)
          handleValueChange(key, parsed)
        } catch (e) {
          logger.error('Failed to parse array:', e)
        }
      })
    }
    container.appendChild(input)
    return {
      container,
      setReadOnly: (readonly) => {
        input.readonly = readonly
        applyReadOnlyStyle(input, readonly)
      }
    }
  } else if (actualType === 'object') {
    // Objects (including non-string arrays) - editable JSON with validation
    const input = document.createElement('sl-input')
    input.setAttribute('size', 'small')
    input.value = JSON.stringify(value)
    input.style.fontFamily = 'monospace'
    if (!isReadOnly) {
      input.addEventListener('sl-input', () => {
        handleValueChange(key, input.value) // Store as string, validate on save
      })
    }
    container.appendChild(input)
    return {
      container,
      setReadOnly: (readonly) => {
        input.readonly = readonly
        applyReadOnlyStyle(input, readonly)
      }
    }
  } else {
    // Default to text input
    const input = document.createElement('sl-input')
    input.setAttribute('size', 'small')
    input.value = value != null ? String(value) : ''
    if (!isReadOnly) {
      input.addEventListener('sl-input', () => {
        handleValueChange(key, input.value)
      })
    }
    container.appendChild(input)
    return {
      container,
      setReadOnly: (readonly) => {
        input.readonly = readonly
        applyReadOnlyStyle(input, readonly)
      }
    }
  }
}

/**
 * Handle value change
 * @param {string} key - Config key
 * @param {any} newValue - New value
 */
function handleValueChange(key, newValue) {
  modifiedConfig[key] = newValue

  // Check if value differs from original
  if (JSON.stringify(newValue) !== JSON.stringify(originalConfig[key])) {
    modifiedKeys.add(key)
  } else {
    modifiedKeys.delete(key)
  }

  // Don't re-render while editing - just update the modified state
  // Re-rendering would cause focus loss
  updateRowState(key)
}

/**
 * Update the visual state of a row without re-rendering the entire list
 * @param {string} key - Config key
 */
function updateRowState(key) {
  const dialog = ui.configEditorDialog
  const tbody = dialog.querySelector('[name="configTableBody"]')
  if (!tbody) return

  const row = tbody.querySelector(`tr[data-key="${CSS.escape(key)}"]`)
  if (!row) return

  const isModified = modifiedKeys.has(key)

  // Update background color
  row.style.background = isModified ? 'var(--sl-color-warning-50)' : 'white'
}

/**
 * Save a single value
 * @param {string} key - Config key
 */
async function saveValue(key) {
  try {
    let valueToSave = modifiedConfig[key]

    // If original value was an object and current value is a string, validate and parse JSON
    const originalType = typeof originalConfig[key]
    if (originalType === 'object' && typeof valueToSave === 'string') {
      try {
        valueToSave = JSON.parse(valueToSave)
      } catch (e) {
        notify(`Invalid JSON for ${key}: ${e.message}`, 'danger', 'exclamation-octagon')
        return
      }
    }

    await client.apiClient.configSet({
      key,
      value: valueToSave
    })

    // Update original and modified config with saved value
    originalConfig[key] = valueToSave
    modifiedConfig[key] = valueToSave
    modifiedKeys.delete(key)
    editingKey = null

    notify(`Saved ${key}`, 'success', 'check-circle')
    renderConfigList(ui.configEditorDialog.searchInput.value)
  } catch (error) {
    logger.error('Failed to save config value:', error)
    notify(`Failed to save ${key}`, 'danger', 'exclamation-octagon')
  }
}

/**
 * Reset a single value to original
 * @param {string} key - Config key
 */
function resetValue(key) {
  modifiedConfig[key] = originalConfig[key]
  modifiedKeys.delete(key)
  editingKey = null
  renderConfigList(ui.configEditorDialog.searchInput.value)
}

/**
 * Enable editing for a config entry
 * @param {string} key - Config key
 */
function enableEditing(key) {
  editingKey = key
  renderConfigList(ui.configEditorDialog.searchInput.value)
}

/**
 * Handle search input
 */
function handleSearch() {
  const filterText = ui.configEditorDialog.searchInput.value
  renderConfigList(filterText)
}

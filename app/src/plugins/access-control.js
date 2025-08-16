/**
 * Access Control plugin
 * 
 * Manages document access permissions and provides UI for changing document status.
 * Integrates with xmleditor plugin to enforce read-only state based on permissions.
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { UIPart } from '../ui.js'
 * @import { StatusBar } from '../modules/panels/status-bar.js'
 */

import ui, { updateUi } from '../ui.js'
import { services } from '../app.js'
import { PanelUtils } from '../modules/panels/index.js'
import { api as logger } from './logger.js'
import { xmlEditor } from './xmleditor.js'

/**
 * Access control statusbar navigation properties
 * @typedef {object} accessControlStatusbarPart
 * @property {HTMLElement} statusDropdown - The status dropdown widget
 * @property {HTMLElement} permissionInfo - Permission information display
 */

/**
 * Access control navigation properties  
 * @typedef {object} accessControlPart
 * @property {UIPart<StatusBar, accessControlStatusbarPart>} statusbar - The access control statusbar widgets
 */

// Status widgets for access control
let statusDropdownWidget = null
let permissionInfoWidget = null
let statusSeparator = null

// Current document permissions cache
let currentPermissions = {
    visibility: 'public',
    editability: 'editable', 
    owner: null,
    can_modify: false
}

/**
 * Access control plugin
 */
const plugin = {
  name: "access-control",
  install,
  start,
  state: {
    update
  }
}

/**
 * Access control API
 */
const api = {
  getDocumentPermissions: () => currentPermissions,
  canEditDocument,
  canViewDocument,
  updateDocumentStatus
}

export { plugin, api }
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  
  // Create permission info widget
  /** @type {StatusText} */
  permissionInfoWidget = PanelUtils.createText({
    text: '',
    variant: 'neutral'
  })
  
  // Create status dropdown widget 
  statusDropdownWidget = createStatusDropdown()
  
  // Create separator
  statusSeparator = PanelUtils.createSeparator({
    variant: 'dotted'
  })
  
  // Add widgets to left side of statusbar (lower priority = more to the left)
  ui.xmlEditor.statusbar.add(permissionInfoWidget, 'left', 1)
  ui.xmlEditor.statusbar.add(statusSeparator, 'left', 2) 
  ui.xmlEditor.statusbar.add(statusDropdownWidget, 'left', 3)
  
  // Initially hide widgets until document is loaded
  hideAccessControlWidgets()
}

/**
 * Runs after all plugins are installed
 * @param {ApplicationState} state
 */
async function start(state) {
  logger.debug(`Starting plugin "${plugin.name}"`)
}

/**
 * Called when application state changes
 * @param {ApplicationState} state
 */
async function update(state) {
  // Only show access control widgets when a document is loaded
  if (!state.xml || !state.filePath) {
    hideAccessControlWidgets()
    return
  }
  
  // Fetch current document permissions
  await fetchDocumentPermissions(state.filePath)
  
  // Update UI based on permissions
  updateAccessControlUI()
  
  // Check if document should be read-only based on permissions
  const shouldBeReadOnly = !canEditDocument(state.user)
  if (shouldBeReadOnly !== state.editorReadOnly) {
    // Update application state to reflect access control
    logger.debug(`Setting editor read-only based on access control: ${shouldBeReadOnly}`)
    // Note: This will trigger xmleditor plugin to update editor state
    Object.assign(state, { editorReadOnly: shouldBeReadOnly })
  }
}

/**
 * Creates the status dropdown widget
 */
function createStatusDropdown() {
  const dropdown = document.createElement('sl-dropdown')
  dropdown.setAttribute('name', 'access-status-dropdown')
  
  const trigger = document.createElement('sl-button')
  trigger.setAttribute('slot', 'trigger')
  trigger.setAttribute('size', 'small')
  trigger.setAttribute('variant', 'default')
  trigger.setAttribute('caret', 'true')
  trigger.textContent = 'Public'
  
  const menu = document.createElement('sl-menu')
  
  // Create menu items for different permission combinations
  const permissionOptions = [
    { value: 'public-editable', label: 'Public & Editable', visibility: 'public', editability: 'editable' },
    { value: 'public-protected', label: 'Public & Protected', visibility: 'public', editability: 'protected' },
    { value: 'private-editable', label: 'Private & Editable', visibility: 'private', editability: 'editable' },
    { value: 'private-protected', label: 'Private & Protected', visibility: 'private', editability: 'protected' }
  ]
  
  permissionOptions.forEach(option => {
    const item = document.createElement('sl-menu-item')
    item.setAttribute('value', option.value)
    item.textContent = option.label
    item.dataset.visibility = option.visibility
    item.dataset.editability = option.editability
    menu.appendChild(item)
  })
  
  dropdown.appendChild(trigger)
  dropdown.appendChild(menu)
  
  // Handle selection changes
  dropdown.addEventListener('sl-select', handleStatusChange)
  
  return dropdown
}

/**
 * Handles status dropdown selection changes
 * @param {CustomEvent} event
 */
async function handleStatusChange(event) {
  const selectedItem = event.detail.item
  const newVisibility = selectedItem.dataset.visibility
  const newEditability = selectedItem.dataset.editability
  
  try {
    await updateDocumentStatus(newVisibility, newEditability)
    logger.info(`Document status updated: ${newVisibility} ${newEditability}`)
  } catch (error) {
    logger.error(`Failed to update document status: ${error.message}`)
    // Revert dropdown to previous state
    updateStatusDropdownDisplay()
  }
}

/**
 * Fetches document permissions from the server
 * @param {string} filePath
 */
async function fetchDocumentPermissions(filePath) {
  try {
    const response = await fetch(`/api/files/permissions/${encodeURIComponent(filePath)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'same-origin'
    })
    
    if (response.ok) {
      const permissions = await response.json()
      currentPermissions = permissions
      logger.debug('Fetched document permissions:', permissions)
    } else {
      logger.warn(`Could not fetch permissions for ${filePath}: ${response.status}`)
      // Use defaults
      currentPermissions = {
        visibility: 'public',
        editability: 'editable',
        owner: null,
        can_modify: false
      }
    }
  } catch (error) {
    logger.error(`Error fetching document permissions: ${error.message}`)
    // Use defaults on error
    currentPermissions = {
      visibility: 'public', 
      editability: 'editable',
      owner: null,
      can_modify: false
    }
  }
}

/**
 * Updates document status via API
 * @param {string} visibility - 'public' or 'private'
 * @param {string} editability - 'editable' or 'protected'
 * @param {string} [owner] - Optional new owner
 * @param {string} [description] - Optional change description
 */
async function updateDocumentStatus(visibility, editability, owner, description) {
  const filePath = ui.toolbar.xml.value
  if (!filePath) {
    throw new Error('No document loaded')
  }
  
  const requestData = {
    visibility,
    editability
  }
  
  if (owner !== undefined) {
    requestData.owner = owner
  }
  
  if (description) {
    requestData.description = description
  }
  
  const response = await fetch(`/api/files/permissions/${encodeURIComponent(filePath)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'same-origin',
    body: JSON.stringify(requestData)
  })
  
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || `HTTP ${response.status}`)
  }
  
  const result = await response.json()
  
  // Update cached permissions
  currentPermissions.visibility = result.visibility
  currentPermissions.editability = result.editability
  currentPermissions.owner = result.owner
  
  // Update UI
  updateAccessControlUI()
  
  return result
}

/**
 * Updates the access control UI widgets
 */
function updateAccessControlUI() {
  showAccessControlWidgets()
  updatePermissionInfoDisplay()
  updateStatusDropdownDisplay()
  updateStatusDropdownVisibility()
}

/**
 * Updates the permission info text display
 */
function updatePermissionInfoDisplay() {
  if (!permissionInfoWidget) return
  
  const { visibility, editability, owner } = currentPermissions
  
  let infoText = ''
  let variant = 'neutral'
  
  if (visibility === 'private') {
    infoText = owner ? `Private (${owner})` : 'Private'
    variant = 'warning'
  } else {
    infoText = 'Public'
  }
  
  if (editability === 'protected') {
    infoText += ' • Protected'
    variant = 'warning'
  }
  
  permissionInfoWidget.text = infoText
  permissionInfoWidget.variant = variant
}

/**
 * Updates the status dropdown display
 */
function updateStatusDropdownDisplay() {
  if (!statusDropdownWidget) return
  
  const trigger = statusDropdownWidget.querySelector('sl-button')
  const { visibility, editability } = currentPermissions
  
  // Set button text based on current permissions
  let buttonText = 'Unknown'
  if (visibility === 'public' && editability === 'editable') {
    buttonText = 'Public'
  } else if (visibility === 'public' && editability === 'protected') {
    buttonText = 'Public • Protected'  
  } else if (visibility === 'private' && editability === 'editable') {
    buttonText = 'Private'
  } else if (visibility === 'private' && editability === 'protected') {
    buttonText = 'Private • Protected'
  }
  
  trigger.textContent = buttonText
  
  // Update selected menu item
  const currentValue = `${visibility}-${editability}`
  const menuItems = statusDropdownWidget.querySelectorAll('sl-menu-item')
  menuItems.forEach(item => {
    item.checked = item.getAttribute('value') === currentValue
  })
}

/**
 * Shows or hides the status dropdown based on user permissions
 */
function updateStatusDropdownVisibility() {
  if (!statusDropdownWidget) return
  
  if (currentPermissions.can_modify) {
    statusDropdownWidget.style.display = ''
    statusSeparator.style.display = ''
  } else {
    statusDropdownWidget.style.display = 'none'
    statusSeparator.style.display = 'none'
  }
}

/**
 * Shows access control widgets
 */
function showAccessControlWidgets() {
  if (permissionInfoWidget && !permissionInfoWidget.isConnected) {
    ui.xmlEditor.statusbar.add(permissionInfoWidget, 'left', 1)
  }
  if (statusSeparator && !statusSeparator.isConnected) {
    ui.xmlEditor.statusbar.add(statusSeparator, 'left', 2)
  }
  if (statusDropdownWidget && !statusDropdownWidget.isConnected) {
    ui.xmlEditor.statusbar.add(statusDropdownWidget, 'left', 3)
  }
}

/**
 * Hides access control widgets
 */
function hideAccessControlWidgets() {
  if (permissionInfoWidget && permissionInfoWidget.isConnected) {
    ui.xmlEditor.statusbar.removeById(permissionInfoWidget.id)
  }
  if (statusSeparator && statusSeparator.isConnected) {
    ui.xmlEditor.statusbar.removeById(statusSeparator.id)
  }
  if (statusDropdownWidget && statusDropdownWidget.isConnected) {
    ui.xmlEditor.statusbar.removeById(statusDropdownWidget.id)
  }
}

/**
 * Checks if current user can edit the document
 * @param {Object} user - Current user object
 * @returns {boolean}
 */
function canEditDocument(user) {
  const { visibility, editability, owner } = currentPermissions
  
  if (!user) {
    // Anonymous users cannot edit anything
    return false
  }
  
  // Admin users can edit everything
  if (user.roles && user.roles.includes('admin')) {
    return true
  }
  
  // Check visibility permissions
  if (visibility === 'private' && owner !== user.username) {
    return false
  }
  
  // Check editability permissions
  if (editability === 'protected' && owner !== user.username) {
    return false
  }
  
  return true
}

/**
 * Checks if current user can view the document
 * @param {Object} user - Current user object  
 * @returns {boolean}
 */
function canViewDocument(user) {
  const { visibility, owner } = currentPermissions
  
  // Admin users can view everything
  if (user && user.roles && user.roles.includes('admin')) {
    return true
  }
  
  // Public documents can be viewed by anyone
  if (visibility === 'public') {
    return true
  }
  
  // Private documents only viewable by owner
  if (visibility === 'private') {
    return user && owner === user.username
  }
  
  return false
}
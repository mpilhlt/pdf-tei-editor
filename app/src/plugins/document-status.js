/**
 * Document Status Plugin - Flexible document status management
 * Supports draft, locked, and no status with split button dropdown UI
 */

/**
 * @import { ApplicationState } from '../app.js'
 * @import { SlButton, SlDropdown, SlMenu, SlMenuItem } from '../ui.js'
 */
import { client, services, logger, updateState, authentication, xmlEditor } from '../app.js'
import { createHtmlElements, updateUi } from '../ui.js'
import ui from '../ui.js'
import * as tei_utils from '../modules/tei-utils.js'
import { notify } from '../modules/sl-utils.js'

const plugin = {
  name: "document-status",
  deps: ['services'],
  install,
  state: { update }
}

export { plugin }
export default plugin

//
// Status definitions
//
const STATUS_DEFINITIONS = {
  draft: {
    label: 'Draft',
    icon: 'pencil-square',
    description: 'Document is in draft state'
  },
  locked: {
    label: 'Locked',
    icon: 'locked',
    description: 'Document is locked for editing'
  },
  none: {
    label: 'No Status',
    icon: 'circle',
    description: 'No specific status set'
  }
}

//
// UI Components
//
let statusButton, statusDropdown, statusMenu
let currentStatus = 'none'

//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  
  // Create status button with dropdown (similar to delete button pattern)
  const buttonGroup = document.createElement('sl-button-group')
  
  statusDropdown = Object.assign(document.createElement('sl-dropdown'), {
    placement: 'bottom-end'
  })
  
  statusButton = Object.assign(document.createElement('sl-button'), {
    name: 'statusBtn',
    size: 'small',
    slot: 'trigger',
    caret: true,
    innerHTML: `<sl-icon name="circle"></sl-icon>`
  })
  
  statusMenu = document.createElement('sl-menu')
  
  // Create menu items for each status
  for (const [statusKey, statusDef] of Object.entries(STATUS_DEFINITIONS)) {
    const menuItem = Object.assign(document.createElement('sl-menu-item'), {
      name: statusKey,
      innerHTML: `<sl-icon name="${statusDef.icon}" slot="prefix"></sl-icon>${statusDef.label}`
    })
    statusMenu.appendChild(menuItem)
  }
  
  statusDropdown.appendChild(statusButton)
  statusDropdown.appendChild(statusMenu)
  buttonGroup.appendChild(statusDropdown)
  
  // Add tooltip
  const tooltip = Object.assign(document.createElement('sl-tooltip'), {
    content: 'Set document status'
  })
  tooltip.appendChild(buttonGroup)
  
  // Insert into document actions after save revision button
  const saveRevisionBtn = ui.toolbar.documentActions.saveRevision.parentElement
  saveRevisionBtn.parentElement.insertBefore(tooltip, saveRevisionBtn.nextSibling)
  
  updateUi()
  
  // Add event listeners
  statusMenu.addEventListener('sl-select', (event) => {
    const selectedStatus = event.detail.item.name
    setDocumentStatus(state, selectedStatus)
  })
  
  // Add click listener to update checked state (radio behavior)
  statusMenu.addEventListener('click', (event) => {
    if (event.target.tagName.toLowerCase() === 'sl-menu-item') {
      updateMenuItemSelection(event.target.name)
    }
  })
}

/**
 * Update plugin state when application state changes
 * @param {ApplicationState} state 
 */
async function update(state) {
  if (!statusButton) return
  
  // Disable if offline or no XML loaded
  const disabled = state.offline || !state.xmlPath
  statusButton.disabled = disabled
  
  if (!disabled) {
    // Update current status from TEI document
    await updateCurrentStatusFromDocument(state)
    updateStatusButtonAppearance()
    
    // Handle status inheritance for new versions
    await handleStatusInheritance(state)
  }
}

/**
 * Shared helper function to update document status with role-based permissions
 * @param {ApplicationState} state 
 * @param {string} status 
 * @param {string} description 
 */
async function updateDocumentStatus(state, status, description) {
  const xmlDoc = xmlEditor.getXmlTree()
  if (!xmlDoc || !state.xmlPath) {
    logger.warn("No XML document loaded, cannot set status")
    return
  }
  
  const user = authentication.getUser()
  if (!user) {
    logger.warn("Cannot set status. No user is logged in.")
    return
  }
  
  const currentUserId = getIdFromUser(user)
  const userRole = user.role || 'user' // Default to 'user' role if not specified
  
  // Get the latest change element
  const latestChangeInfo = getLatestChangeElement(xmlDoc)
  
  if (latestChangeInfo && latestChangeInfo.element) {
    const latestChangePersId = latestChangeInfo.element.getAttribute('persId')
    const isOwnChange = latestChangePersId === currentUserId
    const isAdmin = userRole === 'admin'
    
    if (isOwnChange || isAdmin) {
      // Update existing change element status
      latestChangeInfo.element.setAttribute('status', status)
      latestChangeInfo.element.setAttribute('when', new Date().toISOString())
      
      // Update description to reflect status change
      const descElement = latestChangeInfo.element.querySelector('desc')
      if (descElement) {
        descElement.textContent = description
      }
      
      logger.debug(`Updated existing change element status to ${status} (${isAdmin ? 'admin override' : 'own change'})`)
    } else {
      // Current user cannot modify another user's change element (non-admin)
      throw new Error(`Cannot set ${status} status: latest change belongs to another user and you don't have admin privileges`)
    }
  } else {
    // No existing change elements, create a new one
    const revisionChange = {
      status: status,
      persId: currentUserId,
      desc: description
    }
    
    tei_utils.addRevisionChange(xmlDoc, revisionChange)
    logger.debug(`Added new change element with ${status} status`)
  }
  
  await xmlEditor.updateEditorFromXmlTree()
  await services.saveXml(state.xmlPath)
}

/**
 * Set the document status
 * @param {ApplicationState} state 
 * @param {string} status 
 */
async function setDocumentStatus(state, status) {
  logger.debug(`Setting document status to: ${status}`)
  
  try {
    if (status === 'locked') {
      await setLockedStatus(state)
    } else if (status === 'draft') {
      await setDraftStatus(state)
    } else {
      await clearStatus(state)
    }
    
    currentStatus = status
    updateStatusButtonAppearance()
    notify(`Document status set to: ${STATUS_DEFINITIONS[status].label}`)
    
  } catch (error) {
    logger.error(`Failed to set status: ${error.message}`)
    notify(`Failed to set status: ${error.message}`)
  }
}

/**
 * Set document to locked status with file locking
 * @param {ApplicationState} state 
 */
async function setLockedStatus(state) {
  // Check if we can lock the file first
  try {
    await client.acquireLock(state.xmlPath)
  } catch (error) {
    if (error instanceof client.LockedError) {
      throw new Error("Cannot set locked status: file is already locked by another user")
    }
    throw error
  }
  
  await updateDocumentStatus(state, 'locked', 'Document locked for editing')
  logger.debug("Document status set to locked with file lock maintained")
}

/**
 * Set document to draft status
 * @param {ApplicationState} state 
 */
async function setDraftStatus(state) {
  await updateDocumentStatus(state, 'draft', 'Document marked as draft')
}

/**
 * Clear document status
 * @param {ApplicationState} state 
 */
async function clearStatus(state) {
  await updateDocumentStatus(state, 'cleared', 'Document status cleared')
  logger.debug("Document status cleared - status change recorded")
}

/**
 * Update current status from TEI document
 * @param {ApplicationState} state 
 */
async function updateCurrentStatusFromDocument(state) {
  const xmlDoc = xmlEditor.getXmlTree()
  if (!xmlDoc) {
    currentStatus = 'none'
    return
  }
  
  // Get the most recent change element with a status
  const latestStatus = getLatestStatusFromTei(xmlDoc)
  currentStatus = latestStatus || 'none'
}

/**
 * Get the latest change element from TEI with timestamp info
 * @param {Document} xmlDoc 
 * @returns {{element: Element, timestamp: Date}|null}
 */
function getLatestChangeElement(xmlDoc) {
  try {
    // Use getElementsByTagName to find change elements
    const revisionDescs = xmlDoc.getElementsByTagName('revisionDesc')
    if (!revisionDescs.length) {
      return null
    }
    
    const changeElements = revisionDescs[0].getElementsByTagName('change')
    let latestTimestamp = null
    let latestElement = null
    
    for (let i = 0; i < changeElements.length; i++) {
      const changeElement = changeElements[i]
      const when = changeElement.getAttribute('when')
      
      if (when) {
        try {
          const timestamp = new Date(when)
          if (!isNaN(timestamp.getTime()) && (!latestTimestamp || timestamp > latestTimestamp)) {
            latestTimestamp = timestamp
            latestElement = changeElement
          }
        } catch (dateError) {
          logger.warn(`Invalid timestamp in TEI change element: ${when}`)
        }
      }
    }
    
    return latestElement ? { element: latestElement, timestamp: latestTimestamp } : null
  } catch (error) {
    logger.warn(`Error reading TEI change elements: ${error.message}`)
    return null
  }
}

/**
 * Get the latest status from TEI change elements
 * @param {Document} xmlDoc 
 * @returns {string|null}
 */
function getLatestStatusFromTei(xmlDoc) {
  const latestChangeInfo = getLatestChangeElement(xmlDoc)
  if (!latestChangeInfo) {
    return null
  }
  
  const status = latestChangeInfo.element.getAttribute('status')
  // Treat "cleared" status as "none" for UI purposes
  return status === 'cleared' ? 'none' : status
}

/**
 * Update the status button appearance based on current status
 */
function updateStatusButtonAppearance() {
  if (!statusButton) return
  
  const statusDef = STATUS_DEFINITIONS[currentStatus] || STATUS_DEFINITIONS.none
  statusButton.innerHTML = `<sl-icon name="${statusDef.icon}"></sl-icon>`
  
  // Update button variant based on status
  switch (currentStatus) {
    case 'locked':
      statusButton.variant = 'danger'
      break
    case 'draft':
      statusButton.variant = 'warning'
      break
    default:
      statusButton.variant = 'default'
  }
  
  // Update tooltip
  const tooltip = statusButton.closest('sl-tooltip')
  if (tooltip) {
    tooltip.content = `Current status: ${statusDef.label}`
  }
  
  // Update menu item selection (radio behavior)
  updateMenuItemSelection(currentStatus)
}

/**
 * Update menu item selection to show current status (radio behavior)
 * @param {string} selectedStatus 
 */
function updateMenuItemSelection(selectedStatus) {
  if (!statusMenu) return
  
  // Remove checked attribute from all menu items
  const menuItems = statusMenu.querySelectorAll('sl-menu-item')
  menuItems.forEach(item => {
    item.removeAttribute('checked')
  })
  
  // Add checked attribute to selected item
  const selectedItem = statusMenu.querySelector(`sl-menu-item[name="${selectedStatus}"]`)
  if (selectedItem) {
    selectedItem.setAttribute('checked', '')
  }
}

/**
 * Handle status inheritance for new versions
 * @param {ApplicationState} state 
 */
async function handleStatusInheritance(state) {
  if (!state.xmlPath) return
  
  // Check if this is a version file (versions are in /data/versions/ path)
  const isVersionFile = state.xmlPath.includes('/versions/')
  if (!isVersionFile) return
  
  const xmlDoc = xmlEditor.getXmlTree()
  if (!xmlDoc) return
  
  // Check if this version already has status change elements
  const existingChanges = xmlDoc.getElementsByTagName('revisionDesc')
  if (existingChanges.length > 0) {
    const changeElements = existingChanges[0].getElementsByTagName('change')
    for (let i = 0; i < changeElements.length; i++) {
      if (changeElements[i].getAttribute('status')) {
        // Already has status, no inheritance needed
        return
      }
    }
  }
  
  // For new versions without status, inherit 'draft' status by default
  // This indicates that the new version is a work in progress
  try {
    logger.debug("Applying default draft status to new version")
    await setDraftStatusQuietly(state)
  } catch (error) {
    logger.warn(`Failed to apply inheritance status: ${error.message}`)
  }
}

/**
 * Set draft status without user notification (for inheritance)
 * @param {ApplicationState} state 
 */
async function setDraftStatusQuietly(state) {
  const xmlDoc = xmlEditor.getXmlTree()
  if (!xmlDoc) return
  
  const user = authentication.getUser()
  const persId = user ? getIdFromUser(user) : 'system'
  
  const revisionChange = {
    status: 'draft',
    persId: persId,
    desc: 'New version created (auto-draft status)'
  }
  
  tei_utils.addRevisionChange(xmlDoc, revisionChange)
  await xmlEditor.updateEditorFromXmlTree()
  // Note: Don't save automatically, let user save when ready
  
  // Update current status to reflect the change
  currentStatus = 'draft'
  updateStatusButtonAppearance()
}

/**
 * Get user ID from user data (from services.js pattern)
 * @param {Object} userData 
 * @returns {string}
 */
function getIdFromUser(userData) {
  let names = userData.fullname
  if (names && names.trim() !== "") {
    names = userData.fullname.split(" ")
  } else {
    return userData.username
  }
  if (names.length > 1) {
    return names.map(n => n[0]).join("").toLowerCase()
  }
  return names[0].slice(0, 3)
}
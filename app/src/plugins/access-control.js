/**
 * Access Control plugin
 * 
 * Manages document access permissions and provides UI for changing document status.
 * Integrates with xmleditor plugin to enforce read-only state based on permissions.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { UIPart, SlDropdown } from '../ui.js'
 * @import { StatusBar } from '../modules/panels/status-bar.js'
 * @import { UserData } from './authentication.js'
 */

import { app, services, authentication, fileselection } from '../app.js'
import { FiledataPlugin } from '../plugins.js'
import ui from '../ui.js'
import { PanelUtils } from '../modules/panels/index.js'
import { logger } from '../app.js'
import { api as xmlEditor } from './xmleditor.js'
import { prettyPrintNode, ensureRespStmtForUser } from '../modules/tei-utils.js'
import {
  userHasReviewerRole,
  userHasAnnotatorRole,
  isGoldFile,
  isVersionFile,
  canEditDocumentWithPermissions,
  canViewDocumentWithPermissions,
  canEditFile as canEditFileFromUtils,
  userIsAdmin
} from '../modules/acl-utils.js'

// TEI namespace constant
const TEI_NS = 'http://www.tei-c.org/ns/1.0'

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

/**
 * Document permissions object
 * @typedef {object} DocumentPermissions
 * @property {string} visibility - Document visibility ('public' or 'private')
 * @property {string} editability - Document editability ('editable' or 'protected')
 * @property {string|null} owner - Document owner username (null if no owner)
 * @property {boolean} can_modify - Whether current user can modify permissions
 */

// Status widgets for access control

/** @type {SlDropdown} */
let statusDropdownWidget;
/** @type {StatusText} */
let permissionInfoWidget;


// Current document permissions cache
/** @type {DocumentPermissions} */
let currentPermissions = {
    visibility: 'public',
    editability: 'editable',
    owner: null,
    can_modify: false
}

// Application state reference for internal use
/** @type {ApplicationState | null} */
let pluginState = null


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
 * @typedef {object} AccessControlAPI
 * @property {() => DocumentPermissions} getDocumentPermissions - Gets current document permissions
 * @property {(user: UserData|null) => boolean} canEditDocument - Checks if user can edit document
 * @property {(user: UserData|null) => boolean} canViewDocument - Checks if user can view document
 * @property {(visibility: string, editability: string, owner?: string, description?: string) => Promise<DocumentPermissions>} updateDocumentStatus - Updates document status
 * @property {(fileId: string) => boolean} checkCanEditFile - Checks if user can edit file
 */
const api = {
  getDocumentPermissions: () => currentPermissions,
  canEditDocument,
  canViewDocument,
  updateDocumentStatus,
  checkCanEditFile
}

export { plugin, api }
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  
  // Create permission info widget
  permissionInfoWidget = PanelUtils.createText({
    text: '',
    variant: 'neutral'
  })
  
  // Create status dropdown widget 
  statusDropdownWidget = createStatusDropdown()

  // Add widgets to left side of statusbar (lower priority = more to the left)
  ui.xmlEditor.statusbar.add(permissionInfoWidget, 'left', 1)
  ui.xmlEditor.statusbar.add(statusDropdownWidget, 'left', 3)
  
  // Initially hide widgets until document is loaded
  hideAccessControlWidgets()
}

/**
 * Runs after all plugins are installed
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function start(state) {
  logger.debug(`Starting plugin "${plugin.name}"`)
}

/** @type {string | null} */
let state_xml_cache;
let isUpdatingState = false; // Guard to prevent infinite loops 

/**
 * Called when application state changes
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function update(state) {
  // Store state reference for internal use
  pluginState = state
  
  // Only show access control widgets when a document is loaded
  if (!state.xml) {
    hideAccessControlWidgets()
    state_xml_cache = null
    return
  }

  // disable the status dropdown when the editor is read-only
  statusDropdownWidget.disabled = state.editorReadOnly

  // nothing more to do if the xml doc hasn't changed
  if (state.xml === state_xml_cache) {
    return
  }

  state_xml_cache = state.xml
  logger.debug(`Access control: Updating access control for document: ${state.xml}`)  
  await computeDocumentPermissions()
  
  // Update UI based on permissions
  logger.debug("Access control: Update UI")
  updateAccessControlUI()
  
  // Check if document should be read-only based on permissions
  const shouldBeReadOnly = !canEditDocument(state.user)

  // Only apply access control restrictions, never relax them
  // If editor is already read-only (e.g., due to file locking), don't override it
  if (shouldBeReadOnly && !state.editorReadOnly && !isUpdatingState) {
    // Document permissions require read-only - enforce it
    logger.debug(`Setting editor read-only based on access control: ${shouldBeReadOnly}`)
    // Note: Defer state update to avoid circular update during reactive state cycle
    isUpdatingState = true
    setTimeout(async () => {
      try {
        // Only update if the state still needs changing (avoid race conditions)
        if (pluginState && !pluginState.editorReadOnly) {
          await app.updateState({ editorReadOnly: true })
        }
      } finally {
        isUpdatingState = false
      }
    }, 0);
  } else if (!shouldBeReadOnly && state.editorReadOnly) {
    // Document permissions allow editing, but editor is read-only
    // This might be due to file locking or other reasons - don't override
    logger.debug(`Editor is read-only despite document being editable (likely due to file lock)`)
  }
  
  // Update read-only widget context if xmleditor shows read-only status due to access control
  updateReadOnlyContext(state.editorReadOnly, shouldBeReadOnly)
}

/**
 * Creates the status dropdown widget
 * @returns {SlDropdown} The created dropdown element
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
    item.setAttribute('type', 'checkbox')
    item.textContent = option.label
    item.dataset.visibility = option.visibility
    item.dataset.editability = option.editability
    menu.appendChild(item)
  })
  
  dropdown.appendChild(trigger)
  dropdown.appendChild(menu)
  
  // Handle selection changes
  dropdown.addEventListener('sl-select', handlePermissionChange)
  
  return dropdown
}

/**
 * Handles status dropdown selection changes
 * @param {CustomEvent} event
 * @returns {Promise<void>}
 */
async function handlePermissionChange(event) {
  const selectedItem = event.detail.item
  const newVisibility = selectedItem.dataset.visibility
  const newEditability = selectedItem.dataset.editability
  
  try {
    // Determine if we need to set an owner
    let owner = currentPermissions.owner
    
    // If making document private or protected, ensure current user becomes owner if no owner exists
    if ((newVisibility === 'private' || newEditability === 'protected') && !owner) {
      const currentUser = authentication.getUser()
      if (currentUser) {
        owner = currentUser.username
        logger.debug(`Setting document owner to current user: ${owner}`)
      }
    }
    
    await updateDocumentStatus(newVisibility, newEditability, owner || undefined)
    logger.info(`Document status updated: ${newVisibility} ${newEditability}${owner ? ` (owner: ${owner})` : ''}`)
  } catch (error) {
    logger.error(`Failed to update document status: ${String(error)}`)
    // Revert dropdown to previous state
    updateStatusDropdownDisplay()
  }
}

/**
 * Parses document permissions from current XML DOM tree
 * @returns {Promise<void>}
 */
async function computeDocumentPermissions() {
  try {
    const xmlTree = xmlEditor.getXmlTree()
    if (!xmlTree) {
      // Use defaults if no XML tree
      currentPermissions = {
        visibility: 'public',
        editability: 'editable', 
        owner: null,
        can_modify: true // Default to allowing modifications
      }
      return
    }
    
    // Parse permissions from XML DOM tree
    const permissions = parsePermissionsFromXmlTree(xmlTree)
    
    // First set the permissions without can_modify
    currentPermissions = {
      ...permissions,
      can_modify: true // temporary
    }
    
    // Now calculate can_modify using the updated permissions
    const currentUser = authentication.getUser()
    currentPermissions.can_modify = canEditDocument(currentUser)
    
    logger.debug('Parsed document permissions:' + JSON.stringify(currentPermissions) )
  } catch (error) {
    logger.error(`Error parsing document permissions: ${String(error)}`)
    // Use defaults on error
    currentPermissions = {
      visibility: 'public', 
      editability: 'editable',
      owner: null,
      can_modify: true
    }
  }
}

/**
 * Parses permissions from XML DOM tree
 * @param {Document} xmlTree
 * @returns {DocumentPermissions} Permissions object
 */
function parsePermissionsFromXmlTree(xmlTree) {
  try {
    // Find all change elements using XPath
    const changes = /** @type {Element[]} */ (xmlEditor.getDomNodesByXpath('//tei:revisionDesc/tei:change'))
    if (changes.length === 0) {
      return {
        visibility: 'public',
        editability: 'editable',
        owner: null,
        can_modify: true
      }
    }
    
    // Find the last change element that contains permission labels
    let lastPermissionChange = null
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i]
      const hasPermissionLabels = change.querySelector('label[type="visibility"], label[type="access"], label[type="owner"]')
      if (hasPermissionLabels) {
        lastPermissionChange = change
        break
      }
    }
    
    if (!lastPermissionChange) {
      return {
        visibility: 'public',
        editability: 'editable',
        owner: null,
        can_modify: true
      }
    }
    
    // Parse label elements from the last permission change
    const permissionChange = lastPermissionChange
    const visibilityLabel = permissionChange.querySelector('label[type="visibility"]')
    const accessLabel = permissionChange.querySelector('label[type="access"]')
    const ownerLabel = permissionChange.querySelector('label[type="owner"]')
    
    const visibility = visibilityLabel?.textContent?.trim() || 'public'
    let editability = accessLabel?.textContent?.trim() || 'editable'
    
    // Handle legacy "private" access value
    if (editability === 'private') {
      editability = 'protected'
    }
    
    // Parse owner from ana attribute (preferred) or fallback to text content
    let owner = null
    if (ownerLabel) {
      const anaValue = ownerLabel.getAttribute('ana')
      if (anaValue && anaValue.startsWith('#')) {
        owner = anaValue.substring(1) // Remove # prefix
      } else {
        owner = ownerLabel.textContent?.trim() || null
      }
    }
    
    return {
      visibility: visibility === 'private' ? 'private' : 'public',
      editability: editability === 'protected' ? 'protected' : 'editable',
      owner,
      can_modify: true
    }
  } catch (error) {
    logger.warn(`Error parsing permissions from XML tree: ${String(error)}`)
    return {
      visibility: 'public',
      editability: 'editable',
      owner: null,
      can_modify: true
    }
  }
}

/**
 * Updates document status by modifying XML DOM and updating editor
 * @param {string} visibility - 'public' or 'private'
 * @param {string} editability - 'editable' or 'protected'
 * @param {string} [owner] - Optional new owner
 * @param {string} [description] - Optional change description
 * @returns {Promise<DocumentPermissions>} Updated permissions
 */
async function updateDocumentStatus(visibility, editability, owner, description) {
  try {
    if (!pluginState?.xml) {
      throw new Error('No document loaded in application state')
    }
    
    const xmlTree = xmlEditor.getXmlTree()
    if (!xmlTree) {
      throw new Error('No XML document loaded')
    }
    
    // Find or create teiHeader
    let teiHeader = /** @type {Element} */ (xmlEditor.getDomNodeByXpath('//tei:teiHeader'))
    if (!teiHeader) {
      throw new Error('No teiHeader found in document')
    }
    
    // Find or create revisionDesc
    let revisionDesc = /** @type {Element|null} */ (xmlEditor.getDomNodeByXpath('//tei:teiHeader/tei:revisionDesc'))
    if (!revisionDesc) {
      revisionDesc = xmlTree.createElementNS(TEI_NS, 'revisionDesc')
      teiHeader.appendChild(revisionDesc)
    }
    
    // Create new change element
    const change = xmlTree.createElementNS(TEI_NS, 'change')
    const timestamp = new Date().toISOString()
    change.setAttribute('when', timestamp)
    
    // Add who attribute to document who made the change
    const currentUser = authentication.getUser()
    if (currentUser) {
      // Ensure respStmt exists for current user
      logger.debug(`Ensuring respStmt for current user: ${currentUser.username}, fullname: ${currentUser.fullname}`)
      ensureRespStmtForUser(xmlTree, currentUser.username, currentUser.fullname || currentUser.username)
      change.setAttribute('who', `#${currentUser.username}`)
    }
    
    // Add description
    const desc = xmlTree.createElementNS(TEI_NS, 'desc')
    desc.textContent = description || 'Access permissions updated'
    change.appendChild(desc)
    
    // Add visibility label
    const visibilityLabel = xmlTree.createElementNS(TEI_NS, 'label')
    visibilityLabel.setAttribute('type', 'visibility')
    visibilityLabel.textContent = visibility
    change.appendChild(visibilityLabel)
    
    // Add access label (editability)
    const accessLabel = xmlTree.createElementNS(TEI_NS, 'label')
    accessLabel.setAttribute('type', 'access')
    accessLabel.textContent = editability === 'protected' ? 'protected' : 'editable'
    change.appendChild(accessLabel)
    
    // Add owner label only if the document needs an owner (private or protected documents)
    const needsOwner = visibility === 'private' || editability === 'protected'
    if (needsOwner) {
      const finalOwner = owner || currentPermissions.owner || currentUser?.username
      
      if (finalOwner) {
        // Ensure respStmt exists for owner
        const ownerUser = authentication.getUser() // For now, assume current user is the owner
        if (ownerUser && finalOwner === ownerUser.username) {
          logger.debug(`Ensuring respStmt for owner: ${finalOwner}, fullname: ${ownerUser.fullname}`)
          ensureRespStmtForUser(xmlTree, finalOwner, ownerUser.fullname || ownerUser.username || finalOwner)
        }
        
        const ownerLabel = xmlTree.createElementNS(TEI_NS, 'label')
        ownerLabel.setAttribute('type', 'owner')
        ownerLabel.setAttribute('ana', `#${finalOwner}`)
        
        // Set text content to full name if available, otherwise username
        if (ownerUser && finalOwner === ownerUser.username) {
          ownerLabel.textContent = ownerUser.fullname || ownerUser.username
        } else {
          ownerLabel.textContent = finalOwner || 'Unknown' // fallback to username
        }
        
        change.appendChild(ownerLabel)
      }
    }
    // Note: For public & editable documents, no owner label is added
    
    // Add the change element to revisionDesc
    revisionDesc.appendChild(change)
    
    // Pretty-print the entire TEI header for proper formatting
    prettyPrintNode(teiHeader)
    
    // Update the entire TEI header in the editor to reflect formatting changes
    await xmlEditor.updateEditorFromNode(teiHeader)
    
    // Save the document using services API
    await FiledataPlugin.getInstance().saveXml(pluginState.xml)
    
    // Update cached permissions
    currentPermissions.visibility = visibility
    currentPermissions.editability = editability
    if (owner) {
      currentPermissions.owner = owner
    }
    
    // Update UI
    updateAccessControlUI()
    
    return {
      visibility,
      editability,
      owner: currentPermissions.owner,
      can_modify: true
    }
  } catch (error) {
    logger.error(`Failed to update document permissions: ${String(error)}`)
    throw error
  }
}

/**
 * Updates the access control UI widgets
 * @returns {void}
 */
function updateAccessControlUI() {
  //showAccessControlWidgets() // disabled until actually implemented
  updatePermissionInfoDisplay()
  updateStatusDropdownDisplay()
  updateStatusDropdownVisibility()
}

/**
 * Updates the permission info text display
 * @returns {void}
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
 * @returns {void}
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
  
  if (trigger) {
    trigger.textContent = buttonText
  }
  
  
  // Update selected menu item
  const currentValue = `${visibility}-${editability}`
  const menuItems = statusDropdownWidget.querySelectorAll('sl-menu-item')
  menuItems.forEach(item => {
    item.checked = item.getAttribute('value') === currentValue
  })
}

/**
 * Shows or hides the status dropdown based on user permissions
 * @returns {void}
 */
function updateStatusDropdownVisibility() {
  if (!statusDropdownWidget || !permissionInfoWidget) return
  
  if (currentPermissions.can_modify) {
    // User can modify permissions - show dropdown, hide text info
    statusDropdownWidget.style.display = ''
    permissionInfoWidget.style.display = 'none'
  } else {
    // User cannot modify permissions - hide dropdown, show text info
    statusDropdownWidget.style.display = 'none'
    permissionInfoWidget.style.display = ''
  }
}

/**
 * Shows access control widgets
 * @returns {void}
 */
function showAccessControlWidgets() {
  if (permissionInfoWidget && !permissionInfoWidget.isConnected) {
    ui.xmlEditor.statusbar.add(permissionInfoWidget, 'left', 1)
  }
  if (statusDropdownWidget && !statusDropdownWidget.isConnected) {
    ui.xmlEditor.statusbar.add(statusDropdownWidget, 'left', 3)
  }
}

/**
 * Hides access control widgets
 * @returns {void}
 */
function hideAccessControlWidgets() {
  if (permissionInfoWidget && permissionInfoWidget.isConnected) {
    ui.xmlEditor.statusbar.removeById(permissionInfoWidget.id)
  }
  if (statusDropdownWidget && statusDropdownWidget.isConnected) {
    ui.xmlEditor.statusbar.removeById(statusDropdownWidget.id)
  }
}


/**
 * Checks if current user can edit the document
 * @param {UserData|null} user - Current user object
 * @returns {boolean}
 */
function canEditDocument(user) {
  const fileId = pluginState?.xml || undefined
  return canEditDocumentWithPermissions(user, currentPermissions, fileId)
}

/**
 * Checks if current user can view the document
 * @param {UserData|null} user - Current user object
 * @returns {boolean}
 */
function canViewDocument(user) {
  return canViewDocumentWithPermissions(user, currentPermissions)
}

/**
 * Updates the xmleditor's read-only widget with context-specific information
 * @param {boolean} editorReadOnly - Current editor read-only state
 * @param {boolean} accessControlReadOnly - Whether read-only is due to access control
 * @returns {void}
 */
function updateReadOnlyContext(editorReadOnly, accessControlReadOnly) {
  // Only update if editor is read-only and it's due to access control
  if (!editorReadOnly || !accessControlReadOnly) {
    return
  }
  
  // Access the xmleditor's read-only status widget and update with context
  updateReadOnlyWidgetText(ui.xmlEditor.statusbar.readOnlyStatus)
}

/**
 * Updates the read-only widget text with access control context
 * @param {StatusText} readOnlyWidget - The read-only status widget
 * @returns {void}
 */
function updateReadOnlyWidgetText(readOnlyWidget) {
  if (!readOnlyWidget) {
    logger.debug('Read-only widget not available, skipping context update')
    return
  }

  const { visibility, editability, owner } = currentPermissions
  const currentUser = authentication.getUser()

  let contextText = 'Read-only'

  // Check role-based file type restrictions
  if (pluginState && pluginState.xml) {
    if (isGoldFile(pluginState.xml) && !userHasReviewerRole(currentUser)) {
      contextText = 'Read-only (gold file - reviewer role required)'
    } else if (isVersionFile(pluginState.xml) && !userHasAnnotatorRole(currentUser) && !userHasReviewerRole(currentUser)) {
      contextText = 'Read-only (version file - annotator role required)'
    }
  }
  // Determine the reason for read-only state
  else if (editability === 'protected' && owner && owner !== currentUser?.username) {
    // Document is protected and user is not the owner
    contextText = `Read-only (owned by ${owner})`
  } else if (visibility === 'private' && owner && owner !== currentUser?.username) {
    // Document is private and user is not the owner
    contextText = `Read-only (owned by ${owner})`
  } else if (owner) {
    // Default case with owner information
    contextText = `Read-only (owned by ${owner})`
  }

  // Update the widget text
  readOnlyWidget.text = contextText
  logger.debug(`Updated read-only context: ${contextText}`)
}

/**
 * Checks if the current user can edit the given file based on access control metadata
 * @param {string} fileId - The file identifier (hash)
 * @returns {boolean} - True if user can edit, false otherwise
 */
function checkCanEditFile(fileId) {
  const currentUser = authentication.getUser()
  return canEditFileFromUtils(currentUser, fileId)
}
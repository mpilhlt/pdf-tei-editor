/**
 * Access Control plugin
 *
 * Manages document access permissions with three modes:
 * - role-based: only role restrictions (gold = reviewers only)
 * - owner-based: documents editable only by owner
 * - granular: database-backed per-document permissions
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { StatusSwitch } from '../modules/panels/widgets/status-switch.js'
 * @import { UserData } from './authentication.js'
 * @import { AccessControlModeResponse } from '../modules/api-client-v1.js'
 */

import { app, client, authentication } from '../app.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import ui from '../ui.js'
import { PanelUtils } from '../modules/panels/index.js'
import { logger } from '../app.js'
import { notify } from '../modules/sl-utils.js'
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

/**
 * Access control mode
 * @typedef {'role-based' | 'owner-based' | 'granular'} AccessControlMode
 */

/**
 * Document permissions object
 * @typedef {object} DocumentPermissions
 * @property {string} visibility - Document visibility ('collection' or 'owner')
 * @property {string} editability - Document editability ('collection' or 'owner')
 * @property {string|null} owner - Document owner username (null if no owner)
 * @property {boolean} can_modify - Whether current user can modify permissions
 */

/**
 * Access control configuration from backend
 * @type {AccessControlModeResponse | null}
 */
let accessControlConfig = null

// Status widgets for access control
/** @type {StatusText | null} */
let permissionInfoWidget = null
/** @type {HTMLElement | null} */
let permissionsDropdown = null
/** @type {StatusSwitch | null} */
let visibilitySwitch = null
/** @type {StatusSwitch | null} */
let editabilitySwitch = null

// Current document permissions cache
/** @type {DocumentPermissions} */
let currentPermissions = {
  visibility: 'collection',
  editability: 'owner',
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
 * @property {() => AccessControlMode} getMode - Gets current access control mode
 * @property {(fileId: string) => boolean} checkCanEditFile - Checks if user can edit file
 */
const api = {
  getDocumentPermissions: () => currentPermissions,
  canEditDocument,
  canViewDocument,
  getMode: () => accessControlConfig?.mode || 'role-based',
  checkCanEditFile
}

export { plugin, api }
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} _state
 * @returns {Promise<void>}
 */
async function install(_state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create permission info widget (shown when user cannot modify permissions)
  permissionInfoWidget = PanelUtils.createText({
    text: '',
    variant: 'neutral'
  })

  // Create visibility switch (for granular mode)
  visibilitySwitch = createVisibilitySwitch()

  // Create editability switch (for granular mode)
  editabilitySwitch = createEditabilitySwitch()

  // Create dropdown menu with gear button for permission controls
  permissionsDropdown = createPermissionsDropdown()

  // Add widgets to left side of statusbar
  // Lower priority = hidden first when space is limited
  ui.xmlEditor.statusbar.add(permissionInfoWidget, 'left', 1)
  ui.xmlEditor.statusbar.add(permissionsDropdown, 'left', 2)

  // Initially hide widgets until document is loaded
  hideAccessControlWidgets()
}

/**
 * Creates the permissions dropdown with gear button
 * @returns {HTMLElement}
 */
function createPermissionsDropdown() {
  // Create the dropdown container
  const dropdown = document.createElement('sl-dropdown')
  dropdown.setAttribute('placement', 'top-start')
  dropdown.setAttribute('distance', '4')

  // Create the trigger button with gear icon
  const triggerButton = document.createElement('sl-icon-button')
  triggerButton.setAttribute('slot', 'trigger')
  triggerButton.setAttribute('name', 'gear')
  triggerButton.setAttribute('label', 'Document Permissions')
  triggerButton.title = 'Document permission settings'
  triggerButton.style.fontSize = '1rem'

  // Create the menu
  const menu = document.createElement('sl-menu')
  menu.style.minWidth = '200px'
  menu.style.padding = '8px'

  // Create menu header
  const header = document.createElement('div')
  header.style.cssText = 'font-weight: 600; font-size: 0.75rem; color: var(--sl-color-neutral-500); padding: 4px 8px; text-transform: uppercase;'
  header.textContent = 'Permissions'

  // Create visibility menu item (contains the switch)
  const visibilityItem = document.createElement('sl-menu-item')
  visibilityItem.style.cssText = '--submenu-offset: 0;'
  visibilityItem.appendChild(visibilitySwitch)

  // Create editability menu item (contains the switch)
  const editabilityItem = document.createElement('sl-menu-item')
  editabilityItem.style.cssText = '--submenu-offset: 0;'
  editabilityItem.appendChild(editabilitySwitch)

  // Prevent menu from closing when clicking switches
  menu.addEventListener('sl-select', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })

  // Assemble the menu
  menu.appendChild(header)
  menu.appendChild(visibilityItem)
  menu.appendChild(editabilityItem)

  // Assemble the dropdown
  dropdown.appendChild(triggerButton)
  dropdown.appendChild(menu)

  return dropdown
}

/**
 * Runs after all plugins are installed
 * @param {ApplicationState} _state
 * @returns {Promise<void>}
 */
async function start(_state) {
  logger.debug(`Starting plugin "${plugin.name}"`)

  // Fetch access control mode from backend
  try {
    accessControlConfig = await client.apiClient.filesAccessControlMode()
    logger.info(`Access control mode: ${accessControlConfig.mode}`)
  } catch (error) {
    logger.error(`Failed to fetch access control mode: ${error}`)
    // Default to role-based mode on error
    accessControlConfig = {
      mode: 'role-based',
      default_visibility: 'collection',
      default_editability: 'owner'
    }
  }
}

/** @type {string | null} */
let state_xml_cache = null
let isUpdatingState = false // Guard to prevent infinite loops

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

  // Nothing more to do if the xml doc hasn't changed
  if (state.xml === state_xml_cache) {
    // But update dropdown disabled state based on editorReadOnly
    if (permissionsDropdown) {
      const triggerButton = permissionsDropdown.querySelector('sl-icon-button')
      if (triggerButton) triggerButton.disabled = state.editorReadOnly
    }
    return
  }

  state_xml_cache = state.xml
  logger.debug(`Access control: Updating for document: ${state.xml}`)

  try {
    await computeDocumentPermissions()

    // Update UI based on permissions and mode
    updateAccessControlUI()
  } catch (error) {
    logger.error(`Access control error in update(): ${error}`)
  }

  // Check if document should be read-only based on permissions
  const shouldBeReadOnly = !canEditDocument(state.user)

  // Only apply access control restrictions, never relax them
  // If editor is already read-only (e.g., due to file locking), don't override it
  if (shouldBeReadOnly && !state.editorReadOnly && !isUpdatingState) {
    logger.debug(`Setting editor read-only based on access control`)
    isUpdatingState = true
    setTimeout(async () => {
      try {
        if (pluginState && !pluginState.editorReadOnly) {
          await app.updateState({ editorReadOnly: true })
        }
      } finally {
        isUpdatingState = false
      }
    }, 0)
  }

  // Update read-only widget context if showing read-only due to access control
  updateReadOnlyContext(state.editorReadOnly, shouldBeReadOnly)
}

/**
 * Creates the visibility switch widget
 * @returns {StatusSwitch}
 */
function createVisibilitySwitch() {
  const switchEl = PanelUtils.createSwitch({
    name: 'visibilitySwitch',
    text: 'Visible',
    checked: true, // Default: collection (checked)
    size: 'small'
  })
  switchEl.title = 'Checked = visible to all users with collection access, Unchecked = visible only to document owner'

  switchEl.addEventListener('widget-change', handleVisibilityChange)
  return switchEl
}

/**
 * Creates the editability switch widget
 * @returns {StatusSwitch}
 */
function createEditabilitySwitch() {
  const switchEl = PanelUtils.createSwitch({
    name: 'editabilitySwitch',
    text: 'Editable',
    checked: false, // Default: owner (unchecked)
    size: 'small'
  })
  switchEl.title = 'Checked = editable by all users with collection access, Unchecked = editable only by document owner'

  switchEl.addEventListener('widget-change', handleEditabilityChange)
  return switchEl
}

/**
 * Handles visibility switch change
 * @param {CustomEvent} event
 * @returns {Promise<void>}
 */
async function handleVisibilityChange(event) {
  const checked = event.detail.checked
  const newVisibility = checked ? 'collection' : 'owner'

  try {
    await updateDocumentPermissions(newVisibility, currentPermissions.editability)
    logger.info(`Visibility updated to: ${newVisibility}`)
  } catch (error) {
    logger.error(`Failed to update visibility: ${error}`)
    notify(`Failed to update visibility: ${String(error)}`, 'danger', 'exclamation-octagon')
    // Revert switch
    if (visibilitySwitch) visibilitySwitch.checked = currentPermissions.visibility === 'collection'
  }
}

/**
 * Handles editability switch change
 * @param {CustomEvent} event
 * @returns {Promise<void>}
 */
async function handleEditabilityChange(event) {
  const checked = event.detail.checked
  const newEditability = checked ? 'collection' : 'owner'

  try {
    await updateDocumentPermissions(currentPermissions.visibility, newEditability)
    logger.info(`Editability updated to: ${newEditability}`)
  } catch (error) {
    logger.error(`Failed to update editability: ${error}`)
    notify(`Failed to update editability: ${String(error)}`, 'danger', 'exclamation-octagon')
    // Revert switch
    if (editabilitySwitch) editabilitySwitch.checked = currentPermissions.editability === 'collection'
  }
}

/**
 * Computes document permissions based on mode
 * @returns {Promise<void>}
 */
async function computeDocumentPermissions() {
  const mode = accessControlConfig?.mode || 'role-based'
  const fileData = getFileDataById(pluginState?.xml)
  const currentUser = authentication.getUser()

  if (mode === 'role-based') {
    // Role-based mode: no document-level permissions
    currentPermissions = {
      visibility: 'collection',
      editability: 'collection',
      owner: fileData?.created_by || null,
      can_modify: false
    }
  } else if (mode === 'owner-based') {
    // Owner-based mode: documents editable only by owner
    const owner = fileData?.created_by || null
    currentPermissions = {
      visibility: 'collection',
      editability: 'owner',
      owner,
      can_modify: false // No UI for owner-based mode
    }
  } else if (mode === 'granular') {
    // Granular mode: fetch from database
    if (!pluginState?.xml) {
      currentPermissions = {
        visibility: accessControlConfig?.default_visibility || 'collection',
        editability: accessControlConfig?.default_editability || 'owner',
        owner: fileData?.created_by || null,
        can_modify: false
      }
      return
    }

    try {
      const perms = await client.apiClient.filesPermissions(pluginState.xml)
      const isOwner = perms.owner === currentUser?.username
      const isReviewer = userHasReviewerRole(currentUser)
      const isAdmin = userIsAdmin(currentUser)

      currentPermissions = {
        visibility: perms.visibility,
        editability: perms.editability,
        owner: perms.owner,
        can_modify: isOwner || isReviewer || isAdmin
      }
    } catch (error) {
      // API may return 400 if not in granular mode - use defaults
      logger.debug(`Failed to fetch permissions (using defaults): ${error}`)
      currentPermissions = {
        visibility: accessControlConfig?.default_visibility || 'collection',
        editability: accessControlConfig?.default_editability || 'owner',
        owner: fileData?.created_by || null,
        can_modify: false
      }
    }
  }

  logger.debug(`Document permissions: ${JSON.stringify(currentPermissions)}`)
}

/**
 * Updates document permissions via API (granular mode only)
 * @param {string} visibility - 'collection' or 'owner'
 * @param {string} editability - 'collection' or 'owner'
 * @returns {Promise<void>}
 */
async function updateDocumentPermissions(visibility, editability) {
  const mode = accessControlConfig?.mode || 'role-based'

  if (mode !== 'granular') {
    throw new Error('Permission modification only available in granular mode')
  }

  if (!pluginState?.xml) {
    throw new Error('No document loaded')
  }

  const fileData = getFileDataById(pluginState?.xml)

  const response = await client.apiClient.filesSetPermissions({
    stable_id: pluginState.xml,
    visibility,
    editability,
    owner: currentPermissions.owner || fileData?.created_by || ''
  })

  // Update cached permissions
  currentPermissions.visibility = response.visibility
  currentPermissions.editability = response.editability
  currentPermissions.owner = response.owner

  // Update UI
  updateAccessControlUI()
}

/**
 * Updates the access control UI widgets based on mode
 * @returns {void}
 */
function updateAccessControlUI() {
  const mode = accessControlConfig?.mode || 'role-based'

  if (mode === 'granular' && currentPermissions.can_modify) {
    // Granular mode with permission to modify: show switches
    showPermissionSwitches()
    updateSwitchStates()
  } else if (mode === 'granular' && !currentPermissions.can_modify) {
    // Granular mode without permission: show info text
    showPermissionInfo()
    updatePermissionInfoDisplay()
  } else if (mode === 'owner-based') {
    // Owner-based mode: show notification if non-owner
    hideAccessControlWidgets()
    showOwnerBasedNotification()
  } else {
    // Role-based mode: hide all permission widgets
    hideAccessControlWidgets()
  }
}

/**
 * Shows the permission switches (granular mode)
 * @returns {void}
 */
function showPermissionSwitches() {
  if (permissionInfoWidget) permissionInfoWidget.style.display = 'none'
  if (permissionsDropdown) permissionsDropdown.style.display = ''
}

/**
 * Shows permission info text (granular mode, non-modifiable)
 * @returns {void}
 */
function showPermissionInfo() {
  if (permissionInfoWidget) permissionInfoWidget.style.display = ''
  if (permissionsDropdown) permissionsDropdown.style.display = 'none'
}

/**
 * Updates switch states from current permissions
 * @returns {void}
 */
function updateSwitchStates() {
  if (visibilitySwitch) {
    visibilitySwitch.checked = currentPermissions.visibility === 'collection'
    visibilitySwitch.textContent = currentPermissions.visibility === 'collection' ? 'Visible to all' : 'Visible to owner'
  }
  if (editabilitySwitch) {
    editabilitySwitch.checked = currentPermissions.editability === 'collection'
    editabilitySwitch.textContent = currentPermissions.editability === 'collection' ? 'Editable by all' : 'Editable by owner'
  }
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

  if (visibility === 'owner') {
    infoText = owner ? `Owner-only (${owner})` : 'Owner-only'
    variant = 'warning'
  } else {
    infoText = 'Collection'
  }

  if (editability === 'owner') {
    infoText += ' • Owner edits'
    variant = 'warning'
  }

  permissionInfoWidget.text = infoText
  permissionInfoWidget.variant = variant
}

/**
 * Shows notification for owner-based mode when non-owner
 * @returns {void}
 */
function showOwnerBasedNotification() {
  const currentUser = authentication.getUser()
  const owner = currentPermissions.owner

  if (owner && owner !== currentUser?.username && !userHasReviewerRole(currentUser)) {
    notify(
      `This document is owned by ${owner}. Create your own version to edit.`,
      'warning',
      'exclamation-triangle'
    )
  }
}

/**
 * Hides access control widgets
 * @returns {void}
 */
function hideAccessControlWidgets() {
  if (permissionInfoWidget) permissionInfoWidget.style.display = 'none'
  if (permissionsDropdown) permissionsDropdown.style.display = 'none'
}


/**
 * Checks if current user can edit the document
 * @param {UserData|null} user - Current user object
 * @returns {boolean}
 */
function canEditDocument(user) {
  const mode = accessControlConfig?.mode || 'role-based'
  const fileId = pluginState?.xml || undefined

  // Admin can always edit
  if (userIsAdmin(user)) {
    return true
  }

  // Check role-based file type restrictions (applies to all modes)
  if (fileId) {
    if (isGoldFile(fileId) && !userHasReviewerRole(user)) {
      return false
    }
    if (isVersionFile(fileId) && !userHasAnnotatorRole(user) && !userHasReviewerRole(user)) {
      return false
    }
  }

  if (mode === 'role-based') {
    // Role-based: file type restrictions already checked above
    return true
  } else if (mode === 'owner-based') {
    // Owner-based: only owner can edit
    return currentPermissions.owner === user?.username
  } else if (mode === 'granular') {
    // Granular: use permission settings
    return canEditDocumentWithPermissions(user, currentPermissions, fileId)
  }

  return true
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
  if (!editorReadOnly || !accessControlReadOnly) {
    return
  }

  updateReadOnlyWidgetText(ui.xmlEditor.statusbar.readOnlyStatus)
}

/**
 * Updates the read-only widget text with access control context
 * @param {StatusText} readOnlyWidget - The read-only status widget
 * @returns {void}
 */
function updateReadOnlyWidgetText(readOnlyWidget) {
  if (!readOnlyWidget) {
    return
  }

  const mode = accessControlConfig?.mode || 'role-based'
  const { owner } = currentPermissions
  const currentUser = authentication.getUser()

  let contextText = 'Read-only'

  // Check role-based file type restrictions
  if (pluginState?.xml) {
    if (isGoldFile(pluginState.xml) && !userHasReviewerRole(currentUser)) {
      contextText = 'Read-only (gold file - reviewer role required)'
    } else if (isVersionFile(pluginState.xml) && !userHasAnnotatorRole(currentUser) && !userHasReviewerRole(currentUser)) {
      contextText = 'Read-only (version file - annotator role required)'
    } else if (mode === 'owner-based' && owner && owner !== currentUser?.username) {
      contextText = `Read-only (owned by ${owner})`
    } else if (mode === 'granular' && currentPermissions.editability === 'owner' && owner !== currentUser?.username) {
      contextText = `Read-only (owned by ${owner})`
    }
  }

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

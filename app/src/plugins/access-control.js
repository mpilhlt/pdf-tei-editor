/**
 * Access Control plugin
 *
 * Manages document access permissions with three modes:
 * - role-based: only role restrictions (gold = reviewers only)
 * - owner-based: documents editable only by owner
 * - granular: database-backed per-document permissions
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { StatusSwitch } from '../modules/panels/widgets/status-switch.js'
 * @import { UserData } from './authentication.js'
 * @import { AccessControlModeResponse } from '../modules/api-client-v1.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import { PanelUtils } from '../modules/panels/index.js'
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
 * Access control API
 * @typedef {object} AccessControlAPI
 * @property {() => DocumentPermissions} getDocumentPermissions - Gets current document permissions
 * @property {(user: UserData|null) => boolean} canEditDocument - Checks if user can edit document
 * @property {(user: UserData|null) => boolean} canViewDocument - Checks if user can view document
 * @property {() => AccessControlMode} getMode - Gets current access control mode
 * @property {(fileId: string) => boolean} checkCanEditFile - Checks if user can edit file
 */

class AccessControlPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'access-control', deps: ['client', 'logger', 'xmleditor'] })
  }

  /** @type {AccessControlModeResponse | null} */
  #accessControlConfig = null

  /** @type {StatusText | null} */
  #permissionInfoWidget = null

  /** @type {HTMLElement | null} */
  #permissionsDropdown = null

  /** @type {StatusSwitch | null} */
  #visibilitySwitch = null

  /** @type {StatusSwitch | null} */
  #editabilitySwitch = null

  /** @type {DocumentPermissions} */
  #currentPermissions = {
    visibility: 'collection',
    editability: 'owner',
    owner: null,
    can_modify: false
  }

  /** @type {string | null} */
  #xmlCache = null

  #isUpdatingState = false

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    const logger = this.getDependency('logger')
    logger.debug(`Installing plugin "access-control"`)

    this.#permissionInfoWidget = PanelUtils.createText({
      text: '',
      variant: 'neutral'
    })

    this.#visibilitySwitch = this.#createVisibilitySwitch()
    this.#editabilitySwitch = this.#createEditabilitySwitch()
    this.#permissionsDropdown = this.#createPermissionsDropdown()

    const xmlEditor = this.getDependency('xmleditor')
    xmlEditor.addStatusbarWidget(this.#permissionInfoWidget, 'left', 1)
    xmlEditor.addStatusbarWidget(this.#permissionsDropdown, 'left', 2)

    this.#hideAccessControlWidgets()
  }

  async start() {
    try {
      this.#accessControlConfig = await this.getDependency('client').apiClient.filesAccessControlMode()
      this.getDependency('logger').info(`Access control mode: ${this.#accessControlConfig.mode}`)
    } catch (error) {
      this.getDependency('logger').error(`Failed to fetch access control mode: ${error}`)
      this.#accessControlConfig = {
        mode: 'role-based',
        default_visibility: 'collection',
        default_editability: 'owner'
      }
    }
  }

  /**
   * @param {string[]} changedKeys
   */
  async onStateUpdate(_changedKeys) {
    const state = this.state

    if (!state.xml) {
      this.#hideAccessControlWidgets()
      this.#xmlCache = null
      return
    }

    if (state.xml === this.#xmlCache) {
      // Update dropdown disabled state based on editorReadOnly
      if (this.#permissionsDropdown) {
        const triggerButton = this.#permissionsDropdown.querySelector('sl-icon-button')
        if (triggerButton) triggerButton.disabled = state.editorReadOnly
      }
      return
    }

    this.#xmlCache = state.xml
    this.getDependency('logger').debug(`Access control: Updating for document: ${state.xml}`)

    try {
      await this.#computeDocumentPermissions()
      this.#updateAccessControlUI()
    } catch (error) {
      this.getDependency('logger').error(`Access control error in onStateUpdate(): ${error}`)
    }

    const shouldBeReadOnly = !this.canEditDocument(state.user)

    if (shouldBeReadOnly && !state.editorReadOnly && !this.#isUpdatingState) {
      this.getDependency('logger').debug(`Setting editor read-only based on access control`)
      this.#isUpdatingState = true
      setTimeout(async () => {
        try {
          if (this.state && !this.state.editorReadOnly) {
            await this.dispatchStateChange({ editorReadOnly: true })
          }
        } finally {
          this.#isUpdatingState = false
        }
      }, 0)
    }

    this.#updateReadOnlyContext(state.editorReadOnly, shouldBeReadOnly)
  }

  /**
   * Gets current document permissions
   * @returns {DocumentPermissions}
   */
  getDocumentPermissions() {
    return this.#currentPermissions
  }

  /**
   * Checks if a user can edit the currently loaded document
   * @param {UserData|null} user
   * @returns {boolean}
   */
  canEditDocument(user) {
    const mode = this.#accessControlConfig?.mode || 'role-based'
    const fileId = this.state?.xml || undefined

    if (userIsAdmin(user)) return true

    if (fileId) {
      if (isGoldFile(fileId) && !userHasReviewerRole(user)) return false
      if (isVersionFile(fileId) && !userHasAnnotatorRole(user) && !userHasReviewerRole(user)) return false
    }

    if (mode === 'role-based') return true
    if (mode === 'owner-based') return this.#currentPermissions.owner === user?.username
    if (mode === 'granular') return canEditDocumentWithPermissions(user, this.#currentPermissions, fileId)

    return true
  }

  /**
   * Checks if a user can view the currently loaded document
   * @param {UserData|null} user
   * @returns {boolean}
   */
  canViewDocument(user) {
    return canViewDocumentWithPermissions(user, this.#currentPermissions)
  }

  /**
   * Gets the current access control mode
   * @returns {AccessControlMode}
   */
  getMode() {
    return this.#accessControlConfig?.mode || 'role-based'
  }

  /**
   * Checks if the current user can edit the given file
   * @param {string} fileId
   * @returns {boolean}
   */
  checkCanEditFile(fileId) {
    const currentUser = this.getDependency('authentication').getUser()
    return canEditFileFromUtils(currentUser, fileId)
  }

  /** @returns {HTMLElement} */
  #createPermissionsDropdown() {
    const dropdown = document.createElement('sl-dropdown')
    dropdown.setAttribute('placement', 'top-start')
    dropdown.setAttribute('distance', '4')

    const triggerButton = document.createElement('sl-icon-button')
    triggerButton.setAttribute('slot', 'trigger')
    triggerButton.setAttribute('name', 'gear')
    triggerButton.setAttribute('label', 'Document Permissions')
    triggerButton.title = 'Document permission settings'
    triggerButton.style.fontSize = '1rem'

    const menu = document.createElement('sl-menu')
    menu.style.minWidth = '200px'
    menu.style.padding = '8px'

    const header = document.createElement('div')
    header.style.cssText = 'font-weight: 600; font-size: 0.75rem; color: var(--sl-color-neutral-500); padding: 4px 8px; text-transform: uppercase;'
    header.textContent = 'Permissions'

    const visibilityItem = document.createElement('sl-menu-item')
    visibilityItem.style.cssText = '--submenu-offset: 0;'
    visibilityItem.appendChild(this.#visibilitySwitch)

    const editabilityItem = document.createElement('sl-menu-item')
    editabilityItem.style.cssText = '--submenu-offset: 0;'
    editabilityItem.appendChild(this.#editabilitySwitch)

    menu.addEventListener('sl-select', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })

    menu.appendChild(header)
    menu.appendChild(visibilityItem)
    menu.appendChild(editabilityItem)

    dropdown.appendChild(triggerButton)
    dropdown.appendChild(menu)

    return dropdown
  }

  /** @returns {StatusSwitch} */
  #createVisibilitySwitch() {
    const switchEl = PanelUtils.createSwitch({
      name: 'visibilitySwitch',
      text: 'Visible',
      checked: true,
      size: 'small'
    })
    switchEl.title = 'Checked = visible to all users with collection access, Unchecked = visible only to document owner'
    switchEl.addEventListener('widget-change', (e) => this.#handleVisibilityChange(e))
    return switchEl
  }

  /** @returns {StatusSwitch} */
  #createEditabilitySwitch() {
    const switchEl = PanelUtils.createSwitch({
      name: 'editabilitySwitch',
      text: 'Editable',
      checked: false,
      size: 'small'
    })
    switchEl.title = 'Checked = editable by all users with collection access, Unchecked = editable only by document owner'
    switchEl.addEventListener('widget-change', (e) => this.#handleEditabilityChange(e))
    return switchEl
  }

  /**
   * @param {CustomEvent} event
   */
  async #handleVisibilityChange(event) {
    const checked = event.detail.checked
    const newVisibility = checked ? 'collection' : 'owner'
    try {
      await this.#updateDocumentPermissions(newVisibility, this.#currentPermissions.editability)
      this.getDependency('logger').info(`Visibility updated to: ${newVisibility}`)
    } catch (error) {
      this.getDependency('logger').error(`Failed to update visibility: ${error}`)
      notify(`Failed to update visibility: ${String(error)}`, 'danger', 'exclamation-octagon')
      if (this.#visibilitySwitch) this.#visibilitySwitch.checked = this.#currentPermissions.visibility === 'collection'
    }
  }

  /**
   * @param {CustomEvent} event
   */
  async #handleEditabilityChange(event) {
    const checked = event.detail.checked
    const newEditability = checked ? 'collection' : 'owner'
    try {
      await this.#updateDocumentPermissions(this.#currentPermissions.visibility, newEditability)
      this.getDependency('logger').info(`Editability updated to: ${newEditability}`)
    } catch (error) {
      this.getDependency('logger').error(`Failed to update editability: ${error}`)
      notify(`Failed to update editability: ${String(error)}`, 'danger', 'exclamation-octagon')
      if (this.#editabilitySwitch) this.#editabilitySwitch.checked = this.#currentPermissions.editability === 'collection'
    }
  }

  async #computeDocumentPermissions() {
    const mode = this.#accessControlConfig?.mode || 'role-based'
    const fileData = getFileDataById(this.state?.xml)
    const currentUser = this.getDependency('authentication').getUser()
    const owner = fileData?.item?.created_by || null

    if (mode === 'role-based') {
      this.#currentPermissions = { visibility: 'collection', editability: 'collection', owner, can_modify: false }
    } else if (mode === 'owner-based') {
      this.#currentPermissions = { visibility: 'collection', editability: 'owner', owner, can_modify: false }
    } else if (mode === 'granular') {
      if (!this.state?.xml) {
        this.#currentPermissions = {
          visibility: this.#accessControlConfig?.default_visibility || 'collection',
          editability: this.#accessControlConfig?.default_editability || 'owner',
          owner,
          can_modify: false
        }
        return
      }
      try {
        const perms = await this.getDependency('client').apiClient.filesPermissions(this.state.xml)
        const isOwner = perms.owner === currentUser?.username
        const isReviewer = userHasReviewerRole(currentUser)
        const isAdmin = userIsAdmin(currentUser)
        this.#currentPermissions = {
          visibility: perms.visibility,
          editability: perms.editability,
          owner: perms.owner,
          can_modify: isOwner || isReviewer || isAdmin
        }
      } catch (error) {
        this.getDependency('logger').debug(`Failed to fetch permissions (using defaults): ${error}`)
        this.#currentPermissions = {
          visibility: this.#accessControlConfig?.default_visibility || 'collection',
          editability: this.#accessControlConfig?.default_editability || 'owner',
          owner,
          can_modify: false
        }
      }
    }

    this.getDependency('logger').debug(`Document permissions: ${JSON.stringify(this.#currentPermissions)}`)
  }

  /**
   * @param {string} visibility
   * @param {string} editability
   */
  async #updateDocumentPermissions(visibility, editability) {
    const mode = this.#accessControlConfig?.mode || 'role-based'
    if (mode !== 'granular') throw new Error('Permission modification only available in granular mode')
    if (!this.state?.xml) throw new Error('No document loaded')

    const fileData = getFileDataById(this.state?.xml)
    const response = await this.getDependency('client').apiClient.filesSetPermissions({
      stable_id: this.state.xml,
      visibility,
      editability,
      owner: this.#currentPermissions.owner || fileData?.created_by || ''
    })

    this.#currentPermissions.visibility = response.visibility
    this.#currentPermissions.editability = response.editability
    this.#currentPermissions.owner = response.owner
    this.#updateAccessControlUI()
  }

  #updateAccessControlUI() {
    const mode = this.#accessControlConfig?.mode || 'role-based'
    if (mode === 'granular' && this.#currentPermissions.can_modify) {
      this.#showPermissionSwitches()
      this.#updateSwitchStates()
    } else if (mode === 'granular' && !this.#currentPermissions.can_modify) {
      this.#showPermissionInfo()
      this.#updatePermissionInfoDisplay()
    } else if (mode === 'owner-based') {
      this.#hideAccessControlWidgets()
      this.#showOwnerBasedNotification()
    } else {
      this.#hideAccessControlWidgets()
    }
  }

  #showPermissionSwitches() {
    if (this.#permissionInfoWidget) this.#permissionInfoWidget.style.display = 'none'
    if (this.#permissionsDropdown) this.#permissionsDropdown.style.display = ''
  }

  #showPermissionInfo() {
    if (this.#permissionInfoWidget) this.#permissionInfoWidget.style.display = ''
    if (this.#permissionsDropdown) this.#permissionsDropdown.style.display = 'none'
  }

  #updateSwitchStates() {
    if (this.#visibilitySwitch) {
      this.#visibilitySwitch.checked = this.#currentPermissions.visibility === 'collection'
      this.#visibilitySwitch.textContent = this.#currentPermissions.visibility === 'collection' ? 'Visible to all' : 'Visible to owner'
    }
    if (this.#editabilitySwitch) {
      this.#editabilitySwitch.checked = this.#currentPermissions.editability === 'collection'
      this.#editabilitySwitch.textContent = this.#currentPermissions.editability === 'collection' ? 'Editable by all' : 'Editable by owner'
    }
  }

  #updatePermissionInfoDisplay() {
    if (!this.#permissionInfoWidget) return
    const { visibility, editability, owner } = this.#currentPermissions
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
    this.#permissionInfoWidget.text = infoText
    this.#permissionInfoWidget.variant = variant
  }

  #showOwnerBasedNotification() {
    const currentUser = this.getDependency('authentication').getUser()
    const owner = this.#currentPermissions.owner
    const isOwner = owner && owner === currentUser?.username
    if (!isOwner) {
      if (owner) {
        notify(
          `This document is owned by ${owner}. Use "Save Revision → Save to a new personal copy" to work on your own copy.`,
          'warning', 'exclamation-triangle'
        )
      } else {
        notify(
          `This document has no owner and is read-only. Use "Save Revision → Save to a new personal copy" to create an editable copy.`,
          'warning', 'exclamation-triangle'
        )
      }
    }
  }

  #hideAccessControlWidgets() {
    if (this.#permissionInfoWidget) this.#permissionInfoWidget.style.display = 'none'
    if (this.#permissionsDropdown) this.#permissionsDropdown.style.display = 'none'
  }

  /**
   * @param {boolean} editorReadOnly
   * @param {boolean} accessControlReadOnly
   */
  #updateReadOnlyContext(editorReadOnly, accessControlReadOnly) {
    if (!editorReadOnly || !accessControlReadOnly) return
    const mode = this.#accessControlConfig?.mode || 'role-based'
    const { owner } = this.#currentPermissions
    const currentUser = this.getDependency('authentication').getUser()
    let contextText = 'Read-only'
    if (this.state?.xml) {
      if (isGoldFile(this.state.xml) && !userHasReviewerRole(currentUser)) {
        contextText = 'Read-only (gold file - reviewer role required)'
      } else if (isVersionFile(this.state.xml) && !userHasAnnotatorRole(currentUser) && !userHasReviewerRole(currentUser)) {
        contextText = 'Read-only (version file - annotator role required)'
      } else if (mode === 'owner-based' && owner && owner !== currentUser?.username) {
        contextText = `Read-only (owned by ${owner}) — save to a personal copy to edit`
      } else if (mode === 'granular' && this.#currentPermissions.editability === 'owner' && owner !== currentUser?.username) {
        contextText = `Read-only (owned by ${owner})`
      }
    }
    this.getDependency('xmleditor').setReadOnlyContext(contextText)
    this.getDependency('logger').debug(`Updated read-only context: ${contextText}`)
  }
}

export default AccessControlPlugin

/** @deprecated Use getDependency('access-control') instead */
export const api = new Proxy({}, {
  get(_, prop) {
    const instance = AccessControlPlugin.getInstance()
    const value = instance[prop]
    return typeof value === 'function' ? value.bind(instance) : value
  },
  set(_, prop, value) {
    AccessControlPlugin.getInstance()[prop] = value
    return true
  }
})

export const plugin = AccessControlPlugin

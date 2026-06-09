/**
 * RBAC Manager Plugin
 *
 * Provides visual management interface for Users, Groups, Roles, and Collections.
 * Uses entity-driven architecture for extensibility.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { rbacManagerDialogPart } from '../templates/rbac-manager-dialog.types.js'
 * @import { ToolsPlugin } from './tools.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { getEntitySchema, getEntityTypes } from '../modules/rbac/entity-schemas.js'
import { renderEntityForm, extractFormData, displayFormErrors, clearFormErrors } from '../modules/rbac/form-renderer.js'
import { createEntityManagers } from '../modules/rbac/entity-manager.js'
import { userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'
import { createValueEditor } from '../modules/config-value-editor.js'
import { createMemberPicker } from '../modules/rbac/member-picker.js'

// Register templates
await registerTemplate('rbac-manager-dialog', 'rbac-manager-dialog.html')
await registerTemplate('rbac-manager-menu-item', 'rbac-manager-menu-item.html')

// Icons used in rbac-manager templates (needed for build system to include them)
// <sl-icon name="person"></sl-icon>
// <sl-icon name="people"></sl-icon>
// <sl-icon name="shield"></sl-icon>
// <sl-icon name="shield-lock"></sl-icon>
// <sl-icon name="plus"></sl-icon>
// <sl-icon name="check"></sl-icon>
// <sl-icon name="trash"></sl-icon>

class RbacManagerPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'rbac-manager', deps: ['client', 'toolbar', 'tools', 'logger'] })
  }

  /** @type {SlDialog & rbacManagerDialogPart} */
  #ui = null

  /** @type {HTMLElement | null} */
  #menuItem = null

  /** @type {Record<string, import('../modules/rbac/entity-manager.js').EntityManager>} */
  #entityManagers = {}

  /** @type {string} */
  #currentEntityType = 'user'

  /** @type {string | null} */
  #selectedEntityId = null

  /** @type {boolean} */
  #isNewEntity = false

  /** @type {Record<string, any[]>} */
  #optionsData = {}

  /** @type {Record<string, any>} */
  #collectionConfig = {}

  /** @type {Record<string, any>} */
  #globalConfigData = {}

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    const logger = this.getDependency('logger')
    logger.debug(`Installing plugin "rbac-manager"`)

    this.#ui = this.createUi(createSingleFromTemplate('rbac-manager-dialog', document.body))
    this.#entityManagers = createEntityManagers(this.getDependency('client').apiClient)
    this.#setupDialogListeners()
  }

  async start() {
    this.#menuItem = createSingleFromTemplate('rbac-manager-menu-item')
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
    const dialog = this.#ui

    dialog.querySelector('[name="closeBtn"]').addEventListener('click', () => dialog.hide())

    dialog.querySelector('[name="addConfigKeyBtn"]').addEventListener('click', () => {
      if ((this.#currentEntityType === 'collection' || this.#currentEntityType === 'project') && this.#selectedEntityId) {
        this.#addCollectionConfigRow()
      }
    })

    dialog.querySelector('[name="tabUser"]').addEventListener('click', () => this.#switchTab('user'))
    dialog.querySelector('[name="tabProject"]').addEventListener('click', () => this.#switchTab('project'))
    dialog.querySelector('[name="tabGroup"]').addEventListener('click', () => this.#switchTab('group'))
    dialog.querySelector('[name="tabRole"]').addEventListener('click', () => this.#switchTab('role'))
    dialog.querySelector('[name="tabCollection"]').addEventListener('click', () => this.#switchTab('collection'))

    dialog.querySelector('[name="addEntityBtn"]').addEventListener('click', () => this.#createNewEntity())
    dialog.querySelector('[name="saveBtn"]').addEventListener('click', () => this.#saveEntity())
    dialog.querySelector('[name="deleteBtn"]').addEventListener('click', () => this.#deleteEntity())
    dialog.querySelector('[name="searchInput"]').addEventListener('input', e => this.#handleSearch(e))
  }

  /** Open the RBAC manager dialog */
  async #openDialog() {
    const dialog = this.#ui

    try {
      await this.#loadAllEntities()
      dialog.show()
      await this.#switchTab('user')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.getDependency('logger').error(`Failed to open RBAC manager: ${errorMessage}`)
      notify('Failed to load RBAC data', 'danger')
    }
  }

  /** Load all entities from server */
  async #loadAllEntities() {
    const promises = []

    for (const entityType of getEntityTypes()) {
      promises.push(
        this.#entityManagers[entityType].loadAll().catch(err => {
          const errorMessage = err instanceof Error ? err.message : String(err)
          this.getDependency('logger').warn(`Failed to load ${entityType}s: ${errorMessage}`)
          return []
        })
      )
    }

    await Promise.all(promises)

    // Load global config for collection config key suggestions
    try {
      const configResponse = await this.getDependency('client').apiClient.configList()
      this.#globalConfigData = configResponse || {}
    } catch (err) {
      this.getDependency('logger').warn(`Failed to load global config: ${err}`)
    }

    this.#optionsData = {
      project: this.#entityManagers.project.getAll(),
      user: this.#entityManagers.user.getAll(),
      group: this.#entityManagers.group.getAll(),
      role: this.#entityManagers.role.getAll(),
      collection: this.#entityManagers.collection.getAll()
    }
  }

  /**
   * Switch to a different entity type tab
   * @param {string} entityType
   */
  async #switchTab(entityType) {
    const dialog = this.#ui

    this.#currentEntityType = entityType
    this.#selectedEntityId = null
    this.#isNewEntity = false

    const tabs = dialog.querySelectorAll('[name^="tab"]')
    tabs.forEach(tab => {
      if (tab.dataset.entityType === entityType) {
        tab.variant = 'primary'
      } else {
        tab.variant = 'default'
      }
    })

    const configSection = this.#ui.querySelector('[name="entityConfigSection"]')
    if (configSection) configSection.style.display = 'none'

    const membersSection = this.#ui.querySelector('[name="groupMembersSection"]')
    if (membersSection) membersSection.style.display = 'none'

    this.#renderEntityList()
    this.#showEmptyState()
  }

  /**
   * Render the entity list for current entity type
   * @param {string} [searchTerm]
   */
  #renderEntityList(searchTerm = '') {
    const dialog = this.#ui

    const schema = getEntitySchema(this.#currentEntityType)
    if (!schema) return

    dialog.querySelector('[name="entityListTitle"]').textContent = schema.label

    let entities = this.#entityManagers[this.#currentEntityType].getAll()

    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      entities = entities.filter(entity => {
        const idValue = entity[schema.idField]
        const nameValue = entity.name || entity.roleName || entity.fullname || ''
        return (
          idValue?.toLowerCase().includes(term) ||
          nameValue?.toLowerCase().includes(term)
        )
      })
    }

    const entityListEl = dialog.querySelector('[name="entityList"]')
    entityListEl.innerHTML = ''

    if (entities.length === 0) {
      const emptyMessage = document.createElement('div')
      emptyMessage.style.color = 'var(--sl-color-neutral-500)'
      emptyMessage.style.fontStyle = 'italic'
      emptyMessage.style.padding = '1rem'
      emptyMessage.textContent = searchTerm ? 'No matches found' : `No ${schema.label.toLowerCase()} available`
      entityListEl.appendChild(emptyMessage)
      return
    }

    entities.forEach(entity => {
      const item = document.createElement('div')
      item.className = 'entity-list-item'
      item.style.padding = '0.5rem'
      item.style.cursor = 'pointer'
      item.style.borderRadius = 'var(--sl-border-radius-small)'
      item.style.marginBottom = '0.25rem'
      item.dataset.entityId = entity[schema.idField]

      if (this.#selectedEntityId === entity[schema.idField]) {
        item.style.backgroundColor = 'var(--sl-color-primary-100)'
      }

      const idSpan = document.createElement('div')
      idSpan.style.fontWeight = '600'
      idSpan.style.fontSize = '0.875rem'
      idSpan.textContent = entity[schema.idField]

      const nameSpan = document.createElement('div')
      nameSpan.style.fontSize = '0.75rem'
      nameSpan.style.color = 'var(--sl-color-neutral-600)'
      nameSpan.textContent = entity.name || entity.roleName || entity.fullname || ''

      item.appendChild(idSpan)
      if (nameSpan.textContent) {
        item.appendChild(nameSpan)
      }

      item.addEventListener('mouseenter', () => {
        if (this.#selectedEntityId !== entity[schema.idField]) {
          item.style.backgroundColor = 'var(--sl-color-neutral-100)'
        }
      })
      item.addEventListener('mouseleave', () => {
        if (this.#selectedEntityId !== entity[schema.idField]) {
          item.style.backgroundColor = ''
        }
      })

      item.addEventListener('click', () => this.#selectEntity(entity[schema.idField]))

      entityListEl.appendChild(item)
    })
  }

  /**
   * Select an entity from the list
   * @param {string} entityId
   */
  #selectEntity(entityId) {
    this.#selectedEntityId = entityId
    this.#isNewEntity = false
    this.#renderEntityList()
    this.#showEntityForm()
  }

  /** Create a new entity */
  #createNewEntity() {
    this.#selectedEntityId = null
    this.#isNewEntity = true
    this.#showEntityForm()
  }

  /** Show the entity form for selected or new entity */
  #showEntityForm() {
    const dialog = this.#ui

    const schema = getEntitySchema(this.#currentEntityType)
    if (!schema) return

    const formContainer = dialog.querySelector('[name="formContainer"]')

    const emptyState = formContainer.querySelector('[name="emptyState"]')
    if (emptyState) {
      emptyState.style.display = 'none'
    }

    const existingForms = formContainer.querySelectorAll('form')
    existingForms.forEach(form => form.remove())

    const formTitle = dialog.querySelector('[name="formTitle"]')
    if (this.#isNewEntity) {
      formTitle.textContent = `New ${schema.singularLabel}`
    } else {
      formTitle.textContent = `Edit ${schema.singularLabel}: ${this.#selectedEntityId}`
    }

    dialog.querySelector('[name="saveBtn"]').disabled = false
    dialog.querySelector('[name="deleteBtn"]').disabled = this.#isNewEntity

    let entityData = {}
    if (!this.#isNewEntity && this.#selectedEntityId) {
      const entity = this.#entityManagers[this.#currentEntityType].findById(this.#selectedEntityId)
      if (entity) {
        entityData = { ...entity }
      }
    }

    const form = renderEntityForm(this.#currentEntityType, entityData, this.#optionsData, this.#isNewEntity)
    const firstSection = formContainer.querySelector('[name="entityConfigSection"]') || formContainer.querySelector('[name="groupMembersSection"]')
    formContainer.insertBefore(form, firstSection)

    if ((this.#currentEntityType === 'collection' || this.#currentEntityType === 'project') && !this.#isNewEntity && this.#selectedEntityId) {
      this.#loadAndRenderCollectionConfig(this.#selectedEntityId)
    } else {
      const section = this.#ui.querySelector('[name="entityConfigSection"]')
      if (section) section.style.display = 'none'
    }

    if (this.#currentEntityType === 'group' && !this.#isNewEntity && this.#selectedEntityId) {
      this.#renderGroupMembersWidget(this.#selectedEntityId)
    } else {
      const section = this.#ui.querySelector('[name="groupMembersSection"]')
      if (section) section.style.display = 'none'
    }
  }

  /** Show empty state (no entity selected) */
  #showEmptyState() {
    const dialog = this.#ui

    const formContainer = dialog.querySelector('[name="formContainer"]')

    let emptyState = formContainer.querySelector('[name="emptyState"]')
    if (!emptyState) {
      emptyState = document.createElement('div')
      emptyState.setAttribute('name', 'emptyState')
      emptyState.style.display = 'flex'
      emptyState.style.flexDirection = 'column'
      emptyState.style.alignItems = 'center'
      emptyState.style.justifyContent = 'center'
      emptyState.style.height = '100%'
      emptyState.style.color = 'var(--sl-color-neutral-500)'
      emptyState.innerHTML = `
        <sl-icon name="inbox" style="font-size: 3rem; margin-bottom: 1rem;"></sl-icon>
        <p style="margin: 0;">Select an item from the list or create a new one</p>
      `
      formContainer.appendChild(emptyState)
    } else {
      emptyState.style.display = 'flex'
    }

    const forms = formContainer.querySelectorAll('form')
    forms.forEach(form => form.remove())

    dialog.querySelector('[name="formTitle"]').textContent = 'Select an item'
    dialog.querySelector('[name="saveBtn"]').disabled = true
    dialog.querySelector('[name="deleteBtn"]').disabled = true

    const configSection = dialog.querySelector('[name="entityConfigSection"]')
    if (configSection) configSection.style.display = 'none'

    const membersSection = dialog.querySelector('[name="groupMembersSection"]')
    if (membersSection) membersSection.style.display = 'none'
  }

  /** Save entity (create or update) */
  async #saveEntity() {
    const dialog = this.#ui

    const form = dialog.querySelector('[name="formContainer"]').querySelector('form')
    if (!form) return

    try {
      const data = extractFormData(form)
      clearFormErrors(form)

      if (this.#isNewEntity) {
        await this.#entityManagers[this.#currentEntityType].create(data)
        notify(`${getEntitySchema(this.#currentEntityType)?.singularLabel} created successfully`, 'success')

        await this.#loadAllEntities()

        const schema = getEntitySchema(this.#currentEntityType)
        if (schema) {
          this.#selectedEntityId = data[schema.idField]
          this.#isNewEntity = false
        }
      } else {
        if (this.#selectedEntityId) {
          await this.#entityManagers[this.#currentEntityType].update(this.#selectedEntityId, data)
          notify(`${getEntitySchema(this.#currentEntityType)?.singularLabel} updated successfully`, 'success')

          await this.#loadAllEntities()
        }
      }

      this.#renderEntityList()
      this.#showEntityForm()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.getDependency('logger').error(`Failed to save entity: ${errorMessage}`)

      if (error instanceof Error && error.message.startsWith('Validation failed:')) {
        const errors = error.message.replace('Validation failed: ', '').split(', ')
        displayFormErrors(form, errors)
        notify(`Failed to save ${getEntitySchema(this.#currentEntityType)?.singularLabel}: ${errorMessage}`, 'danger')
      } else {
        displayFormErrors(form, [errorMessage])
        notify(`Failed to save ${getEntitySchema(this.#currentEntityType)?.singularLabel}: ${errorMessage}`, 'danger')
      }
    }
  }

  /** Delete selected entity */
  async #deleteEntity() {
    if (!this.#selectedEntityId || this.#isNewEntity) return

    const dialog = this.#ui

    const schema = getEntitySchema(this.#currentEntityType)
    if (!schema) return

    const confirmed = confirm(`Are you sure you want to delete ${schema.singularLabel} "${this.#selectedEntityId}"?`)
    if (!confirmed) return

    try {
      await this.#entityManagers[this.#currentEntityType].delete(this.#selectedEntityId)
      notify(`${schema.singularLabel} deleted successfully`, 'success')

      await this.#loadAllEntities()

      this.#selectedEntityId = null
      this.#isNewEntity = false

      this.#renderEntityList()
      this.#showEmptyState()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.getDependency('logger').error(`Failed to delete entity: ${errorMessage}`)
      notify(`Failed to delete ${schema.singularLabel}: ${errorMessage}`, 'danger')
    }
  }

  /**
   * Handle search input
   * @param {Event} event
   */
  #handleSearch(event) {
    const searchTerm = /** @type {HTMLInputElement} */(event.target).value
    this.#renderEntityList(searchTerm)
  }

  /**
   * Load entity config overrides and render the section.
   * @param {string} entityId
   */
  async #loadAndRenderCollectionConfig(entityId) {
    const section = this.#ui.querySelector('[name="entityConfigSection"]')
    section.style.display = 'block'
    try {
      const apiClient = this.getDependency('client').apiClient
      const response = this.#currentEntityType === 'project'
        ? await apiClient.projectsGetConfig(entityId)
        : await apiClient.collectionsGetConfig(entityId)
      this.#collectionConfig = response?.config || {}
    } catch (err) {
      this.#collectionConfig = {}
      this.getDependency('logger').warn(`Failed to load ${this.#currentEntityType} config: ${err}`)
    }
    this.#renderCollectionConfigList(entityId)
  }

  /**
   * Render the list of collection config override rows.
   * @param {string} collectionId
   */
  #renderCollectionConfigList(collectionId) {
    const listEl = this.#ui.querySelector('[name="entityConfigList"]')
    listEl.innerHTML = ''

    const configKeys = Object.keys(this.#collectionConfig)
    if (configKeys.length === 0) {
      listEl.innerHTML = '<div style="color: var(--sl-color-neutral-500); font-size: 0.85em; padding: 0.5rem;">No config overrides</div>'
      return
    }

    for (const key of configKeys.sort()) {
      const value = this.#collectionConfig[key]
      const allowedValues = this.#globalConfigData[`${key}.values`]
      listEl.appendChild(this.#createCollectionConfigRow(collectionId, key, value, allowedValues))
    }
  }

  /**
   * Create a single config override row element.
   * @param {string} collectionId
   * @param {string} key
   * @param {any} value
   * @param {any[]} [allowedValues]
   * @returns {HTMLElement}
   */
  #createCollectionConfigRow(collectionId, key, value, allowedValues) {
    const row = document.createElement('div')
    row.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;'
    row.dataset.key = key

    const keyLabel = document.createElement('span')
    keyLabel.style.cssText = 'flex: 0 0 40%; font-family: monospace; font-size: 0.85em; word-break: break-all;'
    keyLabel.textContent = key
    row.appendChild(keyLabel)

    const { container: editorContainer } = createValueEditor(key, value, allowedValues, false, async (k, newVal) => {
      await this.#saveCollectionConfigKey(collectionId, k, newVal)
    })
    editorContainer.style.flex = '1'
    row.appendChild(editorContainer)

    const deleteBtn = document.createElement('sl-icon-button')
    deleteBtn.setAttribute('name', 'trash')
    deleteBtn.setAttribute('label', 'Remove override')
    deleteBtn.addEventListener('click', async () => {
      await this.#deleteCollectionConfigKey(collectionId, key)
    })
    row.appendChild(deleteBtn)

    return row
  }

  /** Show a row to add a new config key override. */
  #addCollectionConfigRow() {
    const listEl = this.#ui.querySelector('[name="entityConfigList"]')

    // Don't add a second "add" row if one already exists
    if (listEl.querySelector('.add-config-row')) return

    const addRow = document.createElement('div')
    addRow.className = 'add-config-row'
    addRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;'

    const globalKeys = Object.keys(this.#globalConfigData)
      .filter(k => !k.endsWith('.type') && !k.endsWith('.values') && !k.endsWith('.description'))
      .filter(k => !(k in this.#collectionConfig))
      .sort()

    const keySelect = document.createElement('sl-select')
    keySelect.setAttribute('size', 'small')
    keySelect.setAttribute('placeholder', 'Select config key...')
    keySelect.style.flex = '0 0 40%'
    globalKeys.forEach(k => {
      const opt = document.createElement('sl-option')
      opt.value = k
      opt.textContent = k
      keySelect.appendChild(opt)
    })
    addRow.appendChild(keySelect)

    const hintSpan = document.createElement('span')
    hintSpan.style.cssText = 'flex: 1; font-size: 0.8em; color: var(--sl-color-neutral-500);'
    hintSpan.textContent = 'Select a key first'
    addRow.appendChild(hintSpan)

    const confirmBtn = document.createElement('sl-button')
    confirmBtn.setAttribute('size', 'small')
    confirmBtn.setAttribute('variant', 'primary')
    confirmBtn.textContent = 'Add'
    confirmBtn.disabled = true
    addRow.appendChild(confirmBtn)

    const cancelBtn = document.createElement('sl-icon-button')
    cancelBtn.setAttribute('name', 'x')
    cancelBtn.setAttribute('label', 'Cancel')
    cancelBtn.addEventListener('click', () => addRow.remove())
    addRow.appendChild(cancelBtn)

    keySelect.addEventListener('sl-change', () => {
      const selectedKey = String(keySelect.value)
      confirmBtn.disabled = !selectedKey
      hintSpan.textContent = selectedKey
        ? `Global default: ${JSON.stringify(this.#globalConfigData[selectedKey])}`
        : 'Select a key first'
    })

    confirmBtn.addEventListener('click', async () => {
      const selectedKey = String(keySelect.value)
      if (!selectedKey) return
      const defaultValue = this.#globalConfigData[selectedKey]
      await this.#saveCollectionConfigKey(this.#selectedEntityId, selectedKey, defaultValue)
      addRow.remove()
    })

    listEl.insertBefore(addRow, listEl.firstChild)
  }

  /**
   * Save a config key override to the server.
   * @param {string} entityId
   * @param {string} key
   * @param {any} value
   */
  async #saveCollectionConfigKey(entityId, key, value) {
    try {
      const apiClient = this.getDependency('client').apiClient
      if (this.#currentEntityType === 'project') {
        await apiClient.projectsCreateConfig(entityId, { key, value })
      } else {
        await apiClient.collectionsCreateConfig(entityId, { key, value })
      }
      this.#collectionConfig[key] = value
      this.#renderCollectionConfigList(entityId)
    } catch (err) {
      notify(`Failed to save config override: ${err}`, 'danger', 'exclamation-octagon')
    }
  }

  /**
   * Render the group members section as an interactive member picker widget.
   * @param {string} groupId
   */
  #renderGroupMembersWidget(groupId) {
    const section = this.#ui.querySelector('[name="groupMembersSection"]')
    if (!section) return
    section.style.display = 'block'

    const listEl = this.#ui.querySelector('[name="groupMembersList"]')
    listEl.innerHTML = ''

    const allUsers = this.#entityManagers.user.getAll()
    const members = allUsers.filter(u => (u.groups || []).includes(groupId))
    const nonMembers = allUsers.filter(u => !(u.groups || []).includes(groupId))

    const picker = createMemberPicker({
      label: 'Members',
      columns: [
        { key: 'username', label: 'Username', monospace: true },
        { key: 'fullname', label: 'Full Name' }
      ],
      items: members,
      availableOptions: nonMembers.map(u => ({
        value: u.username,
        primaryLabel: u.username,
        secondaryLabel: u.fullname || ''
      })),
      onAdd: async (username) => {
        await this.#addUserToGroup(username, groupId)
      },
      onRemove: async (item) => {
        await this.#removeUserFromGroup(item.username, groupId)
      }
    })

    listEl.appendChild(picker.element)
  }

  /**
   * Render the project members section as an interactive member picker widget.
   * Selecting a group option expands it — all users in that group are added individually.
   * @param {string} projectId
   */
  #renderProjectMembersSection(projectId) {
    const section = this.#ui.querySelector('[name="projectMembersSection"]')
    if (!section) return
    section.style.display = 'block'

    const listEl = this.#ui.querySelector('[name="projectMembersList"]')
    listEl.innerHTML = ''

    const project = this.#entityManagers.project.findById(projectId)
    const currentMemberIds = project?.members || []

    const memberObjects = currentMemberIds
      .map(username => this.#entityManagers.user.findById(username))
      .filter(Boolean)

    const nonMembers = this.#entityManagers.user.getAll()
      .filter(u => !currentMemberIds.includes(u.username))

    const groups = this.#entityManagers.group.getAll()

    const availableOptions = [
      ...nonMembers.map(u => ({
        value: u.username,
        primaryLabel: u.username,
        secondaryLabel: u.fullname || '',
        optionGroup: 'Users'
      })),
      ...groups.map(g => ({
        value: g.id,
        primaryLabel: g.id,
        secondaryLabel: g.name || '',
        optionGroup: 'Groups'
      }))
    ]

    const picker = createMemberPicker({
      label: 'Members',
      columns: [
        { key: 'username', label: 'Username', monospace: true },
        { key: 'fullname', label: 'Full Name' }
      ],
      items: memberObjects,
      availableOptions,
      onAdd: async (value) => {
        await this.#addProjectMember(projectId, value)
      },
      onRemove: async (item) => {
        await this.#removeProjectMember(projectId, item.username)
      }
    })

    listEl.appendChild(picker.element)
  }

  /**
   * Add a user (or all users in a group) to a project's members array.
   * If value is a group id, all users in that group are added individually.
   * @param {string} projectId
   * @param {string} value - A username or group ID
   */
  async #addProjectMember(projectId, value) {
    const project = this.#entityManagers.project.findById(projectId)
    if (!project) return

    const currentMembers = [...(project.members || [])]
    let updatedMembers

    if (this.#entityManagers.group.findById(value)) {
      const usersInGroup = this.#entityManagers.user.getAll()
        .filter(u => (u.groups || []).includes(value))
      const newUsernames = usersInGroup
        .map(u => u.username)
        .filter(username => !currentMembers.includes(username))
      updatedMembers = [...currentMembers, ...newUsernames]
    } else {
      updatedMembers = [...currentMembers, value]
    }

    try {
      await this.#entityManagers.project.update(projectId, { ...project, members: updatedMembers })
      this.#renderProjectMembersSection(projectId)
    } catch (err) {
      notify(`Failed to add project member: ${err}`, 'danger', 'exclamation-octagon')
    }
  }

  /**
   * Remove a user from a project's members array.
   * @param {string} projectId
   * @param {string} username
   */
  async #removeProjectMember(projectId, username) {
    const project = this.#entityManagers.project.findById(projectId)
    if (!project) return

    const updatedMembers = (project.members || []).filter(m => m !== username)
    try {
      await this.#entityManagers.project.update(projectId, { ...project, members: updatedMembers })
      this.#renderProjectMembersSection(projectId)
    } catch (err) {
      notify(`Failed to remove project member: ${err}`, 'danger', 'exclamation-octagon')
    }
  }

  /**
   * Add a user to a group by appending groupId to the user's groups[] on the server.
   * @param {string} username
   * @param {string} groupId
   */
  async #addUserToGroup(username, groupId) {
    const user = this.#entityManagers.user.findById(username)
    if (!user) return
    const updatedGroups = [...(user.groups || []), groupId]
    try {
      await this.#entityManagers.user.update(username, { ...user, groups: updatedGroups })
      this.#renderGroupMembersWidget(groupId)
    } catch (err) {
      notify(`Failed to add user to group: ${err}`, 'danger', 'exclamation-octagon')
    }
  }

  /**
   * Remove a user from a group by updating the user's groups[] on the server.
   * @param {string} username
   * @param {string} groupId
   */
  async #removeUserFromGroup(username, groupId) {
    const user = this.#entityManagers.user.findById(username)
    if (!user) return
    const updatedGroups = (user.groups || []).filter(g => g !== groupId)
    try {
      await this.#entityManagers.user.update(username, { ...user, groups: updatedGroups })
      this.#renderGroupMembersWidget(groupId)
    } catch (err) {
      notify(`Failed to remove user from group: ${err}`, 'danger', 'exclamation-octagon')
    }
  }

  /**
   * Delete a config key override from the server.
   * @param {string} entityId
   * @param {string} key
   */
  async #deleteCollectionConfigKey(entityId, key) {
    try {
      const apiClient = this.getDependency('client').apiClient
      if (this.#currentEntityType === 'project') {
        await apiClient.projectsConfig(entityId, key)
      } else {
        await apiClient.collectionsConfig(entityId, key)
      }
      delete this.#collectionConfig[key]
      this.#renderCollectionConfigList(entityId)
    } catch (err) {
      notify(`Failed to delete config override: ${err}`, 'danger', 'exclamation-octagon')
    }
  }
}

export default RbacManagerPlugin

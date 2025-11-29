/**
 * RBAC Manager Plugin
 *
 * Provides visual management interface for Users, Groups, Roles, and Collections.
 * Uses entity-driven architecture for extensibility.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton, SlDialog } from '../ui.js'
 */

import ui from '../ui.js'
import { logger, client } from '../app.js'
import { registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js'
import { getEntitySchema, getEntityTypes } from '../modules/rbac/entity-schemas.js'
import { renderEntityForm, extractFormData, displayFormErrors, clearFormErrors } from '../modules/rbac/form-renderer.js'
import { createEntityManagers } from '../modules/rbac/entity-manager.js'
import { userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'

/**
 * RBAC Manager dialog navigation properties
 * @typedef {object} rbacManagerDialogPart
 * @property {HTMLDivElement} tabContainer - Tab navigation container
 * @property {SlButton} tabUser - Users tab button
 * @property {SlButton} tabGroup - Groups tab button
 * @property {SlButton} tabRole - Roles tab button
 * @property {SlButton} tabCollection - Collections tab button
 * @property {HTMLDivElement} contentArea - Main content area
 * @property {HTMLDivElement} entityListPanel - Left panel for entity list
 * @property {HTMLElement} entityListTitle - Entity list title
 * @property {SlButton} addEntityBtn - Add entity button
 * @property {HTMLInputElement} searchInput - Search input
 * @property {HTMLDivElement} entityList - Entity list container
 * @property {HTMLDivElement} formPanel - Right panel for form
 * @property {HTMLDivElement} formHeader - Form header
 * @property {HTMLElement} formTitle - Form title
 * @property {HTMLDivElement} formActions - Form action buttons container
 * @property {SlButton} saveBtn - Save button
 * @property {SlButton} deleteBtn - Delete button
 * @property {HTMLDivElement} formContainer - Form container
 * @property {HTMLDivElement} emptyState - Empty state message
 * @property {SlButton} closeBtn - Close dialog button
 */

const plugin = {
  name: 'rbac-manager',
  install,
  state: { update },
  deps: ['client']
}

export { plugin }
export default plugin

// Register templates
await registerTemplate('rbac-manager-dialog', 'rbac-manager-dialog.html')
await registerTemplate('rbac-manager-button', 'rbac-manager-button.html')

// Icons used in rbac-manager templates (needed for build system to include them)
// <sl-icon name="person"></sl-icon>
// <sl-icon name="people"></sl-icon>
// <sl-icon name="shield"></sl-icon>
// <sl-icon name="shield-lock"></sl-icon>
// <sl-icon name="plus"></sl-icon>
// <sl-icon name="check"></sl-icon>
// <sl-icon name="trash"></sl-icon>

// Plugin state
/** @type {ApplicationState | null} */
let currentState = null

/** @type {Record<string, import('../modules/rbac/entity-manager.js').EntityManager>} */
let entityManagers = {}

/** @type {string} */
let currentEntityType = 'user'

/** @type {string | null} */
let selectedEntityId = null

/** @type {boolean} */
let isNewEntity = false

/** @type {Record<string, any[]>} */
let optionsData = {}

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create UI elements
  const button = createSingleFromTemplate('rbac-manager-button')
  const dialog = createSingleFromTemplate('rbac-manager-dialog', document.body)

  // Add button to toolbar (assuming there's an admin section)
  // For now, add to toolbar - adjust location as needed
  if (ui.toolbar) {
    ui.toolbar.appendChild(button)
  }

  updateUi()

  // Create entity managers with typed API client
  entityManagers = createEntityManagers(client.apiClient)

  // Set up event listeners
  setupEventListeners()

  // Initially disable button until we check admin status
  ui.toolbar.rbacManagerBtn.disabled = true
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  currentState = state

  // Only admins can access RBAC manager
  const isAdmin = userIsAdmin(state.user)
  if (ui.toolbar?.rbacManagerBtn) {
    ui.toolbar.rbacManagerBtn.disabled = !isAdmin
  }
}

/**
 * Set up all event listeners for the dialog
 */
function setupEventListeners() {
  /** @type {rbacManagerDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.rbacManagerDialog)

  // Open dialog button
  ui.toolbar.rbacManagerBtn.addEventListener('click', openDialog)

  // Close dialog
  dialog.querySelector('[name="closeBtn"]').addEventListener('click', () => dialog.hide())

  // Tab navigation
  dialog.querySelector('[name="tabUser"]').addEventListener('click', () => switchTab('user'))
  dialog.querySelector('[name="tabGroup"]').addEventListener('click', () => switchTab('group'))
  dialog.querySelector('[name="tabRole"]').addEventListener('click', () => switchTab('role'))
  dialog.querySelector('[name="tabCollection"]').addEventListener('click', () => switchTab('collection'))

  // Add entity button
  dialog.querySelector('[name="addEntityBtn"]').addEventListener('click', createNewEntity)

  // Save button
  dialog.querySelector('[name="saveBtn"]').addEventListener('click', saveEntity)

  // Delete button
  dialog.querySelector('[name="deleteBtn"]').addEventListener('click', deleteEntity)

  // Search input
  dialog.querySelector('[name="searchInput"]').addEventListener('input', handleSearch)
}

/**
 * Open the RBAC manager dialog
 */
async function openDialog() {
  /** @type {rbacManagerDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.rbacManagerDialog)

  try {
    // Load all entity data
    await loadAllEntities()

    // Show dialog
    dialog.show()

    // Switch to default tab (users)
    await switchTab('user')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to open RBAC manager: ${errorMessage}`)
    notify('Failed to load RBAC data', 'danger')
  }
}

/**
 * Load all entities from server
 */
async function loadAllEntities() {
  const promises = []

  for (const entityType of getEntityTypes()) {
    promises.push(
      entityManagers[entityType].loadAll().catch(err => {
        const errorMessage = err instanceof Error ? err.message : String(err)
        logger.warn(`Failed to load ${entityType}s: ${errorMessage}`)
        return []
      })
    )
  }

  await Promise.all(promises)

  // Build options data for multiselect fields
  optionsData = {
    user: entityManagers.user.getAll(),
    group: entityManagers.group.getAll(),
    role: entityManagers.role.getAll(),
    collection: entityManagers.collection.getAll()
  }
}

/**
 * Switch to a different entity type tab
 * @param {string} entityType
 */
async function switchTab(entityType) {
  /** @type {rbacManagerDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.rbacManagerDialog)

  currentEntityType = entityType
  selectedEntityId = null
  isNewEntity = false

  // Update tab button states
  const tabs = dialog.querySelectorAll('[name^="tab"]')
  tabs.forEach(tab => {
    if (tab.dataset.entityType === entityType) {
      tab.variant = 'primary'
    } else {
      tab.variant = 'default'
    }
  })

  // Update entity list
  renderEntityList()

  // Clear form
  showEmptyState()
}

/**
 * Render the entity list for current entity type
 * @param {string} [searchTerm] - Optional search term to filter list
 */
function renderEntityList(searchTerm = '') {
  /** @type {rbacManagerDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.rbacManagerDialog)

  const schema = getEntitySchema(currentEntityType)
  if (!schema) return

  // Update list title
  dialog.querySelector('[name="entityListTitle"]').textContent = schema.label

  // Get entities
  let entities = entityManagers[currentEntityType].getAll()

  // Apply search filter if provided
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

  // Clear list
  const entityListEl = dialog.querySelector('[name="entityList"]')
  entityListEl.innerHTML = ''

  // Render entity items
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

    // Highlight selected item
    if (selectedEntityId === entity[schema.idField]) {
      item.style.backgroundColor = 'var(--sl-color-primary-100)'
    }

    // Item content
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

    // Hover effect
    item.addEventListener('mouseenter', () => {
      if (selectedEntityId !== entity[schema.idField]) {
        item.style.backgroundColor = 'var(--sl-color-neutral-100)'
      }
    })
    item.addEventListener('mouseleave', () => {
      if (selectedEntityId !== entity[schema.idField]) {
        item.style.backgroundColor = ''
      }
    })

    // Click to select
    item.addEventListener('click', () => selectEntity(entity[schema.idField]))

    entityListEl.appendChild(item)
  })
}

/**
 * Select an entity from the list
 * @param {string} entityId
 */
function selectEntity(entityId) {
  selectedEntityId = entityId
  isNewEntity = false

  // Refresh list to update highlighting
  renderEntityList()

  // Show entity form
  showEntityForm()
}

/**
 * Create a new entity
 */
function createNewEntity() {
  selectedEntityId = null
  isNewEntity = true

  // Show entity form for new entity
  showEntityForm()
}

/**
 * Show the entity form for selected or new entity
 */
function showEntityForm() {
  /** @type {rbacManagerDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.rbacManagerDialog)

  const schema = getEntitySchema(currentEntityType)
  if (!schema) return

  const formContainer = dialog.querySelector('[name="formContainer"]')

  // Hide empty state if it exists
  const emptyState = formContainer.querySelector('[name="emptyState"]')
  if (emptyState) {
    emptyState.style.display = 'none'
  }

  // Remove any existing forms
  const existingForms = formContainer.querySelectorAll('form')
  existingForms.forEach(form => form.remove())

  // Update form title
  const formTitle = dialog.querySelector('[name="formTitle"]')
  if (isNewEntity) {
    formTitle.textContent = `New ${schema.singularLabel}`
  } else {
    formTitle.textContent = `Edit ${schema.singularLabel}: ${selectedEntityId}`
  }

  // Enable action buttons
  dialog.querySelector('[name="saveBtn"]').disabled = false
  dialog.querySelector('[name="deleteBtn"]').disabled = isNewEntity // Can't delete new entity

  // Get entity data
  let entityData = {}
  if (!isNewEntity && selectedEntityId) {
    const entity = entityManagers[currentEntityType].findById(selectedEntityId)
    if (entity) {
      entityData = { ...entity }
    }
  }

  // Render form
  const form = renderEntityForm(currentEntityType, entityData, optionsData, isNewEntity)
  formContainer.appendChild(form)
}

/**
 * Show empty state (no entity selected)
 */
function showEmptyState() {
  /** @type {rbacManagerDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.rbacManagerDialog)

  const formContainer = dialog.querySelector('[name="formContainer"]')

  // Get or create empty state element
  let emptyState = formContainer.querySelector('[name="emptyState"]')
  if (!emptyState) {
    // Re-create empty state if it was removed
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

  // Remove any form elements
  const forms = formContainer.querySelectorAll('form')
  forms.forEach(form => form.remove())

  // Update UI state
  dialog.querySelector('[name="formTitle"]').textContent = 'Select an item'
  dialog.querySelector('[name="saveBtn"]').disabled = true
  dialog.querySelector('[name="deleteBtn"]').disabled = true
}

/**
 * Save entity (create or update)
 */
async function saveEntity() {
  /** @type {rbacManagerDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.rbacManagerDialog)

  const form = dialog.querySelector('[name="formContainer"]').querySelector('form')
  if (!form) return

  try {
    // Extract form data
    const data = extractFormData(form)

    // Clear previous errors
    clearFormErrors(form)

    if (isNewEntity) {
      // Create new entity
      await entityManagers[currentEntityType].create(data)
      notify(`${getEntitySchema(currentEntityType)?.singularLabel} created successfully`, 'success')

      // Refresh options data
      await loadAllEntities()

      // Select the newly created entity
      const schema = getEntitySchema(currentEntityType)
      if (schema) {
        selectedEntityId = data[schema.idField]
        isNewEntity = false
      }
    } else {
      // Update existing entity
      if (selectedEntityId) {
        await entityManagers[currentEntityType].update(selectedEntityId, data)
        notify(`${getEntitySchema(currentEntityType)?.singularLabel} updated successfully`, 'success')

        // Refresh options data
        await loadAllEntities()
      }
    }

    // Refresh list
    renderEntityList()

    // Refresh form to show updated data
    showEntityForm()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to save entity: ${errorMessage}`)

    // Show validation errors
    if (error instanceof Error && error.message.startsWith('Validation failed:')) {
      const errors = error.message.replace('Validation failed: ', '').split(', ')
      displayFormErrors(form, errors)
    } else {
      displayFormErrors(form, [errorMessage])
    }
  }
}

/**
 * Delete selected entity
 */
async function deleteEntity() {
  if (!selectedEntityId || isNewEntity) return

  /** @type {rbacManagerDialogPart & SlDialog} */
  const dialog = /** @type {any} */(ui.rbacManagerDialog)

  const schema = getEntitySchema(currentEntityType)
  if (!schema) return

  // Confirm deletion
  const confirmed = confirm(`Are you sure you want to delete ${schema.singularLabel} "${selectedEntityId}"?`)
  if (!confirmed) return

  try {
    await entityManagers[currentEntityType].delete(selectedEntityId)
    notify(`${schema.singularLabel} deleted successfully`, 'success')

    // Refresh options data
    await loadAllEntities()

    // Clear selection
    selectedEntityId = null
    isNewEntity = false

    // Refresh list
    renderEntityList()

    // Show empty state
    showEmptyState()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to delete entity: ${errorMessage}`)
    notify(`Failed to delete ${schema.singularLabel}: ${errorMessage}`, 'danger')
  }
}

/**
 * Handle search input
 * @param {Event} event
 */
function handleSearch(event) {
  const searchTerm = /** @type {HTMLInputElement} */(event.target).value
  renderEntityList(searchTerm)
}

/**
 * Dynamic Form Renderer for RBAC Entities
 *
 * Generates Shoelace-based forms dynamically from entity schemas.
 * Handles form validation and data extraction.
 */

/**
 * @import { EntitySchema, EntityField } from './entity-schemas.js'
 */

import { getEntitySchema } from './entity-schemas.js'

/**
 * Render a complete form for an entity
 * @param {string} entityType - Entity type to render form for
 * @param {Record<string, any>} data - Current entity data (empty object for new entities)
 * @param {Record<string, any[]>} optionsData - Options data for select fields (e.g., {role: [...], group: [...]})
 * @param {boolean} isNew - Whether this is a new entity
 * @returns {HTMLFormElement} Rendered form element
 */
export function renderEntityForm(entityType, data, optionsData = {}, isNew = false) {
  const schema = getEntitySchema(entityType)
  if (!schema) {
    throw new Error(`Unknown entity type: ${entityType}`)
  }

  const form = document.createElement('form')
  form.className = 'rbac-entity-form'
  form.dataset.entityType = entityType

  // Render each field
  for (const field of schema.fields) {
    // Skip hidden fields
    if (field.hidden) continue

    const fieldContainer = document.createElement('div')
    fieldContainer.className = 'field-container'
    fieldContainer.style.marginBottom = '1rem'

    const fieldElement = renderField(field, data[field.name], optionsData, isNew)
    fieldContainer.appendChild(fieldElement)

    // Add help text if available
    if (field.helpText) {
      const helpText = document.createElement('div')
      helpText.className = 'field-help'
      helpText.style.fontSize = '0.875rem'
      helpText.style.color = 'var(--sl-color-neutral-600)'
      helpText.style.marginTop = '0.25rem'
      helpText.textContent = field.helpText
      fieldContainer.appendChild(helpText)
    }

    form.appendChild(fieldContainer)
  }

  return form
}

/**
 * Render a single form field based on field definition
 * @param {EntityField} field - Field definition
 * @param {any} value - Current field value
 * @param {Record<string, any[]>} optionsData - Options data for select fields
 * @param {boolean} isNew - Whether this is for a new entity
 * @returns {HTMLElement} Rendered field element
 */
function renderField(field, value, optionsData, isNew) {
  const fieldValue = value ?? (field.type === 'multiselect' ? [] : '')

  switch (field.type) {
    case 'string':
    case 'email':
      return renderTextInput(field, fieldValue, isNew)

    case 'password':
      return renderPasswordInput(field, fieldValue, isNew)

    case 'textarea':
      return renderTextarea(field, fieldValue, isNew)

    case 'multiselect':
      return renderMultiselect(field, fieldValue, optionsData, isNew)

    case 'checkbox':
      return renderCheckbox(field, fieldValue, isNew)

    default:
      console.warn(`Unknown field type: ${field.type}`)
      return renderTextInput(field, fieldValue, isNew)
  }
}

/**
 * Render text input field
 * @param {EntityField} field
 * @param {string} value
 * @param {boolean} isNew
 * @returns {HTMLElement}
 */
function renderTextInput(field, value, isNew) {
  const input = document.createElement('sl-input')
  input.setAttribute('name', field.name)
  input.setAttribute('label', field.label)
  input.value = value || ''

  if (field.type === 'email') {
    input.setAttribute('type', 'email')
  }

  if (field.placeholder) {
    input.setAttribute('placeholder', field.placeholder)
  }

  if (field.required) {
    input.setAttribute('required', 'true')
  }

  if (field.immutable && !isNew) {
    input.setAttribute('disabled', 'true')
  }

  return input
}

/**
 * Render password input field
 * @param {EntityField} field
 * @param {string} value
 * @param {boolean} isNew
 * @returns {HTMLElement}
 */
function renderPasswordInput(field, value, isNew) {
  const input = document.createElement('sl-input')
  input.setAttribute('name', field.name)
  input.setAttribute('label', field.label)
  input.setAttribute('type', 'password')
  input.setAttribute('password-toggle', 'true')
  input.value = value || ''

  if (field.placeholder) {
    input.setAttribute('placeholder', field.placeholder)
  }

  // Password required for new entities, optional for updates
  if (field.required && isNew) {
    input.setAttribute('required', 'true')
  }

  return input
}

/**
 * Render textarea field
 * @param {EntityField} field
 * @param {string} value
 * @param {boolean} isNew
 * @returns {HTMLElement}
 */
function renderTextarea(field, value, isNew) {
  const textarea = document.createElement('sl-textarea')
  textarea.setAttribute('name', field.name)
  textarea.setAttribute('label', field.label)
  textarea.value = value || ''
  textarea.setAttribute('rows', '3')

  if (field.placeholder) {
    textarea.setAttribute('placeholder', field.placeholder)
  }

  if (field.required) {
    textarea.setAttribute('required', 'true')
  }

  if (field.immutable && !isNew) {
    textarea.setAttribute('disabled', 'true')
  }

  return textarea
}

/**
 * Render multiselect field
 * @param {EntityField} field
 * @param {string[]} value
 * @param {Record<string, any[]>} optionsData
 * @param {boolean} isNew
 * @returns {HTMLElement}
 */
function renderMultiselect(field, value, optionsData, isNew) {
  const container = document.createElement('div')

  // Label
  const label = document.createElement('label')
  label.textContent = field.label
  label.style.display = 'block'
  label.style.marginBottom = '0.5rem'
  label.style.fontWeight = '500'
  label.style.fontSize = '0.875rem'
  container.appendChild(label)

  // Get options from optionsData
  const options = optionsData[field.options] || []
  const selectedValues = Array.isArray(value) ? value : []

  // Create checkbox group
  const checkboxGroup = document.createElement('div')
  checkboxGroup.className = 'checkbox-group'
  checkboxGroup.dataset.name = field.name
  checkboxGroup.style.display = 'flex'
  checkboxGroup.style.flexDirection = 'column'
  checkboxGroup.style.gap = '0.5rem'
  checkboxGroup.style.padding = '0.5rem'
  checkboxGroup.style.border = '1px solid var(--sl-color-neutral-300)'
  checkboxGroup.style.borderRadius = 'var(--sl-border-radius-medium)'
  checkboxGroup.style.maxHeight = '200px'
  checkboxGroup.style.overflowY = 'auto'

  // Add wildcard option for certain fields
  if (field.name === 'collections' || field.name === 'groups' || field.name === 'roles') {
    const wildcardCheckbox = document.createElement('sl-checkbox')
    wildcardCheckbox.value = '*'
    wildcardCheckbox.textContent = '* (All)'
    wildcardCheckbox.checked = selectedValues.includes('*')
    wildcardCheckbox.style.fontWeight = '600'
    checkboxGroup.appendChild(wildcardCheckbox)

    const divider = document.createElement('sl-divider')
    checkboxGroup.appendChild(divider)
  }

  // Add options
  for (const option of options) {
    const checkbox = document.createElement('sl-checkbox')
    const optionId = option.id || option.username || option
    const optionLabel = option.name || option.roleName || option.fullname || optionId

    checkbox.value = optionId
    checkbox.textContent = optionLabel
    checkbox.checked = selectedValues.includes(optionId)

    checkboxGroup.appendChild(checkbox)
  }

  // Show message if no options available
  if (options.length === 0) {
    const noOptions = document.createElement('div')
    noOptions.style.color = 'var(--sl-color-neutral-500)'
    noOptions.style.fontStyle = 'italic'
    noOptions.textContent = `No ${field.options}s available`
    checkboxGroup.appendChild(noOptions)
  }

  container.appendChild(checkboxGroup)

  if (field.immutable && !isNew) {
    const checkboxes = checkboxGroup.querySelectorAll('sl-checkbox')
    checkboxes.forEach(cb => cb.setAttribute('disabled', 'true'))
  }

  return container
}

/**
 * Render checkbox field
 * @param {EntityField} field
 * @param {boolean} value
 * @param {boolean} isNew
 * @returns {HTMLElement}
 */
function renderCheckbox(field, value, isNew) {
  const checkbox = document.createElement('sl-checkbox')
  checkbox.setAttribute('name', field.name)
  checkbox.textContent = field.label
  checkbox.checked = !!value

  if (field.immutable && !isNew) {
    checkbox.setAttribute('disabled', 'true')
  }

  return checkbox
}

/**
 * Extract form data from rendered form
 * @param {HTMLFormElement} form - Form element created by renderEntityForm
 * @returns {Record<string, any>} Extracted entity data
 */
export function extractFormData(form) {
  const entityType = form.dataset.entityType
  const schema = getEntitySchema(entityType)
  if (!schema) {
    throw new Error(`Unknown entity type: ${entityType}`)
  }

  const data = {}

  for (const field of schema.fields) {
    if (field.type === 'multiselect') {
      // Extract from checkbox group
      const checkboxGroup = form.querySelector(`.checkbox-group[data-name="${field.name}"]`)
      if (checkboxGroup) {
        const allCheckboxes = checkboxGroup.querySelectorAll('sl-checkbox')
        const checkedCheckboxes = Array.from(allCheckboxes).filter(cb => cb.checked)
        data[field.name] = checkedCheckboxes.map(cb => cb.value)
      } else {
        data[field.name] = []
      }
    } else if (field.type === 'checkbox') {
      const checkbox = form.querySelector(`sl-checkbox[name="${field.name}"]`)
      data[field.name] = checkbox ? checkbox.checked : false
    } else {
      // Text inputs, textareas, passwords
      const input = form.querySelector(`[name="${field.name}"]`)
      if (input) {
        const value = input.value?.trim()
        // Only include password if it's not empty (for updates)
        if (field.type === 'password' && !value) {
          continue
        }
        data[field.name] = value || ''
      }
    }
  }

  return data
}

/**
 * Clear form validation errors
 * @param {HTMLFormElement} form
 */
export function clearFormErrors(form) {
  // Clear any custom validity messages
  const inputs = form.querySelectorAll('sl-input, sl-textarea, sl-select')
  inputs.forEach(input => {
    if (input.setCustomValidity) {
      input.setCustomValidity('')
    }
  })

  // Remove error messages
  const errorMessages = form.querySelectorAll('.field-error')
  errorMessages.forEach(msg => msg.remove())
}

/**
 * Display validation errors on form
 * @param {HTMLFormElement} form
 * @param {string[]} errors - Array of error messages
 */
export function displayFormErrors(form, errors) {
  clearFormErrors(form)

  if (errors.length === 0) return

  // Create error message container at top of form
  const errorContainer = document.createElement('div')
  errorContainer.className = 'field-error'
  errorContainer.style.padding = '1rem'
  errorContainer.style.marginBottom = '1rem'
  errorContainer.style.backgroundColor = 'var(--sl-color-danger-50)'
  errorContainer.style.border = '1px solid var(--sl-color-danger-300)'
  errorContainer.style.borderRadius = 'var(--sl-border-radius-medium)'
  errorContainer.style.color = 'var(--sl-color-danger-700)'

  const errorList = document.createElement('ul')
  errorList.style.margin = '0'
  errorList.style.paddingLeft = '1.5rem'

  errors.forEach(error => {
    const li = document.createElement('li')
    li.textContent = error
    errorList.appendChild(li)
  })

  errorContainer.appendChild(errorList)
  form.insertBefore(errorContainer, form.firstChild)
}

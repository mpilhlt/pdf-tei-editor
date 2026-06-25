/**
 * Reusable config value editor factory for Shoelace-based forms.
 *
 * Creates an appropriate input element based on the config value type
 * and any allowed-values constraint. Used by config-editor and rbac-manager plugins.
 */

/**
 * @typedef {{ container: HTMLElement, setReadOnly?: (readonly: boolean) => void, getValue: () => any }} ValueEditorResult
 */

/**
 * Create a value editor appropriate for the given value and allowed values.
 * @param {string} key - Config key (used for event callbacks)
 * @param {any} value - Current value
 * @param {any[]} [allowedValues] - Optional list of allowed values (renders as sl-select)
 * @param {boolean} [isReadOnly] - Start in read-only mode
 * @param {(key: string, newValue: any) => void} [onChange] - Called on every value change
 * @returns {ValueEditorResult}
 */
export function createValueEditor(key, value, allowedValues, isReadOnly = true, onChange = null) {
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
    if (!isReadOnly && onChange) {
      select.addEventListener('sl-change', () => onChange(key, select.value))
    }
    container.appendChild(select)
    return {
      container,
      setReadOnly: (readonly) => { select.disabled = readonly },
      getValue: () => select.value
    }
  }

  const actualType = typeof value

  if (actualType === 'boolean') {
    const checkbox = document.createElement('sl-checkbox')
    checkbox.checked = Boolean(value)
    checkbox.disabled = isReadOnly
    if (!isReadOnly && onChange) {
      checkbox.addEventListener('sl-change', () => onChange(key, checkbox.checked))
    }
    container.appendChild(checkbox)
    return {
      container,
      setReadOnly: (readonly) => { checkbox.disabled = readonly },
      getValue: () => checkbox.checked
    }
  }

  if (actualType === 'number') {
    const input = document.createElement('sl-input')
    input.setAttribute('type', 'number')
    input.setAttribute('size', 'small')
    input.value = value != null ? String(value) : ''
    if (!isReadOnly && onChange) {
      input.addEventListener('sl-input', () => {
        const numValue = parseFloat(input.value)
        onChange(key, isNaN(numValue) ? null : numValue)
      })
    }
    container.appendChild(input)
    return {
      container,
      setReadOnly: (readonly) => { input.readonly = readonly; applyReadOnlyStyle(input, readonly) },
      getValue: () => { const n = parseFloat(input.value); return isNaN(n) ? null : n }
    }
  }

  if (isStringArray(value)) {
    const input = document.createElement('sl-input')
    input.setAttribute('size', 'small')
    input.value = arrayToCommaSeparated(value)
    input.style.fontFamily = 'monospace'
    if (!isReadOnly && onChange) {
      input.addEventListener('sl-input', () => {
        try { onChange(key, commaSeparatedToArray(input.value)) } catch (e) { /* ignore parse errors */ }
      })
    }
    container.appendChild(input)
    return {
      container,
      setReadOnly: (readonly) => { input.readonly = readonly; applyReadOnlyStyle(input, readonly) },
      getValue: () => { try { return commaSeparatedToArray(input.value) } catch { return [] } }
    }
  }

  if (actualType === 'object') {
    const input = document.createElement('sl-input')
    input.setAttribute('size', 'small')
    input.value = JSON.stringify(value)
    input.style.fontFamily = 'monospace'
    if (!isReadOnly && onChange) {
      input.addEventListener('sl-input', () => onChange(key, input.value))
    }
    container.appendChild(input)
    return {
      container,
      setReadOnly: (readonly) => { input.readonly = readonly; applyReadOnlyStyle(input, readonly) },
      getValue: () => { try { return JSON.parse(input.value) } catch { return input.value } }
    }
  }

  // Default: string input
  const input = document.createElement('sl-input')
  input.setAttribute('size', 'small')
  input.value = value != null ? String(value) : ''
  if (!isReadOnly && onChange) {
    input.addEventListener('sl-input', () => onChange(key, input.value))
  }
  container.appendChild(input)
  return {
    container,
    setReadOnly: (readonly) => { input.readonly = readonly; applyReadOnlyStyle(input, readonly) },
    getValue: () => input.value
  }
}

/**
 * Create a password-style editor for masked config values.
 * Shows "****" or "(set but hidden)" as placeholder; never sends the sentinel back on save.
 * @param {string} key - Config key
 * @param {any} currentValue - Current masked value (typically "****" or empty)
 * @param {boolean} [isReadOnly] - Start in read-only mode
 * @param {(key: string, newValue: string) => void} [onChange] - Called on every value change
 * @returns {ValueEditorResult}
 */
export function createMaskedValueEditor(key, currentValue, isReadOnly = true, onChange = null) {
  const container = document.createElement('div')
  container.style.width = '100%'

  const input = document.createElement('sl-input')
  input.setAttribute('type', 'password')
  input.setAttribute('size', 'small')
  input.setAttribute('password-toggle', '')
  const isSentinel = currentValue === '****'
  input.setAttribute('placeholder', isSentinel ? '(set but hidden)' : '(not set)')
  input.value = ''

  if (!isReadOnly && onChange) {
    input.addEventListener('sl-input', () => onChange(key, input.value))
  }

  container.appendChild(input)
  return {
    container,
    setReadOnly: (readonly) => { input.readonly = readonly; applyReadOnlyStyle(input, readonly) },
    getValue: () => input.value
  }
}

/** @param {any} value @returns {boolean} */
function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')
}

/** @param {any[]} arr @returns {string} */
function arrayToCommaSeparated(arr) {
  return arr.map(item => {
    const str = String(item)
    if (str.includes(' ') || str.includes(',')) return `"${str.replace(/"/g, '\\"')}"`
    return str
  }).join(', ')
}

/** @param {string} str @returns {any[]} */
function commaSeparatedToArray(str) {
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
 * Apply or remove read-only visual styling from a Shoelace input element.
 * @param {HTMLElement} element
 * @param {boolean} readonly
 */
export function applyReadOnlyStyle(element, readonly) {
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
    const props = [
      '--sl-input-border-width', '--sl-input-border-color', '--sl-input-border-color-hover',
      '--sl-input-border-color-focus', '--sl-input-background-color', '--sl-input-background-color-hover',
      '--sl-input-background-color-focus', '--sl-focus-ring-width', '--sl-focus-ring-color',
      '--sl-input-focus-ring-width', '--sl-input-focus-ring-color'
    ]
    props.forEach(p => element.style.removeProperty(p))
    element.style.cursor = ''
    element.style.pointerEvents = ''
  }
}

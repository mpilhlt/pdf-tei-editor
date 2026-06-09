/**
 * Reusable member picker widget for RBAC management.
 *
 * Creates a card-style section with an interactive member table and an inline add-row,
 * matching the config-override card pattern (immediate saves on add/remove).
 */

/**
 * @typedef {object} MemberPickerColumn
 * @property {string} key - Property name on each item object
 * @property {string} label - Column header text
 * @property {boolean} [monospace] - Render cell value in monospace font
 */

/**
 * @typedef {object} MemberPickerOption
 * @property {string} value - The ID value passed to onAdd
 * @property {string} primaryLabel - Main display text (used for text filtering)
 * @property {string} [secondaryLabel] - Smaller secondary text shown in the option
 * @property {string} [optionGroup] - Group header label rendered before this option's section
 */

/**
 * @typedef {object} MemberPickerHandle
 * @property {HTMLElement} element - The rendered card section element
 * @property {function(object[]): void} setItems - Replace the displayed member rows
 * @property {function(MemberPickerOption[]): void} setAvailable - Replace available add options
 * @property {function(boolean): void} setDisabled - Enable or disable the Add button
 */

/**
 * Create a member picker widget.
 *
 * @param {object} options
 * @param {string} options.label - Section header text (e.g. 'Members')
 * @param {MemberPickerColumn[]} options.columns - Table column definitions
 * @param {object[]} options.items - Initial array of current member objects
 * @param {MemberPickerOption[]} options.availableOptions - Options shown in the add dropdown
 * @param {function(string): Promise<void>} options.onAdd - Called with the selected value when user confirms add
 * @param {function(object): Promise<void>} options.onRemove - Called with the item object when user clicks remove
 * @param {boolean} [options.disabled] - Disable the widget initially (for unsaved entities)
 * @returns {MemberPickerHandle}
 */
export function createMemberPicker({ label, columns, items: initialItems, availableOptions: initialOptions, onAdd, onRemove, disabled = false }) {
  let _items = [...initialItems]
  let _available = [...initialOptions]
  let _disabled = disabled

  // --- Outer card (matches entityConfigSection style) ---
  const section = document.createElement('div')
  section.className = 'member-picker-section'
  section.style.cssText = 'margin-top: 1.25rem; border: 1px solid var(--sl-color-neutral-200); border-radius: var(--sl-border-radius-medium); padding: 0.75rem; background: var(--sl-color-neutral-50);'

  // --- Header row ---
  const header = document.createElement('div')
  header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;'

  const h4 = document.createElement('h4')
  h4.style.cssText = 'margin: 0; font-size: 0.85rem; font-weight: 600; color: var(--sl-color-neutral-700); text-transform: uppercase; letter-spacing: 0.04em;'
  h4.textContent = label
  header.appendChild(h4)

  const addBtn = document.createElement('sl-button')
  addBtn.setAttribute('size', 'small')
  addBtn.setAttribute('variant', 'default')
  addBtn.setAttribute('data-role', 'add-member-btn')
  addBtn.disabled = _disabled
  addBtn.innerHTML = '<sl-icon slot="prefix" name="plus"></sl-icon>Add'
  header.appendChild(addBtn)

  section.appendChild(header)

  // --- Content container (add-row + table/empty-state) ---
  const content = document.createElement('div')
  section.appendChild(content)

  // --- Table renderer ---
  function renderTable() {
    const existing = content.querySelector('.member-picker-table-wrap')
    if (existing) existing.remove()

    const wrap = document.createElement('div')
    wrap.className = 'member-picker-table-wrap'

    if (_items.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'color: var(--sl-color-neutral-500); font-size: 0.8em; padding: 0.2rem 0;'
      empty.textContent = `No ${label.toLowerCase()}`
      wrap.appendChild(empty)
    } else {
      const table = document.createElement('table')
      table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 0.82em;'

      const thead = document.createElement('thead')
      const headerRow = document.createElement('tr')
      headerRow.style.cssText = 'border-bottom: 1px solid var(--sl-color-neutral-200);'
      for (const col of columns) {
        const th = document.createElement('th')
        th.style.cssText = 'text-align:left; padding: 0.2rem 0.4rem; color: var(--sl-color-neutral-600); font-weight: 600;'
        th.textContent = col.label
        headerRow.appendChild(th)
      }
      const thAction = document.createElement('th')
      thAction.style.width = '2rem'
      headerRow.appendChild(thAction)
      thead.appendChild(headerRow)
      table.appendChild(thead)

      const tbody = document.createElement('tbody')
      for (const item of _items) {
        const tr = document.createElement('tr')
        tr.style.cssText = 'border-bottom: 1px solid var(--sl-color-neutral-100);'
        for (const col of columns) {
          const td = document.createElement('td')
          td.style.cssText = col.monospace
            ? 'padding: 0.2rem 0.4rem; font-family: monospace;'
            : 'padding: 0.2rem 0.4rem;'
          td.textContent = item[col.key] ?? ''
          tr.appendChild(td)
        }
        const tdAction = document.createElement('td')
        tdAction.style.cssText = 'padding: 0.1rem 0; text-align: right;'
        const removeBtn = document.createElement('sl-icon-button')
        removeBtn.setAttribute('name', 'trash')
        removeBtn.setAttribute('label', 'Remove')
        removeBtn.style.fontSize = '0.9rem'
        removeBtn.addEventListener('click', () => onRemove(item))
        tdAction.appendChild(removeBtn)
        tr.appendChild(tdAction)
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      wrap.appendChild(table)
    }

    content.appendChild(wrap)
  }

  // --- Add-row builder ---
  function buildAddRow() {
    const addRow = document.createElement('div')
    addRow.className = 'add-member-row'
    addRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;'

    const filterInput = document.createElement('sl-input')
    filterInput.setAttribute('size', 'small')
    filterInput.setAttribute('placeholder', 'Filter...')
    filterInput.style.cssText = 'flex: 0 0 35%;'
    addRow.appendChild(filterInput)

    const selectEl = document.createElement('sl-select')
    selectEl.setAttribute('size', 'small')
    selectEl.setAttribute('placeholder', 'Select...')
    selectEl.style.cssText = 'flex: 1;'

    function renderOptions(filterText = '') {
      selectEl.innerHTML = ''
      let currentGroup = null

      for (const opt of _available) {
        const lc = filterText.toLowerCase()
        const matchesPrimary = opt.primaryLabel.toLowerCase().includes(lc)
        const matchesSecondary = (opt.secondaryLabel || '').toLowerCase().includes(lc)
        if (filterText && !matchesPrimary && !matchesSecondary) continue

        if (opt.optionGroup && opt.optionGroup !== currentGroup) {
          currentGroup = opt.optionGroup
          if (selectEl.children.length > 0) {
            selectEl.appendChild(document.createElement('sl-divider'))
          }
          const groupHeader = document.createElement('sl-option')
          groupHeader.value = ''
          groupHeader.disabled = true
          groupHeader.style.cssText = 'font-weight: 600; font-size: 0.8em; color: var(--sl-color-neutral-600);'
          groupHeader.textContent = opt.optionGroup
          selectEl.appendChild(groupHeader)
        }

        const slOpt = document.createElement('sl-option')
        slOpt.value = opt.value
        slOpt.textContent = opt.primaryLabel
        if (opt.secondaryLabel) {
          const sub = document.createElement('span')
          sub.slot = 'suffix'
          sub.style.cssText = 'font-size: 0.8em; color: var(--sl-color-neutral-500);'
          sub.textContent = opt.secondaryLabel
          slOpt.appendChild(sub)
        }
        selectEl.appendChild(slOpt)
      }
    }

    renderOptions()
    addRow.appendChild(selectEl)

    const confirmBtn = document.createElement('sl-button')
    confirmBtn.setAttribute('size', 'small')
    confirmBtn.setAttribute('variant', 'primary')
    confirmBtn.disabled = true
    confirmBtn.textContent = 'Add'
    addRow.appendChild(confirmBtn)

    const cancelBtn = document.createElement('sl-icon-button')
    cancelBtn.setAttribute('name', 'x')
    cancelBtn.setAttribute('label', 'Cancel')
    cancelBtn.setAttribute('data-role', 'cancel-add-btn')
    cancelBtn.addEventListener('click', () => addRow.remove())
    addRow.appendChild(cancelBtn)

    filterInput.addEventListener('input', () => {
      renderOptions(filterInput.value || '')
    })

    selectEl.addEventListener('sl-change', () => {
      confirmBtn.disabled = !selectEl.value
    })

    confirmBtn.addEventListener('click', async () => {
      const value = String(selectEl.value)
      if (!value) return
      addRow.remove()
      await onAdd(value)
    })

    return addRow
  }

  addBtn.addEventListener('click', () => {
    if (_disabled) return
    if (content.querySelector('.add-member-row')) return
    content.insertBefore(buildAddRow(), content.firstChild)
  })

  renderTable()

  return {
    element: section,
    setItems(items) {
      _items = [...items]
      renderTable()
    },
    setAvailable(options) {
      _available = [...options]
    },
    setDisabled(disabled) {
      _disabled = disabled
      addBtn.disabled = disabled
      if (disabled) {
        const existingRow = content.querySelector('.add-member-row')
        if (existingRow) existingRow.remove()
      }
    }
  }
}

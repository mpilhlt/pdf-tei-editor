# RBAC Member Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace checkbox-based member/group selection in the RBAC Manager with a reusable interactive member picker widget that saves immediately (like config overrides), and add a read-only group display to the Users tab.

**Architecture:** A new `createMemberPicker` factory module returns a self-contained card element with a table of current members, a filterable inline add-row, and `setItems`/`setAvailable`/`setDisabled` handles for re-renders. It is used by three methods added to `RbacManagerPlugin`: `#renderGroupMembersWidget`, `#renderProjectMembersSection`, and `#renderUserGroupsSection`. The `groups` field on users and `members` field on projects are marked `excludeFromForm: true` so they are excluded from form rendering and save data.

**Tech Stack:** Vanilla JavaScript ES modules, Shoelace web components (`sl-button`, `sl-select`, `sl-input`, `sl-icon-button`, `sl-divider`, `sl-option`), Node.js built-in test runner (`node:test`), jsdom for DOM unit tests.

---

## File Map

| Action | File | Responsibility |
| --- | --- | --- |
| Create | `app/src/modules/rbac/member-picker.js` | Reusable widget factory |
| Modify | `app/src/modules/rbac/entity-schemas.js` | Add `excludeFromForm` property to `EntityField` typedef; flag `user.groups` and `project.members` |
| Modify | `app/src/modules/rbac/form-renderer.js` | Skip `excludeFromForm` fields in `renderEntityForm` and `extractFormData` |
| Modify | `app/src/plugins/rbac-manager.js` | Add `#renderGroupMembersWidget`, `#addUserToGroup`, `#renderProjectMembersSection`, `#addProjectMember`, `#removeProjectMember`, `#renderUserGroupsSection`; update `#showEntityForm`, `#switchTab`, `#showEmptyState` |
| Modify | `app/src/templates/rbac-manager-dialog.html` | Add `projectMembersSection` and `userGroupsSection` divs; strip `<h4>` and `<p>` from `groupMembersSection` |
| Regenerate | `app/src/templates/rbac-manager-dialog.types.js` | `npm run build:ui-types` after template changes |
| Create | `tests/unit/js/rbac-form-renderer.test.js` | Unit tests for `excludeFromForm` in form-renderer |
| Create | `tests/unit/js/rbac-member-picker.test.js` | Unit tests for `createMemberPicker` factory |

---

## Task 1: Schema — add `excludeFromForm` and flag fields

**Files:**
- Modify: `app/src/modules/rbac/entity-schemas.js`
- Create: `tests/unit/js/rbac-form-renderer.test.js` (first test only)

- [ ] **Step 1.1: Write the failing test**

Create `tests/unit/js/rbac-form-renderer.test.js`:

```javascript
/**
 * Unit tests for RBAC form-renderer excludeFromForm support.
 *
 * @testCovers app/src/modules/rbac/form-renderer.js
 * @testCovers app/src/modules/rbac/entity-schemas.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
global.document = dom.window.document
global.window = dom.window

// Shoelace components are custom elements — in jsdom they are plain HTMLElements.
// Stub customElements.define so module-level define calls don't throw.
global.customElements = { define: () => {} }

import { getEntitySchema } from '../../../app/src/modules/rbac/entity-schemas.js'

describe('entity-schemas excludeFromForm', () => {
  it('user.groups field has excludeFromForm: true', () => {
    const schema = getEntitySchema('user')
    const groupsField = schema.fields.find(f => f.name === 'groups')
    assert.ok(groupsField, 'groups field should exist')
    assert.strictEqual(groupsField.excludeFromForm, true)
  })

  it('project.members field has excludeFromForm: true', () => {
    const schema = getEntitySchema('project')
    const membersField = schema.fields.find(f => f.name === 'members')
    assert.ok(membersField, 'members field should exist')
    assert.strictEqual(membersField.excludeFromForm, true)
  })
})
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
node tests/unit-test-runner.js tests/unit/js/rbac-form-renderer.test.js
```

Expected output: FAIL — `AssertionError: undefined == true`

- [ ] **Step 1.3: Add `excludeFromForm` to EntityField typedef and flag fields**

In `app/src/modules/rbac/entity-schemas.js`, add `excludeFromForm` to the typedef (line ~21, after `hidden`):

```javascript
 * @property {boolean} [hidden] - Whether field should be hidden
 * @property {boolean} [excludeFromForm] - Whether field is managed by a widget outside the form (excluded from rendering and save data)
```

Then in the `user` schema, update the `groups` field (around line 98):

```javascript
      {
        name: 'groups',
        type: 'multiselect',
        label: 'Groups',
        options: 'group',
        helpText: 'Groups this user belongs to (organisational label only)',
        excludeFromForm: true
      },
```

And in the `project` schema, update the `members` field (around line 153):

```javascript
      {
        name: 'members',
        type: 'multiselect',
        label: 'Members',
        options: 'user',
        helpText: 'Users with access to this project',
        excludeFromForm: true
      },
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
node tests/unit-test-runner.js tests/unit/js/rbac-form-renderer.test.js
```

Expected: PASS (2 tests passing)

- [ ] **Step 1.5: Commit**

```bash
git add app/src/modules/rbac/entity-schemas.js tests/unit/js/rbac-form-renderer.test.js
git commit -m "feat: add excludeFromForm to EntityField typedef; flag user.groups and project.members"
```

---

## Task 2: Form renderer — skip `excludeFromForm` in render and extract

**Files:**
- Modify: `app/src/modules/rbac/form-renderer.js`
- Modify: `tests/unit/js/rbac-form-renderer.test.js` (add more tests)

- [ ] **Step 2.1: Write the failing tests**

Append to `tests/unit/js/rbac-form-renderer.test.js`:

```javascript
import { renderEntityForm, extractFormData } from '../../../app/src/modules/rbac/form-renderer.js'

describe('renderEntityForm excludeFromForm', () => {
  it('does not render a checkbox-group for user.groups', () => {
    const optionsData = { group: [{ id: 'g1', name: 'Group 1' }], role: [] }
    const form = renderEntityForm('user', { username: 'alice', groups: ['g1'] }, optionsData, false)
    const groupsCheckboxGroup = form.querySelector('.checkbox-group[data-name="groups"]')
    assert.strictEqual(groupsCheckboxGroup, null, 'groups checkbox-group should not be rendered')
  })

  it('does not render a checkbox-group for project.members', () => {
    const optionsData = { user: [{ username: 'alice', fullname: 'Alice' }], collection: [] }
    const form = renderEntityForm('project', { id: 'p1', members: ['alice'] }, optionsData, false)
    const membersCheckboxGroup = form.querySelector('.checkbox-group[data-name="members"]')
    assert.strictEqual(membersCheckboxGroup, null, 'members checkbox-group should not be rendered')
  })
})

describe('extractFormData excludeFromForm', () => {
  it('does not include user.groups in extracted data', () => {
    // Create a minimal form as renderEntityForm would produce (without groups checkbox-group)
    const form = document.createElement('form')
    form.dataset.entityType = 'user'
    const usernameInput = document.createElement('sl-input')
    usernameInput.setAttribute('name', 'username')
    usernameInput.value = 'alice'
    form.appendChild(usernameInput)
    // Deliberately no checkbox-group[data-name="groups"] — as when excludeFromForm is true

    const data = extractFormData(form)
    assert.strictEqual(data.groups, undefined, 'groups should not be present in extracted data')
  })

  it('does not include project.members in extracted data', () => {
    const form = document.createElement('form')
    form.dataset.entityType = 'project'
    const idInput = document.createElement('sl-input')
    idInput.setAttribute('name', 'id')
    idInput.value = 'proj1'
    form.appendChild(idInput)

    const data = extractFormData(form)
    assert.strictEqual(data.members, undefined, 'members should not be present in extracted data')
  })
})
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
node tests/unit-test-runner.js tests/unit/js/rbac-form-renderer.test.js
```

Expected: 2 of 6 tests fail — the new `renderEntityForm` and `extractFormData` tests. The schema tests from Task 1 should still pass.

- [ ] **Step 2.3: Update `renderEntityForm` to skip `excludeFromForm` fields**

In `app/src/modules/rbac/form-renderer.js`, find the loop in `renderEntityForm` (around line 33):

```javascript
  // Render each field
  for (const field of schema.fields) {
    // Skip hidden fields
    if (field.hidden) continue
```

Change to:

```javascript
  // Render each field
  for (const field of schema.fields) {
    // Skip hidden fields and fields managed by external widgets
    if (field.hidden || field.excludeFromForm) continue
```

- [ ] **Step 2.4: Update `extractFormData` to skip `excludeFromForm` fields**

In `app/src/modules/rbac/form-renderer.js`, find the loop in `extractFormData` (around line 299):

```javascript
  for (const field of schema.fields) {
    if (field.type === 'multiselect') {
```

Change to:

```javascript
  for (const field of schema.fields) {
    // Skip hidden fields and fields managed by external widgets to avoid overwriting their data
    if (field.hidden || field.excludeFromForm) continue
    if (field.type === 'multiselect') {
```

- [ ] **Step 2.5: Run tests to verify all pass**

```bash
node tests/unit-test-runner.js tests/unit/js/rbac-form-renderer.test.js
```

Expected: PASS (6 tests)

- [ ] **Step 2.6: Commit**

```bash
git add app/src/modules/rbac/form-renderer.js tests/unit/js/rbac-form-renderer.test.js
git commit -m "feat: skip excludeFromForm fields in renderEntityForm and extractFormData"
```

---

## Task 3: Create `createMemberPicker` module

**Files:**
- Create: `app/src/modules/rbac/member-picker.js`
- Create: `tests/unit/js/rbac-member-picker.test.js`

- [ ] **Step 3.1: Write the failing tests**

Create `tests/unit/js/rbac-member-picker.test.js`:

```javascript
/**
 * Unit tests for the createMemberPicker widget factory.
 *
 * @testCovers app/src/modules/rbac/member-picker.js
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>')
global.document = dom.window.document
global.window = dom.window
global.customElements = { define: () => {} }

import { createMemberPicker } from '../../../app/src/modules/rbac/member-picker.js'

const COLUMNS = [
  { key: 'username', label: 'Username', monospace: true },
  { key: 'fullname', label: 'Full Name' }
]

const ALICE = { username: 'alice', fullname: 'Alice Smith' }
const BOB = { username: 'bob', fullname: 'Bob Jones' }

describe('createMemberPicker', () => {
  let picker
  let addLog
  let removeLog

  beforeEach(() => {
    addLog = []
    removeLog = []
    picker = createMemberPicker({
      label: 'Members',
      columns: COLUMNS,
      items: [ALICE],
      availableOptions: [
        { value: 'bob', primaryLabel: 'bob', secondaryLabel: 'Bob Jones' }
      ],
      onAdd: async (value) => addLog.push(value),
      onRemove: async (item) => removeLog.push(item)
    })
  })

  it('returns an object with element, setItems, setAvailable, setDisabled', () => {
    assert.ok(picker.element instanceof dom.window.HTMLElement)
    assert.strictEqual(typeof picker.setItems, 'function')
    assert.strictEqual(typeof picker.setAvailable, 'function')
    assert.strictEqual(typeof picker.setDisabled, 'function')
  })

  it('renders initial items as table rows', () => {
    const rows = picker.element.querySelectorAll('tbody tr')
    assert.strictEqual(rows.length, 1)
    assert.ok(rows[0].textContent.includes('alice'))
    assert.ok(rows[0].textContent.includes('Alice Smith'))
  })

  it('renders empty state when items is empty', () => {
    picker.setItems([])
    const rows = picker.element.querySelectorAll('tbody tr')
    assert.strictEqual(rows.length, 0)
    // Should show "no members" text
    const emptyDiv = picker.element.querySelector('.member-picker-table-wrap div')
    assert.ok(emptyDiv, 'should have empty state div')
  })

  it('setItems replaces table rows', () => {
    picker.setItems([ALICE, BOB])
    const rows = picker.element.querySelectorAll('tbody tr')
    assert.strictEqual(rows.length, 2)
  })

  it('setDisabled(true) disables the Add button', () => {
    picker.setDisabled(true)
    const addBtn = picker.element.querySelector('[data-role="add-member-btn"]')
    assert.strictEqual(addBtn.disabled, true)
  })

  it('setDisabled(false) re-enables the Add button', () => {
    picker.setDisabled(true)
    picker.setDisabled(false)
    const addBtn = picker.element.querySelector('[data-role="add-member-btn"]')
    assert.strictEqual(addBtn.disabled, false)
  })

  it('clicking Add button inserts the add-row', () => {
    const addBtn = picker.element.querySelector('[data-role="add-member-btn"]')
    addBtn.click()
    const addRow = picker.element.querySelector('.add-member-row')
    assert.ok(addRow, 'add-row should appear after clicking Add')
  })

  it('clicking Cancel removes the add-row', () => {
    const addBtn = picker.element.querySelector('[data-role="add-member-btn"]')
    addBtn.click()
    const addRow = picker.element.querySelector('.add-member-row')
    assert.ok(addRow)
    const cancelBtn = addRow.querySelector('[data-role="cancel-add-btn"]')
    cancelBtn.click()
    assert.strictEqual(picker.element.querySelector('.add-member-row'), null)
  })

  it('clicking Add a second time does not add a second add-row', () => {
    const addBtn = picker.element.querySelector('[data-role="add-member-btn"]')
    addBtn.click()
    addBtn.click()
    const addRows = picker.element.querySelectorAll('.add-member-row')
    assert.strictEqual(addRows.length, 1)
  })

  it('clicking the remove button on a row calls onRemove with the item', async () => {
    const removeBtn = picker.element.querySelector('sl-icon-button[name="trash"]')
    removeBtn.click()
    // onRemove is async — give microtasks a tick
    await new Promise(r => setTimeout(r, 0))
    assert.deepStrictEqual(removeLog, [ALICE])
  })

  it('setDisabled(true) while add-row is open removes the add-row', () => {
    const addBtn = picker.element.querySelector('[data-role="add-member-btn"]')
    addBtn.click()
    assert.ok(picker.element.querySelector('.add-member-row'))
    picker.setDisabled(true)
    assert.strictEqual(picker.element.querySelector('.add-member-row'), null)
  })
})

describe('createMemberPicker — optionGroup headers', () => {
  it('renders group headers as disabled sl-option elements', () => {
    const picker = createMemberPicker({
      label: 'Members',
      columns: [{ key: 'username', label: 'User' }],
      items: [],
      availableOptions: [
        { value: 'alice', primaryLabel: 'alice', optionGroup: 'Users' },
        { value: 'g1', primaryLabel: 'g1', optionGroup: 'Groups' }
      ],
      onAdd: async () => {},
      onRemove: async () => {}
    })

    // Open the add-row to render options
    picker.element.querySelector('[data-role="add-member-btn"]').click()
    const selectEl = picker.element.querySelector('sl-select')

    // First sl-option should be the group header (disabled)
    const options = selectEl.querySelectorAll('sl-option')
    const disabledOptions = Array.from(options).filter(o => o.disabled)
    assert.ok(disabledOptions.length >= 1, 'should have at least one disabled group header option')
    assert.strictEqual(disabledOptions[0].textContent.trim(), 'Users')
  })
})
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
node tests/unit-test-runner.js tests/unit/js/rbac-member-picker.test.js
```

Expected: FAIL — `Cannot find module '…/member-picker.js'`

- [ ] **Step 3.3: Create `app/src/modules/rbac/member-picker.js`**

```javascript
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
```

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
node tests/unit-test-runner.js tests/unit/js/rbac-member-picker.test.js
```

Expected: PASS (all tests)

- [ ] **Step 3.5: Commit**

```bash
git add app/src/modules/rbac/member-picker.js tests/unit/js/rbac-member-picker.test.js
git commit -m "feat: add createMemberPicker reusable widget module"
```

---

## Task 4: Update HTML template

**Files:**
- Modify: `app/src/templates/rbac-manager-dialog.html`
- Regenerate: `app/src/templates/rbac-manager-dialog.types.js`

- [ ] **Step 4.1: Update `groupMembersSection` — remove heading and note**

In `app/src/templates/rbac-manager-dialog.html`, replace the current `groupMembersSection` block (lines 87–93):

```html
          <!-- Group members section (shown when a group is selected) -->
          <div name="groupMembersSection" style="display:none; margin-top: 1.25rem; border: 1px solid var(--sl-color-neutral-200); border-radius: var(--sl-border-radius-medium); padding: 0.75rem; background: var(--sl-color-neutral-50);">
            <div name="groupMembersList">
              <!-- createMemberPicker element inserted here -->
            </div>
          </div>
```

- [ ] **Step 4.2: Add `projectMembersSection` after `groupMembersSection`**

Insert immediately after the closing `</div>` of `groupMembersSection`:

```html
          <!-- Project members section (shown when a project is selected) -->
          <div name="projectMembersSection" style="display:none; margin-top: 1.25rem; border: 1px solid var(--sl-color-neutral-200); border-radius: var(--sl-border-radius-medium); padding: 0.75rem; background: var(--sl-color-neutral-50);">
            <div name="projectMembersList">
              <!-- createMemberPicker element inserted here -->
            </div>
          </div>
          <!-- User groups section (shown when a user is selected — read-only) -->
          <div name="userGroupsSection" style="display:none; margin-top: 1.25rem; border: 1px solid var(--sl-color-neutral-200); border-radius: var(--sl-border-radius-medium); padding: 0.75rem; background: var(--sl-color-neutral-50);">
            <h4 style="margin: 0 0 0.4rem; font-size: 0.85rem; font-weight: 600; color: var(--sl-color-neutral-700); text-transform: uppercase; letter-spacing: 0.04em;">Groups</h4>
            <div name="userGroupsList">
              <!-- read-only group table inserted here -->
            </div>
          </div>
```

- [ ] **Step 4.3: Regenerate UI types**

```bash
npm run build:ui-types
```

Expected: `app/src/templates/rbac-manager-dialog.types.js` is updated with new named elements.

- [ ] **Step 4.4: Commit**

```bash
git add app/src/templates/rbac-manager-dialog.html app/src/templates/rbac-manager-dialog.types.js
git commit -m "feat: add projectMembersSection and userGroupsSection to rbac-manager-dialog template"
```

---

## Task 5: Groups tab — `#renderGroupMembersWidget` and `#addUserToGroup`

**Files:**
- Modify: `app/src/plugins/rbac-manager.js`

- [ ] **Step 5.1: Add import for `createMemberPicker` at the top of `rbac-manager.js`**

Find the existing imports (around line 16–24) and add:

```javascript
import { createMemberPicker } from '../modules/rbac/member-picker.js'
```

- [ ] **Step 5.2: Add `#addUserToGroup` method (replaces `#removeUserFromGroup` context)**

Find `#removeUserFromGroup` (around line 712) and insert this new method **before** it:

```javascript
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
```

- [ ] **Step 5.3: Add `#renderGroupMembersWidget` method (replaces `#renderGroupMembers`)**

Insert this method immediately before `#addUserToGroup`:

```javascript
  /**
   * Render the group members section as an interactive member picker widget.
   * Replaces the read-only #renderGroupMembers display.
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
```

- [ ] **Step 5.4: Update `#removeUserFromGroup` to call `#renderGroupMembersWidget` instead of `#renderGroupMembers`**

Find `#removeUserFromGroup` (around line 712). The last line currently calls `this.#renderGroupMembers(groupId)`. Change it:

```javascript
      this.#renderGroupMembersWidget(groupId)
```

- [ ] **Step 5.5: Delete the now-unused `#renderGroupMembers` method**

`#renderGroupMembers` (lines 651–705 in the original file) is replaced by `#renderGroupMembersWidget`. Delete the entire method body. After this change, no callers reference `#renderGroupMembers`.

- [ ] **Step 5.6: Commit**

```bash
git add app/src/plugins/rbac-manager.js
git commit -m "feat: replace read-only group members display with interactive member picker"
```

---

## Task 6: Projects tab — `#renderProjectMembersSection`

**Files:**
- Modify: `app/src/plugins/rbac-manager.js`

- [ ] **Step 6.1: Add `#renderProjectMembersSection` method**

Insert this method after `#renderGroupMembersWidget`:

```javascript
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
```

- [ ] **Step 6.2: Add `#addProjectMember` method**

Insert after `#renderProjectMembersSection`:

```javascript
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
```

- [ ] **Step 6.3: Add `#removeProjectMember` method**

Insert after `#addProjectMember`:

```javascript
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
```

- [ ] **Step 6.4: Commit**

```bash
git add app/src/plugins/rbac-manager.js
git commit -m "feat: add project members picker with group expansion support"
```

---

## Task 7: Users tab — `#renderUserGroupsSection`

**Files:**
- Modify: `app/src/plugins/rbac-manager.js`

- [ ] **Step 7.1: Add `#renderUserGroupsSection` method**

Insert after `#removeProjectMember`:

```javascript
  /**
   * Render a read-only table of groups the selected user belongs to.
   * @param {string} username
   */
  #renderUserGroupsSection(username) {
    const section = this.#ui.querySelector('[name="userGroupsSection"]')
    if (!section) return
    section.style.display = 'block'

    const listEl = this.#ui.querySelector('[name="userGroupsList"]')
    listEl.innerHTML = ''

    const user = this.#entityManagers.user.findById(username)
    const userGroups = (user?.groups || [])
      .map(groupId => this.#entityManagers.group.findById(groupId))
      .filter(Boolean)

    if (userGroups.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'color: var(--sl-color-neutral-500); font-size: 0.8em; padding: 0.2rem 0;'
      empty.textContent = 'No groups assigned'
      listEl.appendChild(empty)
      return
    }

    const table = document.createElement('table')
    table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 0.82em;'
    table.innerHTML = `<thead><tr style="border-bottom: 1px solid var(--sl-color-neutral-200);">
      <th style="text-align:left; padding: 0.2rem 0.4rem; color: var(--sl-color-neutral-600); font-weight: 600;">Group ID</th>
      <th style="text-align:left; padding: 0.2rem 0.4rem; color: var(--sl-color-neutral-600); font-weight: 600;">Name</th>
    </tr></thead>`
    const tbody = document.createElement('tbody')

    for (const group of userGroups) {
      const tr = document.createElement('tr')
      tr.style.cssText = 'border-bottom: 1px solid var(--sl-color-neutral-100);'

      const tdId = document.createElement('td')
      tdId.style.cssText = 'padding: 0.2rem 0.4rem; font-family: monospace;'
      tdId.textContent = group.id

      const tdName = document.createElement('td')
      tdName.style.cssText = 'padding: 0.2rem 0.4rem;'
      tdName.textContent = group.name || ''

      tr.appendChild(tdId)
      tr.appendChild(tdName)
      tbody.appendChild(tr)
    }

    table.appendChild(tbody)
    listEl.appendChild(table)
  }
```

- [ ] **Step 7.2: Commit**

```bash
git add app/src/plugins/rbac-manager.js
git commit -m "feat: add read-only user groups section to Users tab"
```

---

## Task 8: Orchestration — `#showEntityForm`, `#switchTab`, `#showEmptyState`

**Files:**
- Modify: `app/src/plugins/rbac-manager.js`

- [ ] **Step 8.1: Update `#showEntityForm` — fix `firstSection` query**

Find (around line 340):

```javascript
    const firstSection = formContainer.querySelector('[name="entityConfigSection"]') || formContainer.querySelector('[name="groupMembersSection"]')
```

Replace with:

```javascript
    const firstSection = formContainer.querySelector('[name="entityConfigSection"], [name="groupMembersSection"], [name="projectMembersSection"], [name="userGroupsSection"]')
```

- [ ] **Step 8.2: Update `#showEntityForm` — replace `#renderGroupMembers` call and add new sections**

Find (around line 350):

```javascript
    if (this.#currentEntityType === 'group' && !this.#isNewEntity && this.#selectedEntityId) {
      this.#renderGroupMembers(this.#selectedEntityId)
    } else {
      const section = this.#ui.querySelector('[name="groupMembersSection"]')
      if (section) section.style.display = 'none'
    }
```

Replace with:

```javascript
    if (this.#currentEntityType === 'group' && !this.#isNewEntity && this.#selectedEntityId) {
      this.#renderGroupMembersWidget(this.#selectedEntityId)
    } else {
      const section = this.#ui.querySelector('[name="groupMembersSection"]')
      if (section) section.style.display = 'none'
    }

    if (this.#currentEntityType === 'project' && !this.#isNewEntity && this.#selectedEntityId) {
      this.#renderProjectMembersSection(this.#selectedEntityId)
    } else {
      const section = this.#ui.querySelector('[name="projectMembersSection"]')
      if (section) section.style.display = 'none'
    }

    if (this.#currentEntityType === 'user' && !this.#isNewEntity && this.#selectedEntityId) {
      this.#renderUserGroupsSection(this.#selectedEntityId)
    } else {
      const section = this.#ui.querySelector('[name="userGroupsSection"]')
      if (section) section.style.display = 'none'
    }
```

- [ ] **Step 8.3: Update `#switchTab` — hide new sections on tab switch**

Find (around line 192–199):

```javascript
    const configSection = this.#ui.querySelector('[name="entityConfigSection"]')
    if (configSection) configSection.style.display = 'none'

    const membersSection = this.#ui.querySelector('[name="groupMembersSection"]')
    if (membersSection) membersSection.style.display = 'none'
```

Replace with:

```javascript
    const configSection = this.#ui.querySelector('[name="entityConfigSection"]')
    if (configSection) configSection.style.display = 'none'

    const membersSection = this.#ui.querySelector('[name="groupMembersSection"]')
    if (membersSection) membersSection.style.display = 'none'

    const projectMembersSection = this.#ui.querySelector('[name="projectMembersSection"]')
    if (projectMembersSection) projectMembersSection.style.display = 'none'

    const userGroupsSection = this.#ui.querySelector('[name="userGroupsSection"]')
    if (userGroupsSection) userGroupsSection.style.display = 'none'
```

- [ ] **Step 8.4: Update `#showEmptyState` — hide new sections**

Find (around line 390–394):

```javascript
    const configSection = dialog.querySelector('[name="entityConfigSection"]')
    if (configSection) configSection.style.display = 'none'

    const membersSection = dialog.querySelector('[name="groupMembersSection"]')
    if (membersSection) membersSection.style.display = 'none'
```

Replace with:

```javascript
    const configSection = dialog.querySelector('[name="entityConfigSection"]')
    if (configSection) configSection.style.display = 'none'

    const membersSection = dialog.querySelector('[name="groupMembersSection"]')
    if (membersSection) membersSection.style.display = 'none'

    const projectMembersSection = dialog.querySelector('[name="projectMembersSection"]')
    if (projectMembersSection) projectMembersSection.style.display = 'none'

    const userGroupsSection = dialog.querySelector('[name="userGroupsSection"]')
    if (userGroupsSection) userGroupsSection.style.display = 'none'
```

- [ ] **Step 8.5: Run all unit tests to confirm nothing is broken**

```bash
npm run test:unit:js
```

Expected: All tests pass (including the new rbac tests from Tasks 1–3).

- [ ] **Step 8.6: Commit**

```bash
git add app/src/plugins/rbac-manager.js
git commit -m "feat: wire member picker sections into showEntityForm, switchTab, showEmptyState orchestration"
```

---

## Spec Coverage Verification

| Spec requirement | Task |
| --- | --- |
| `createMemberPicker` factory with `label`, `columns`, `items`, `availableOptions`, `onAdd`, `onRemove`, `disabled` | Task 3 |
| `setItems`, `setAvailable`, `setDisabled` handles | Task 3 |
| Inline add-row with filter input + sl-select + confirm/cancel | Task 3 |
| optionGroup headers as disabled sl-option with sl-divider | Task 3 |
| Groups tab: interactive picker (add/remove users) | Tasks 4, 5 |
| Projects tab: picker with Users + Groups option groups | Tasks 4, 6 |
| Group selection expands to individual members | Task 6 |
| Users tab: read-only group list | Tasks 4, 7 |
| `excludeFromForm` on `user.groups` and `project.members` | Task 1 |
| Form renderer skips `excludeFromForm` fields | Task 2 |
| `extractFormData` excludes those fields from save payload | Task 2 |
| Template: new section divs, groupMembersSection cleaned up | Task 4 |
| UI types regenerated | Task 4 |
| `#showEntityForm` orchestration for all 4 sections | Task 8 |
| `#switchTab` hides all sections | Task 8 |
| `#showEmptyState` hides all sections | Task 8 |

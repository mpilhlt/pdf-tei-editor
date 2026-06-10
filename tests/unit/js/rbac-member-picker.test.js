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

// Register a minimal filtered-combobox stub in jsdom so document.createElement('filtered-combobox')
// returns an element with the correct interface expected by member-picker.js.
dom.window.customElements.define('filtered-combobox', class extends dom.window.HTMLElement {
  constructor() {
    super()
    this._value = null
    this._options = []
  }
  setOptions(opts) { this._options = [...opts] }
  get value() { return this._value }
  clear() { this._value = null }
})

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

describe('createMemberPicker — filtered-combobox integration', () => {
  it('add-row contains a filtered-combobox element', () => {
    const picker = createMemberPicker({
      label: 'Members',
      columns: [{ key: 'username', label: 'User' }],
      items: [],
      availableOptions: [{ value: 'alice', primaryLabel: 'alice' }],
      onAdd: async () => {},
      onRemove: async () => {}
    })
    picker.element.querySelector('[data-role="add-member-btn"]').click()
    const combobox = picker.element.querySelector('filtered-combobox')
    assert.ok(combobox, 'add-row should contain a filtered-combobox')
  })

  it('passes group options to filtered-combobox with correct group property', () => {
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
    picker.element.querySelector('[data-role="add-member-btn"]').click()
    const combobox = picker.element.querySelector('filtered-combobox')
    assert.ok(combobox._options.some(o => o.group === 'Users'), 'should have Users group')
    assert.ok(combobox._options.some(o => o.group === 'Groups'), 'should have Groups group')
  })

  it('confirm button enables when combobox dispatches sl-change with a value', () => {
    const picker = createMemberPicker({
      label: 'Members',
      columns: [{ key: 'username', label: 'User' }],
      items: [],
      availableOptions: [{ value: 'bob', primaryLabel: 'bob' }],
      onAdd: async () => {},
      onRemove: async () => {}
    })
    picker.element.querySelector('[data-role="add-member-btn"]').click()
    const addRow = picker.element.querySelector('.add-member-row')
    const combobox = addRow.querySelector('filtered-combobox')
    const confirmBtn = addRow.querySelector('sl-button[variant="primary"]')
    assert.strictEqual(confirmBtn.disabled, true, 'confirm should start disabled')
    combobox.dispatchEvent(new dom.window.CustomEvent('sl-change', {
      detail: { value: 'bob', label: 'bob' },
      bubbles: true
    }))
    assert.strictEqual(confirmBtn.disabled, false, 'confirm should enable after sl-change')
  })
})

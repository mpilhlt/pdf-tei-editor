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

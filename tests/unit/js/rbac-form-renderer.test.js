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

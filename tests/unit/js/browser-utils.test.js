/**
 * Unit tests for renderTitleTemplate() in browser-utils.js
 *
 * @testCovers app/src/modules/browser-utils.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { renderTitleTemplate } from '../../../app/src/modules/browser-utils.js'

describe('renderTitleTemplate', () => {
  it('substitutes all present slots', () => {
    const result = renderTitleTemplate('{status}{appTitle} ({username})', {
      status: '',
      appTitle: 'PDF-TEI Editor',
      username: 'cboulanger'
    })
    assert.strictEqual(result, 'PDF-TEI Editor (cboulanger)')
  })

  it('applies a non-empty status prefix', () => {
    const result = renderTitleTemplate('{status}{appTitle} ({username})', {
      status: '● ',
      appTitle: 'PDF-TEI Editor',
      username: 'cboulanger'
    })
    assert.strictEqual(result, '● PDF-TEI Editor (cboulanger)')
  })

  it('collapses an empty ()  pair left by a missing slot', () => {
    const result = renderTitleTemplate('{status}{appTitle} ({username})', {
      status: '',
      appTitle: 'PDF-TEI Editor',
      username: ''
    })
    assert.strictEqual(result, 'PDF-TEI Editor')
  })

  it('treats a slot absent from the values object as empty', () => {
    const result = renderTitleTemplate('{status}{appTitle} ({username})', {
      appTitle: 'PDF-TEI Editor'
    })
    assert.strictEqual(result, 'PDF-TEI Editor')
  })

  it('ignores placeholders not present in the template', () => {
    const result = renderTitleTemplate('{appTitle}', {
      appTitle: 'PDF-TEI Editor',
      username: 'cboulanger'
    })
    assert.strictEqual(result, 'PDF-TEI Editor')
  })
})

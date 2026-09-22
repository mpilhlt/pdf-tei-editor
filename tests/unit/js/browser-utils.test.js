/**
 * Unit tests for renderTitleTemplate() in browser-utils.js
 *
 * @testCovers app/src/modules/browser-utils.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!DOCTYPE html>')
globalThis.document = dom.window.document

const { renderTitleTemplate, linkifyUrls } = await import('../../../app/src/modules/browser-utils.js')

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

describe('linkifyUrls', () => {
  it('turns a bare URL into a clickable link opening in a new tab', () => {
    const result = linkifyUrls('Start it first at https://huggingface.co/spaces/foo/bar and try again.')
    assert.strictEqual(
      result,
      'Start it first at <a href="https://huggingface.co/spaces/foo/bar" target="_blank" rel="noopener noreferrer">https://huggingface.co/spaces/foo/bar</a> and try again.'
    )
  })

  it('excludes trailing punctuation from the link', () => {
    const result = linkifyUrls('See https://example.com/path.')
    assert.strictEqual(
      result,
      'See <a href="https://example.com/path" target="_blank" rel="noopener noreferrer">https://example.com/path</a>.'
    )
  })

  it('linkifies multiple URLs independently', () => {
    const result = linkifyUrls('https://a.example vs https://b.example')
    assert.strictEqual(
      result,
      '<a href="https://a.example" target="_blank" rel="noopener noreferrer">https://a.example</a> vs <a href="https://b.example" target="_blank" rel="noopener noreferrer">https://b.example</a>'
    )
  })

  it('escapes HTML-significant characters in plain text', () => {
    const result = linkifyUrls('<script>alert(1)</script> & "quotes"')
    assert.strictEqual(result, '&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes"')
  })

  it('leaves text without URLs unchanged aside from escaping', () => {
    const result = linkifyUrls('No links here.')
    assert.strictEqual(result, 'No links here.')
  })
})

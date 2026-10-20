/**
 * @testCovers app/src/modules/secret-required.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSecretRequired } from '../../../app/src/modules/secret-required.js'

const detail = { code: 'secret_required', message: 'x', service: 'anthropic', label: 'Anthropic Claude', help_url: 'https://example.org' }

describe('getSecretRequired', () => {
  it('returns the service information of a 428 secret_required error', () => {
    assert.deepEqual(getSecretRequired({ statusCode: 428, detail }), detail)
  })

  it('ignores other errors', () => {
    assert.equal(getSecretRequired(new Error('boom')), null)
    assert.equal(getSecretRequired(null), null)
    assert.equal(getSecretRequired({ statusCode: 500, detail }), null)
    assert.equal(getSecretRequired({ statusCode: 428, detail: { code: 'other', service: 'a' } }), null)
    assert.equal(getSecretRequired({ statusCode: 428, detail: { code: 'secret_required' } }), null)
  })
})

/**
 * @testCovers app/src/modules/secret-required.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSecretRequired, withKeyPrompt } from '../../../app/src/modules/secret-required.js'

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

describe('withKeyPrompt', () => {
  const needKey = () => Object.assign(new Error('key needed'), { statusCode: 428, detail })

  /** Runs withKeyPrompt with a fake dialog; returns the order of events and the outcome. */
  async function run(promptResult, actions) {
    const events = []
    let calls = 0
    const action = async () => { events.push('action'); return actions[calls++]() }
    const prompt = async () => { events.push('prompt'); if (promptResult instanceof Error) throw promptResult; return promptResult }
    const blocker = { before: () => events.push('before'), after: () => events.push('after') }
    let outcome
    try { outcome = await withKeyPrompt(action, prompt, blocker) } catch (e) { outcome = e }
    return { events, outcome }
  }

  it('does not touch the blocker when no key is needed', async () => {
    const { events, outcome } = await run(true, [async () => 'ok'])
    assert.deepEqual(events, ['action'])
    assert.equal(outcome, 'ok')
  })

  it('lifts the blocker around the prompt and repeats the action once the key was saved', async () => {
    const { events, outcome } = await run(true, [async () => { throw needKey() }, async () => 'done'])
    assert.deepEqual(events, ['action', 'before', 'prompt', 'after', 'action'])
    assert.equal(outcome, 'done')
  })

  it('restores the blocker and rethrows when the dialog is cancelled', async () => {
    const { events, outcome } = await run(false, [async () => { throw needKey() }])
    assert.deepEqual(events, ['action', 'before', 'prompt', 'after'])
    assert.equal(outcome.statusCode, 428)
  })

  it('restores the blocker when the prompt fails', async () => {
    const { events } = await run(new Error('boom'), [async () => { throw needKey() }])
    assert.deepEqual(events, ['action', 'before', 'prompt', 'after'])
  })

  it('passes other errors through without prompting', async () => {
    const { events, outcome } = await run(true, [async () => { throw new Error('other') }])
    assert.deepEqual(events, ['action'])
    assert.equal(outcome.message, 'other')
  })
})

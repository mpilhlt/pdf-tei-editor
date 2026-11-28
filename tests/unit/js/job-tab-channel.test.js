#!/usr/bin/env node

/**
 * Tests for the coordination of tabs that drive client jobs
 *
 * @testCovers app/src/modules/job-tab-channel.js
 */

import { test, describe } from 'node:test'
import assert from 'node:assert'
import { JobTabChannel, resumeAction } from '../../../app/src/modules/job-tab-channel.js'

/** Connects fake BroadcastChannel ports: a message reaches every other port, asynchronously */
class FakeHub {
  constructor() { this.ports = new Set() }
  port() {
    const hub = this
    const port = {
      onmessage: null,
      postMessage(message) {
        for (const other of hub.ports) {
          if (other !== port) setTimeout(() => other.onmessage?.({ data: structuredClone(message) }), 1)
        }
      },
      close() { hub.ports.delete(port) }
    }
    this.ports.add(port)
    return port
  }
}

function storage(holder) {
  const store = new Map(holder ? [['job-holder', holder]] : [])
  return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
}

/** A tab with its own session storage on the hub */
function tab(hub, holder) {
  const sessionStorage = storage(holder)
  return { sessionStorage, channel: new JobTabChannel({ port: hub.port(), sessionStorage, timeout: 50 }) }
}

const job = (fields) => ({ id: 'j1', status: 'active', lease: { holder: 'h1', expires_at: '' }, ...fields })

describe('JobTabChannel', () => {
  test('a job is driven while a live tab marks it', async () => {
    const hub = new FakeHub()
    const original = tab(hub, 'h1')
    const other = tab(hub, 'h1')
    assert.strictEqual(await other.channel.isDriven('j1'), false)
    const end = original.channel.drive('j1')
    assert.strictEqual(await other.channel.isDriven('j1'), true)
    assert.strictEqual(await other.channel.isDriven('j2'), false)
    end()
    assert.strictEqual(await other.channel.isDriven('j1'), false)
  })

  test('a closed tab no longer answers', async () => {
    const hub = new FakeHub()
    const original = tab(hub, 'h1')
    const other = tab(hub, 'h1')
    original.channel.drive('j1')
    original.channel.close()
    assert.strictEqual(await other.channel.isDriven('j1'), false)
  })

  test('a duplicated tab takes a fresh holder id while the original is alive', async () => {
    const hub = new FakeHub()
    const original = tab(hub, 'h1')
    const duplicate = tab(hub, 'h1')
    assert.strictEqual(await duplicate.channel.ensureOwnHolder(), true)
    const fresh = duplicate.sessionStorage.getItem('job-holder')
    assert.ok(fresh && fresh !== 'h1')
    assert.strictEqual(original.sessionStorage.getItem('job-holder'), 'h1')
    // the ids differ now, so neither tab answers for the other's id
    assert.strictEqual(await original.channel.ensureOwnHolder(), false)
  })

  test('a reloaded tab keeps its holder id when no other tab uses it', async () => {
    const hub = new FakeHub()
    tab(hub, 'other')
    const reloaded = tab(hub, 'h1')
    assert.strictEqual(await reloaded.channel.ensureOwnHolder(), false)
    assert.strictEqual(reloaded.sessionStorage.getItem('job-holder'), 'h1')
  })

  test('without BroadcastChannel no tab answers', async () => {
    const channel = new JobTabChannel({ port: null, sessionStorage: storage('h1') })
    channel.drive('j1')
    assert.strictEqual(await channel.isDriven('j1'), false)
    assert.strictEqual(await channel.ensureOwnHolder(), false)
  })
})

describe('resumeAction', () => {
  const driven = (ids) => ({ isDriven: async (id) => ids.includes(id) })

  test('an active job of the own holder is resumed only if no live tab drives it', async () => {
    assert.strictEqual(await resumeAction(job(), 'h1', driven([])), 'resume')
    assert.strictEqual(await resumeAction(job(), 'h1', driven(['j1'])), 'skip')
  })

  test('an active job of another holder is left alone without asking the tabs', async () => {
    const tabs = { isDriven: async () => { throw new Error('must not ask') } }
    assert.strictEqual(await resumeAction(job({ lease: { holder: 'h2', expires_at: '' } }), 'h1', tabs), 'skip')
  })

  test('interrupted jobs: own ones resume, others need confirmation', async () => {
    const interrupted = { status: 'interrupted', lease: null }
    assert.strictEqual(await resumeAction(job({ ...interrupted, lease_holder: 'h1' }), 'h1', driven(['j1'])), 'resume')
    assert.strictEqual(await resumeAction(job({ ...interrupted, lease_holder: 'h2' }), 'h1', driven([])), 'confirm')
    assert.strictEqual(await resumeAction(job(interrupted), 'h1', driven([])), 'confirm')
  })

  test('the duplicated tab scenario: the copy skips the job the original drives', async () => {
    const hub = new FakeHub()
    const original = tab(hub, 'h1')
    const duplicate = tab(hub, 'h1')
    original.channel.drive('j1')
    await duplicate.channel.ensureOwnHolder()
    assert.strictEqual(await resumeAction(job(), duplicate.sessionStorage.getItem('job-holder'), duplicate.channel), 'skip')
    // even with the copied holder id, the liveness check keeps it from driving the job
    assert.strictEqual(await resumeAction(job(), 'h1', duplicate.channel), 'skip')
  })
})

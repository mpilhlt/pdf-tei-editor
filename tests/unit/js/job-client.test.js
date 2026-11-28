#!/usr/bin/env node

/**
 * Tests for the JobClient module
 *
 * @testCovers app/src/modules/job-client.js
 */

import { test, describe } from 'node:test'
import assert from 'node:assert'
import { JobClient, JobFailedError, JobCancelledError, formatJobProgress } from '../../../app/src/modules/job-client.js'

const PROGRESS = { value: null, done: null, total: null, unit: null, phase: null, eta_seconds: null }

/** Job as returned by the API */
function makeJob(fields = {}) {
  return { id: 'j1', type: 'demo', status: 'active', progress: PROGRESS, cancel_requested: false, steps: null, result: null, error: null, ...fields }
}

/** Event of the stream */
function makeEvent(fields = {}) {
  return { id: 1, seq: 1, job_id: 'j1', type: 'demo', status: 'active', progress: PROGRESS, cancel_requested: false, result: null, error: null, ...fields }
}

/** Fake EventSource that tests drive by hand */
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.closed = false
    this.listeners = {}
  }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) }
  close() { this.closed = true }
  emit(event, lastEventId = '') {
    for (const fn of this.listeners.job ?? []) fn({ data: JSON.stringify(event), lastEventId })
  }
  fail() { this.onerror?.(new Event('error')) }
}

function setup({ jobs = {}, api = {}, feed, safetyPollInterval = 60000 } = {}) {
  const sources = []
  const calls = []
  const store = new Map()
  const fakeApi = {
    jobsGet: async (id) => { calls.push(['jobsGet', id]); const j = jobs[id]; return typeof j === 'function' ? j() : (j ?? makeJob({ id })) },
    jobsSubmit: async (body, opts) => { calls.push(['jobsSubmit', body, opts]); return makeJob({ id: 'new', type: body.type }) },
    jobsList: async (f) => { calls.push(['jobsList', f]); return [] },
    jobsCancel: async (id) => { calls.push(['jobsCancel', id]); return makeJob({ id }) },
    jobsTypes: async () => { calls.push(['jobsTypes']); return [{ name: 'demo', title: 'Demo', driver: 'client', roles: [] }] },
    jobsClaim: async (id, body) => { calls.push(['jobsClaim', id, body]); return makeJob({ id, steps: {} }) },
    jobsHeartbeat: async (id, body) => { calls.push(['jobsHeartbeat', id, body]); return makeJob({ id }) },
    jobsSaveStep: async (id, key, body) => { calls.push(['jobsSaveStep', id, key, body]) },
    jobsReport: async (id, body) => { calls.push(['jobsReport', id, body]); return makeJob({ id }) },
    jobsFinish: async (id, body) => { calls.push(['jobsFinish', id, body]); return makeJob({ id }) },
    ...api
  }
  const client = new JobClient({
    api: fakeApi,
    feed,
    eventSourceFactory: (url) => { const s = new FakeEventSource(url); sources.push(s); return s },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    eventsUrl: '/api/v1/jobs/events?mine=true&sessionId=abc',
    pollInterval: 10,
    safetyPollInterval,
    reconnectBase: 10
  })
  return { client, sources, calls, store }
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

describe('JobClient.wait', () => {
  test('wait resolves with the result of a done event', async () => {
    const { client, sources } = setup()
    const p = client.wait('j1')
    await tick()
    sources[0].emit(makeEvent({ status: 'done', result: { ok: 1 } }))
    assert.deepStrictEqual(await p, { ok: 1 })
  })

  test('wait rejects JobFailedError with the error status', async () => {
    const { client, sources } = setup()
    const p = client.wait('j1')
    await tick()
    sources[0].emit(makeEvent({ status: 'error', error: { message: 'boom', status: 422 } }))
    await assert.rejects(p, (e) => e instanceof JobFailedError && e.status === 422 && e.message === 'boom')
  })

  test('wait rejects JobCancelledError', async () => {
    const { client, sources } = setup()
    const p = client.wait('j1')
    await tick()
    sources[0].emit(makeEvent({ status: 'cancelled' }))
    await assert.rejects(p, JobCancelledError)
  })

  test('wait ignores events of other jobs', async () => {
    const { client, sources } = setup()
    const p = client.wait('j1')
    await tick()
    sources[0].emit(makeEvent({ job_id: 'other', status: 'done', result: 'x' }))
    sources[0].emit(makeEvent({ status: 'done', result: 'mine' }))
    assert.strictEqual(await p, 'mine')
  })

  test('wait resolves for a job already done before subscribing', async () => {
    const { client } = setup({ jobs: { j1: makeJob({ status: 'done', result: 'early' }) } })
    assert.strictEqual(await client.wait('j1'), 'early')
  })

  test('wait polls while the stream is in error and resolves from polling', async () => {
    let n = 0
    const { client, sources } = setup({ jobs: { j1: () => (++n < 3 ? makeJob() : makeJob({ status: 'done', result: 'polled' })) } })
    const p = client.wait('j1')
    await tick()
    sources[0].fail()
    assert.strictEqual(await p, 'polled')
  })

  test('wait stops on abort without cancelling the job', async () => {
    const { client, calls } = setup()
    const controller = new AbortController()
    const p = client.wait('j1', { signal: controller.signal })
    await tick()
    controller.abort()
    await assert.rejects(p, (e) => e.name === 'AbortError')
    assert.ok(!calls.some(c => c[0] === 'jobsCancel'))
  })
})

describe('JobClient.subscribe', () => {
  test('reconnect sends last_event_id of the last event', async () => {
    const { client, sources } = setup()
    const received = []
    client.subscribe(e => received.push(e))
    sources[0].emit(makeEvent({ id: 7, seq: 7 }), '7')
    sources[0].fail()
    assert.ok(sources[0].closed)
    await tick(40)
    assert.strictEqual(sources.length, 2)
    assert.ok(sources[1].url.endsWith('&last_event_id=7'), sources[1].url)
    assert.strictEqual(received.length, 1)
  })

  test('one EventSource for several waiters', async () => {
    const { client, sources } = setup()
    const p1 = client.wait('j1')
    const p2 = client.wait('j2')
    await tick()
    assert.strictEqual(sources.length, 1)
    sources[0].emit(makeEvent({ job_id: 'j1', status: 'done', result: 1 }))
    sources[0].emit(makeEvent({ job_id: 'j2', status: 'done', result: 2 }))
    assert.deepStrictEqual(await Promise.all([p1, p2]), [1, 2])
  })

  test('closes the EventSource after the last unsubscribe', () => {
    const { client, sources } = setup()
    const off1 = client.subscribe(() => {})
    const off2 = client.subscribe(() => {})
    off1()
    assert.strictEqual(sources[0].closed, false)
    off2()
    assert.strictEqual(sources[0].closed, true)
  })
})

/** Feed that tests drive by hand */
function makeFeed() {
  const listeners = new Set()
  const feed = {
    isConnected: true,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    connected() { return feed.isConnected },
    emit(event) { for (const l of [...listeners]) l(event) },
    listeners
  }
  return feed
}

describe('JobClient with a feed', () => {
  test('subscribe uses the feed and opens no EventSource', () => {
    const feed = makeFeed()
    const { client, sources } = setup({ feed })
    const events = []
    const off = client.subscribe(e => events.push(e))
    feed.emit(makeEvent())
    assert.strictEqual(events.length, 1)
    assert.strictEqual(sources.length, 0)
    off()
    assert.strictEqual(feed.listeners.size, 0)
  })

  test('wait resolves from a feed event', async () => {
    const feed = makeFeed()
    const { client, sources } = setup({ feed })
    const p = client.wait('j1')
    await tick()
    feed.emit(makeEvent({ status: 'done', result: { ok: 2 } }))
    assert.deepStrictEqual(await p, { ok: 2 })
    assert.strictEqual(sources.length, 0)
    assert.strictEqual(feed.listeners.size, 0)
  })

  test('wait polls while the feed is not connected', async () => {
    const feed = makeFeed()
    feed.isConnected = false
    let n = 0
    const { client } = setup({ feed, jobs: { j1: () => (++n >= 3 ? makeJob({ status: 'done', result: 7 }) : makeJob()) } })
    assert.strictEqual(await client.wait('j1'), 7)
  })

  test('wait rejects with status 404 and stops polling when the job is deleted', async () => {
    const feed = makeFeed()
    feed.isConnected = false
    let n = 0
    const notFound = Object.assign(new Error('Job not found'), { statusCode: 404 })
    const { client, calls } = setup({ feed, safetyPollInterval: 15, jobs: { j1: () => { if (++n >= 3) throw notFound; return makeJob() } } })
    await assert.rejects(client.wait('j1'), (e) => e instanceof JobFailedError && e.status === 404 && /no longer exists/.test(e.message))
    const gets = calls.filter(c => c[0] === 'jobsGet').length
    await tick(60)
    // both timers are cleared
    assert.strictEqual(calls.filter(c => c[0] === 'jobsGet').length, gets)
  })

  test('wait keeps polling after other refetch errors', async () => {
    const feed = makeFeed()
    feed.isConnected = false
    let n = 0
    const { client } = setup({ feed, jobs: { j1: () => { ++n; if (n === 2) throw Object.assign(new Error('Bad gateway'), { statusCode: 502 }); return n >= 4 ? makeJob({ status: 'done', result: 'ok' }) : makeJob() } } })
    assert.strictEqual(await client.wait('j1'), 'ok')
  })

  test('wait does not poll while the feed is connected', async () => {
    const feed = makeFeed()
    const { client, calls } = setup({ feed })
    const p = client.wait('j1')
    await tick(50)
    assert.strictEqual(calls.filter(c => c[0] === 'jobsGet').length, 1)
    feed.emit(makeEvent({ status: 'done', result: 1 }))
    await p
  })

  test('recheck settles a wait whose final event the feed missed', async () => {
    const feed = makeFeed()
    let state = makeJob()
    const { client } = setup({ feed, jobs: { j1: () => state } })
    const p = client.wait('j1')
    await tick()
    state = makeJob({ status: 'done', result: 'late' }) // the done event was lost
    client.recheck()
    assert.strictEqual(await p, 'late')
  })

  test('the safety poll settles a wait while the feed seems connected but misses events', async () => {
    const feed = makeFeed()
    let state = makeJob()
    const { client, calls } = setup({ feed, safetyPollInterval: 20, jobs: { j1: () => state } })
    const p = client.wait('j1')
    await tick()
    state = makeJob({ status: 'error', error: { message: 'gone', status: 500 } })
    await assert.rejects(p, (e) => e instanceof JobFailedError && e.message === 'gone')
    assert.ok(calls.filter(c => c[0] === 'jobsGet').length >= 2)
  })

  test('recheck fetches no job after its wait settled', async () => {
    const feed = makeFeed()
    const { client, calls } = setup({ feed })
    const p = client.wait('j1')
    await tick()
    feed.emit(makeEvent({ status: 'done', result: 1 }))
    await p
    const gets = calls.filter(c => c[0] === 'jobsGet').length
    client.recheck()
    await tick()
    assert.strictEqual(calls.filter(c => c[0] === 'jobsGet').length, gets)
  })

  test('the constructor needs a feed or an events URL', () => {
    assert.throws(() => new JobClient({ api: {}, sessionStorage: { getItem: () => null, setItem: () => {} } }), /feed/)
  })
})

describe('JobClient requests', () => {
  test('submit passes the options and types are cached', async () => {
    const { client, calls } = setup()
    await client.submit('demo', { a: 1 }, { resources: ['file:x'], inputHash: 'h', idempotencyKey: 'k' })
    assert.deepStrictEqual(calls[0], ['jobsSubmit', { type: 'demo', params: { a: 1 }, resources: ['file:x'], input_hash: 'h' }, { idempotencyKey: 'k' }])
    await client.types()
    await client.types()
    assert.strictEqual(calls.filter(c => c[0] === 'jobsTypes').length, 1)
  })
})

describe('JobClient.runClientJob', () => {
  test('runClientJob skips saved steps and saves new ones', async () => {
    const { client, calls } = setup({
      api: { jobsClaim: async (id) => makeJob({ id, steps: { a: { result: 'saved-a', at: 'x' } } }) }
    })
    let ranA = false
    const result = await client.runClientJob('demo', {}, async (run) => {
      const a = await run.step('a', async () => { ranA = true; return 'new-a' })
      const b = await run.step('b', async () => 'new-b')
      return [a, b]
    })
    assert.deepStrictEqual(result, ['saved-a', 'new-b'])
    assert.strictEqual(ranA, false)
    const saves = calls.filter(c => c[0] === 'jobsSaveStep')
    assert.strictEqual(saves.length, 1)
    assert.strictEqual(saves[0][2], 'b')
    assert.deepStrictEqual(saves[0][3].result, 'new-b')
    assert.deepStrictEqual(calls.at(-1)[2].result, ['saved-a', 'new-b'])
  })

  test('runClientJob finishes cancelled when report sees cancel_requested', async () => {
    const { client, calls } = setup({ api: { jobsReport: async (id) => makeJob({ id, cancel_requested: true }) } })
    await assert.rejects(
      client.runClientJob('demo', {}, async (run) => { await run.report({ done: 1, total: 2 }) }),
      JobCancelledError
    )
    const finish = calls.find(c => c[0] === 'jobsFinish')
    assert.strictEqual(finish[2].cancelled, true)
  })

  test('runClientJob finishes with an error when the body throws', async () => {
    const { client, calls } = setup()
    await assert.rejects(client.runClientJob('demo', {}, async () => { throw new Error('bad') }), /bad/)
    const finish = calls.find(c => c[0] === 'jobsFinish')
    assert.deepStrictEqual(finish[2].error, { message: 'bad', status: 500 })
  })

  test('runClientJob reuses the holder from sessionStorage', async () => {
    const { client, calls, store } = setup()
    await client.runClientJob('demo', {}, async () => 1)
    await client.runClientJob('demo', {}, async () => 2)
    const holders = calls.filter(c => c[0] === 'jobsClaim').map(c => c[2].holder)
    assert.strictEqual(holders.length, 2)
    assert.strictEqual(holders[0], holders[1])
    assert.strictEqual(store.get('job-holder'), holders[0])
    assert.strictEqual(client.holder, holders[0])
  })

  test('runClientJob resumes a given job id without submitting', async () => {
    const { client, calls } = setup()
    await client.runClientJob('demo', {}, async () => 1, { jobId: 'old' })
    assert.ok(!calls.some(c => c[0] === 'jobsSubmit'))
    assert.strictEqual(calls.find(c => c[0] === 'jobsClaim')[1], 'old')
  })
})

describe('formatJobProgress', () => {
  test('formatJobProgress formats phase, counts and eta', () => {
    const text = formatJobProgress(makeJob({ progress: { ...PROGRESS, phase: 'Recognizing text', done: 3, total: 10, unit: 'pages', eta_seconds: 120 } }))
    assert.strictEqual(text, 'Recognizing text, pages 3 of 10, about 2 minutes left')
  })

  test('formatJobProgress handles queued jobs, missing progress and short eta', () => {
    assert.match(formatJobProgress(makeJob({ status: 'queued' })), /Waiting/)
    assert.match(formatJobProgress(makeJob()), /may take a while/)
    assert.match(formatJobProgress(makeJob({ progress: { ...PROGRESS, phase: 'X', eta_seconds: 20 } })), /less than a minute left/)
    assert.strictEqual(formatJobProgress(makeJob({ progress: { ...PROGRESS, phase: 'X', done: 1, total: 2 } }), 'Working'), 'Working: X (1 of 2)')
  })
})

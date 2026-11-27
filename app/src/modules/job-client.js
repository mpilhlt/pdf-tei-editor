/**
 * Client of the job queue (`/api/v1/jobs`): submit, wait for, cancel and drive jobs.
 *
 * Has no plugin imports; everything it needs is passed to the constructor. See
 * docs/code-assistant/jobs.md for the concepts.
 *
 * @import { ApiClientV1, Job, JobEvent, JobProgress, JobTypeInfo } from './api-client-v1.js'
 */

const HOLDER_KEY = 'job-holder'
const HEARTBEAT_INTERVAL = 10000
const MAX_RECONNECT_DELAY = 30000

/** Rejection of {@link JobClient#wait} for a job that failed or expired */
export class JobFailedError extends Error {
  /**
   * @param {string} message
   * @param {number} [status] - HTTP-like status of the job's error
   */
  constructor(message, status = 500) {
    super(message)
    this.name = 'JobFailedError'
    this.status = status
  }
}

/** Rejection of {@link JobClient#wait} for a cancelled job; thrown in a client job body to stop it */
export class JobCancelledError extends Error {
  /** @param {string} [message] */
  constructor(message = 'The job was cancelled') {
    super(message)
    this.name = 'JobCancelledError'
  }
}

/**
 * @typedef {Object} JobRun
 * @property {Job} job - The claimed job, with its saved steps
 * @property {<T>(key: string, fn: () => Promise<T>) => Promise<T>} step - Return the saved result of the step, or run `fn` and save its result
 * @property {(progress: Partial<JobProgress>) => Promise<void>} report - Report progress; throws {@link JobCancelledError} if a cancel was requested
 */

/**
 * A source of job events that the client uses instead of opening an EventSource of its own, e.g.
 * the `job` events of the editor's SSE stream.
 * @typedef {Object} JobEventFeed
 * @property {(listener: (event: JobEvent) => void) => () => void} subscribe - Returns a function that removes the listener
 * @property {() => boolean} connected - Whether events arrive; while false, {@link JobClient#wait} polls
 */

/**
 * @typedef {Object} JobClientOptions
 * @property {ApiClientV1} api
 * @property {Pick<Storage, 'getItem' | 'setItem'>} sessionStorage
 * @property {JobEventFeed} [feed] - Source of the events; without it, the client opens `eventsUrl` with `eventSourceFactory`
 * @property {(url: string) => EventSource} [eventSourceFactory] - Required without `feed`
 * @property {string} [eventsUrl] - `/api/v1/jobs/events?mine=true&sessionId=<id>`; required without `feed`
 * @property {number} [pollInterval] - Milliseconds between polls while the stream is in error (default 2000)
 * @property {number} [safetyPollInterval] - Milliseconds between polls of a waited job while the stream seems fine, in case events were missed anyway (default 30000)
 * @property {number} [reconnectBase] - First reconnect delay in milliseconds, doubled up to 30 s (default 1000)
 */

export class JobClient {
  #api
  /** @type {JobEventFeed|null} */
  #feed
  #eventSourceFactory
  #sessionStorage
  #eventsUrl
  #pollInterval
  #safetyPollInterval
  /** @type {Set<() => void>} Functions that fetch the state of a waited job again */
  #pendingWaits = new Set()
  #reconnectBase
  /** @type {Set<(event: JobEvent) => void>} */
  #listeners = new Set()
  /** @type {EventSource|null} */
  #source = null
  /** @type {ReturnType<typeof setTimeout>|null} */
  #reconnectTimer = null
  #reconnectDelay
  #streamInError = false
  /** @type {string|null} */
  #lastEventId = null
  /** @type {Promise<JobTypeInfo[]>|null} */
  #types = null

  /** @param {JobClientOptions} options */
  constructor({ api, feed, eventSourceFactory, sessionStorage, eventsUrl, pollInterval = 2000, safetyPollInterval = 30000, reconnectBase = 1000 }) {
    if (!feed && (!eventSourceFactory || !eventsUrl)) throw new Error('JobClient needs a feed, or an eventSourceFactory and an eventsUrl')
    this.#api = api
    this.#feed = feed ?? null
    this.#eventSourceFactory = eventSourceFactory
    this.#sessionStorage = sessionStorage
    this.#eventsUrl = eventsUrl
    this.#pollInterval = pollInterval
    this.#safetyPollInterval = safetyPollInterval
    this.#reconnectBase = reconnectBase
    this.#reconnectDelay = reconnectBase
  }

  /**
   * Submit a job.
   * @param {string} type
   * @param {*} params
   * @param {{resources?: string[], inputHash?: string, idempotencyKey?: string}} [options]
   * @returns {Promise<Job>}
   */
  async submit(type, params, { resources, inputHash, idempotencyKey } = {}) {
    /** @type {import('./api-client-v1.js').JobSubmitRequest} */
    const body = { type, params }
    if (resources) body.resources = resources
    if (inputHash) body.input_hash = inputHash
    return this.#api.jobsSubmit(body, { idempotencyKey })
  }

  /**
   * @param {string} jobId
   * @returns {Promise<Job>}
   */
  async get(jobId) {
    return this.#api.jobsGet(jobId)
  }

  /**
   * @param {import('./api-client-v1.js').JobListFilter} [filter]
   * @returns {Promise<Job[]>}
   */
  async list(filter) {
    return this.#api.jobsList(filter)
  }

  /**
   * Request cancellation of a job.
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async cancel(jobId) {
    await this.#api.jobsCancel(jobId)
  }

  /**
   * The registered job types (cached).
   * @returns {Promise<JobTypeInfo[]>}
   */
  async types() {
    if (!this.#types) {
      this.#types = this.#api.jobsTypes().catch((error) => {
        this.#types = null
        throw error
      })
    }
    return this.#types
  }

  /**
   * Listen to the job events of the user. With a feed, the listener is added to it. Otherwise all
   * listeners share one EventSource, which is opened for the first listener and closed after the
   * last one is removed.
   * @param {(event: JobEvent) => void} listener
   * @returns {() => void} Function that removes the listener
   */
  subscribe(listener) {
    if (this.#feed) return this.#feed.subscribe(listener)
    this.#listeners.add(listener)
    if (!this.#source && this.#reconnectTimer === null) this.#open()
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#close()
    }
  }

  /**
   * Whether events may be missed, so that {@link JobClient#wait} must poll.
   * @returns {boolean}
   */
  #inError() {
    return this.#feed ? !this.#feed.connected() : this.#streamInError
  }

  /** Open the EventSource, resuming after the last event seen. */
  #open() {
    let url = /** @type {string} */ (this.#eventsUrl)
    if (this.#lastEventId !== null) {
      url += `${url.includes('?') ? '&' : '?'}last_event_id=${encodeURIComponent(this.#lastEventId)}`
    }
    const source = /** @type {(url: string) => EventSource} */ (this.#eventSourceFactory)(url)
    this.#source = source
    source.addEventListener('job', (message) => {
      this.#streamInError = false
      this.#reconnectDelay = this.#reconnectBase
      /** @type {JobEvent} */
      let event
      try {
        event = JSON.parse(message.data)
      } catch {
        return
      }
      const id = message.lastEventId || (event.id !== null && event.id !== undefined ? String(event.id) : '')
      if (id) this.#lastEventId = id
      for (const listener of [...this.#listeners]) listener(event)
    })
    source.onopen = () => {
      this.#streamInError = false
    }
    source.onerror = () => {
      this.#streamInError = true
      source.close()
      if (this.#source !== source) return
      this.#source = null
      const delay = this.#reconnectDelay
      this.#reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY)
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null
        if (this.#listeners.size > 0) this.#open()
      }, delay)
    }
  }

  /** Close the EventSource and cancel a pending reconnect. */
  #close() {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#source?.close()
    this.#source = null
    this.#streamInError = false
    this.#reconnectDelay = this.#reconnectBase
  }

  /**
   * Fetch the state of every waited job again, e.g. after a reconnection of the feed or when the
   * server reports lost events, since {@link JobClient#wait} would otherwise miss a final state
   * that was sent in the gap.
   */
  recheck() {
    for (const refetch of [...this.#pendingWaits]) refetch()
  }

  /**
   * Wait until a job is finished. Aborting the signal only stops waiting; the job keeps running.
   * @param {string} jobId
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<unknown>} The result of the job
   */
  wait(jobId, { signal } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      /** @type {(() => void)|null} */
      let unsubscribe = null
      /** @type {ReturnType<typeof setInterval>|null} */
      let pollTimer = null
      /** @type {ReturnType<typeof setInterval>|null} */
      let safetyTimer = null

      const refetch = () => { this.get(jobId).then(check, () => {}) }
      const cleanup = () => {
        settled = true
        unsubscribe?.()
        if (pollTimer !== null) clearInterval(pollTimer)
        if (safetyTimer !== null) clearInterval(safetyTimer)
        this.#pendingWaits.delete(refetch)
        signal?.removeEventListener('abort', onAbort)
      }
      /** @param {Pick<Job, 'status'|'result'|'error'>} state */
      const check = (state) => {
        if (settled) return
        switch (state.status) {
          case 'done':
            cleanup()
            resolve(state.result)
            break
          case 'error':
          case 'expired':
            cleanup()
            reject(new JobFailedError(state.error?.message ?? `The job ${state.status === 'expired' ? 'expired' : 'failed'}`, state.error?.status ?? 500))
            break
          case 'cancelled':
            cleanup()
            reject(new JobCancelledError())
            break
        }
      }
      /** @param {unknown} error */
      const fail = (error) => {
        if (settled) return
        cleanup()
        reject(error)
      }
      const onAbort = () => fail(new DOMException('Waiting for the job was aborted', 'AbortError'))

      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort)
      // subscribe before the first get() so that no event is missed
      unsubscribe = this.subscribe((event) => {
        if (event.job_id === jobId) check(event)
      })
      this.get(jobId).then(check, fail)
      this.#pendingWaits.add(refetch)
      pollTimer = setInterval(() => {
        if (this.#inError()) refetch()
      }, this.#pollInterval)
      // events can be missed although the stream seems fine (e.g. a stream that another page of
      // the session took over), so a waited job is also polled now and then
      safetyTimer = setInterval(refetch, this.#safetyPollInterval)
    })
  }

  /**
   * The id of this browser tab as lease holder of client jobs, created once per tab and kept
   * across reloads (session storage).
   * @returns {string}
   */
  get holder() {
    return this.#holder()
  }

  /**
   * The id of this browser tab as lease holder of client jobs, created once per tab.
   * @returns {string}
   */
  #holder() {
    let holder = this.#sessionStorage.getItem(HOLDER_KEY)
    if (!holder) {
      holder = crypto.randomUUID()
      this.#sessionStorage.setItem(HOLDER_KEY, holder)
    }
    return holder
  }

  /**
   * Run a client job: submit it (or resume `jobId`), claim it, keep its lease with heartbeats and
   * finish it with the result of `body`. Steps saved by an earlier run are not run again.
   * @template T
   * @param {string} type
   * @param {*} params
   * @param {(run: JobRun) => Promise<T>} body - Throw {@link JobCancelledError} to finish the job as cancelled
   * @param {{resources?: string[], inputHash?: string, jobId?: string}} [options]
   * @returns {Promise<T>}
   */
  async runClientJob(type, params, body, { resources, inputHash, jobId } = {}) {
    const holder = this.#holder()
    const submitted = jobId ? { id: jobId } : await this.submit(type, params, { resources, inputHash })
    const job = await this.#api.jobsClaim(submitted.id, { holder })
    const steps = { ...(job.steps ?? {}) }
    let cancelRequested = false
    const heartbeat = setInterval(async () => {
      try {
        const current = await this.#api.jobsHeartbeat(job.id, { holder })
        if (current?.cancel_requested) cancelRequested = true
      } catch {
        // a failed heartbeat is retried; the lease expires only after several missed ones
      }
    }, HEARTBEAT_INTERVAL)

    /** @type {JobRun} */
    const run = {
      job,
      step: async (key, fn) => {
        if (key in steps) return steps[key].result
        const result = await fn()
        await this.#api.jobsSaveStep(job.id, key, { holder, result })
        steps[key] = { result, at: new Date().toISOString() }
        return result
      },
      report: async (progress) => {
        const current = await this.#api.jobsReport(job.id, { holder, progress })
        if (current?.cancel_requested || cancelRequested) throw new JobCancelledError()
      }
    }

    try {
      let result
      try {
        result = await body(run)
      } catch (error) {
        if (error instanceof JobCancelledError) {
          await this.#api.jobsFinish(job.id, { holder, cancelled: true }).catch(() => {})
        } else {
          const message = error instanceof Error ? error.message : String(error)
          await this.#api.jobsFinish(job.id, { holder, error: { message, status: 500 } }).catch(() => {})
        }
        throw error
      }
      await this.#api.jobsFinish(job.id, { holder, result })
      return result
    } finally {
      clearInterval(heartbeat)
    }
  }
}

/**
 * Describe the state of an unfinished job for the user, with the progress and the estimated
 * remaining time of the current phase if the job reports them.
 * @param {Job} job
 * @param {string} [heading] - What the job does; prefixed as "heading: ..."
 * @returns {string} E.g. "Recognizing text, pages 12 of 71, about 2 minutes left"
 */
export function formatJobProgress(job, heading = '') {
  if (job.status === 'queued') {
    return 'Waiting for other jobs to finish'
  }
  const progress = job.progress
  if (!progress || (!progress.phase && !progress.total)) {
    return `${heading || 'Working'}, this may take a while`
  }
  let message = progress.phase ?? ''
  if (progress.total) {
    const counts = `${progress.done ?? 0} of ${progress.total}`
    if (progress.unit) message += `${message ? ', ' : ''}${progress.unit} ${counts}`
    else message += message ? ` (${counts})` : counts
  }
  const eta = progress.eta_seconds
  if (typeof eta === 'number' && eta > 0) {
    if (eta < 60) {
      message += ', less than a minute left'
    } else {
      const minutes = Math.round(eta / 60)
      message += `, about ${minutes} minute${minutes === 1 ? '' : 's'} left`
    }
  }
  return heading ? `${heading}: ${message}` : message
}

/**
 * Jobs plugin: the frontend of the job queue (`/api/v1/jobs`).
 *
 * Owns the {@link JobClient} of the logged-in session and shows every unfinished job of the user
 * as a progress widget (id `job-<job id>`), with a cancel button. Failed jobs are notified unless
 * this tab waits for them through {@link JobsPlugin#wait} or runs them through
 * {@link JobsPlugin#runClientJob}, in which case the caller reports the error.
 *
 * The events arrive as `job` events of the SSE stream of the `sse` plugin (forwarded by the
 * backend's job SSE bridge); the plugin opens no stream of its own, since browsers allow only six
 * connections per host on HTTP/1.1. The events may also concern jobs of other users (admins);
 * only the user's own jobs get widgets. After login, after each (re)connection of the SSE stream
 * and on `jobsResync`, the plugin lists the unfinished jobs again, since events of the gap are
 * lost. After login, interrupted client jobs are resumed through the `jobs.resume` extension
 * point. See docs/code-assistant/jobs.md.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { Job, JobEvent } from '../modules/api-client-v1.js'
 * @import { JobRun, JobEventFeed } from '../modules/job-client.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { JobClient, JobCancelledError, formatJobProgress } from '../modules/job-client.js'
import { notify } from '../modules/sl-utils.js'
import { testLog } from '../modules/test-log.js'
import ep from '../extension-points.js'

/**
 * Contribution of a plugin to the `jobs.resume` extension point: resumes client jobs of a type
 * after a reload, typically with `jobs.runClientJob(type, params, body, {jobId: job.id})`.
 * @typedef {Object} JobResumeContribution
 * @property {string} type - The job type
 * @property {(job: Job) => Promise<void>} resume
 */

const UNFINISHED = ['queued', 'active', 'interrupted']
const FINISHED_QUIETLY = ['done', 'cancelled', 'expired']

class JobsPlugin extends Plugin {
  /** @type {JobClient|null} */
  #client = null

  /** @type {string|null} Session id of the current client */
  #sessionId = null

  /** @type {(() => void)|null} */
  #unsubscribe = null

  /** @type {Map<string, string>} Job type name -> title */
  #titles = new Map()

  /** @type {Map<string, JobEvent>} Latest event of each unfinished job that has a widget */
  #jobs = new Map()

  /** @type {Set<string>} Jobs whose final state was handled, so that a repeated one (event and fetched state) is ignored */
  #finished = new Set()

  /** @type {Set<string>} Jobs whose errors a caller in this tab reports */
  #waited = new Set()

  #appReady = false

  /** @type {Set<(event: JobEvent) => void>} Listeners of the feed of the job client */
  #feedListeners = new Set()

  /** @type {JobEventFeed} The `job` events of the SSE stream */
  #feed = {
    subscribe: (listener) => {
      this.#feedListeners.add(listener)
      return () => { this.#feedListeners.delete(listener) }
    },
    connected: () => this.getDependency('sse').readyState === EventSource.OPEN
  }

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'jobs', deps: ['client', 'sse', 'progress', 'logger', 'dialog'] })
  }

  get #logger() { return this.getDependency('logger') }
  get #progress() { return this.getDependency('progress') }

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    const sse = this.getDependency('sse')
    sse.addEventListener('job', (/** @type {MessageEvent} */ message) => this.#handleMessage(message))
    sse.addEventListener('jobsResync', () => { this.#relist() })
    sse.onConnectionChange((/** @type {boolean} */ connected) => { if (connected) this.#relist() })
  }

  /**
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    if (changedKeys.includes('user') || changedKeys.includes('sessionId')) await this.#sync()
  }

  async ready() {
    this.#appReady = true
    await this.#sync()
  }

  async shutdown() {
    this.#stop()
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * The job client of the logged-in session.
   * @returns {JobClient}
   */
  get client() {
    if (!this.#client) throw new Error('The job client is available only after login')
    return this.#client
  }

  /**
   * Submit a job; its progress widget appears with the first event.
   * @param {string} type
   * @param {*} params
   * @param {{resources?: string[], inputHash?: string, idempotencyKey?: string}} [options]
   * @returns {Promise<Job>}
   */
  submit(type, params, options) {
    return this.client.submit(type, params, options)
  }

  /**
   * Wait until a job is finished. The caller handles a failure; this plugin does not notify it.
   * @param {string} jobId
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<unknown>} The result of the job
   */
  wait(jobId, options) {
    this.#waited.add(jobId)
    return this.client.wait(jobId, options)
  }

  /**
   * Request cancellation of a job.
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  cancel(jobId) {
    return this.client.cancel(jobId)
  }

  /**
   * Run a client job (see {@link JobClient#runClientJob}). The caller handles a failure; this
   * plugin does not notify it.
   * @template T
   * @param {string} type
   * @param {*} params
   * @param {(run: JobRun) => Promise<T>} body
   * @param {{resources?: string[], inputHash?: string, jobId?: string}} [options]
   * @returns {Promise<T>}
   */
  runClientJob(type, params, body, options = {}) {
    if (options.jobId) this.#waited.add(options.jobId)
    return this.client.runClientJob(type, params, (run) => {
      this.#waited.add(run.job.id)
      return body(run)
    }, options)
  }

  // ── Session ──────────────────────────────────────────────────────────────

  /** Create, replace or remove the job client after login, logout or a session change. */
  async #sync() {
    if (!this.#appReady) return
    const { user, sessionId } = /** @type {ApplicationState} */ (this.state)
    if (this.#client && (!user || sessionId !== this.#sessionId)) this.#stop()
    if (user && sessionId && !this.#client) await this.#start(sessionId)
  }

  /** @param {string} sessionId */
  async #start(sessionId) {
    const client = new JobClient({
      api: this.getDependency('client').apiClient,
      feed: this.#feed,
      sessionStorage: window.sessionStorage
    })
    this.#client = client
    this.#sessionId = sessionId
    try {
      for (const info of await client.types()) this.#titles.set(info.name, info.title)
    } catch (error) {
      this.#logger.warn(`Could not load the job types: ${error}`)
    }
    if (this.#client !== client) return
    this.#unsubscribe = client.subscribe((event) => this.#handleEvent(event))
    await this.#relist()
    if (this.#client !== client) return
    testLog('JOBS_SUBSCRIBED')
    await this.#resumeClientJobs(client)
  }

  /** Stop listening and remove all job widgets. */
  #stop() {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    for (const jobId of this.#jobs.keys()) this.#progress.hide(`job-${jobId}`)
    this.#jobs.clear()
    this.#waited.clear()
    this.#finished.clear()
    this.#client = null
    this.#sessionId = null
  }

  // ── Events ───────────────────────────────────────────────────────────────

  /**
   * A `job` event of the SSE stream: pass it to the listeners of the feed.
   * @param {MessageEvent} message
   */
  #handleMessage(message) {
    /** @type {JobEvent} */
    let event
    try {
      event = JSON.parse(message.data)
    } catch {
      this.#logger.warn('Could not parse a job event')
      return
    }
    this.#emit(event)
  }

  /**
   * Pass an event to the listeners of the feed: the plugin's own listener and pending
   * {@link JobClient#wait} calls.
   * @param {JobEvent} event
   */
  #emit(event) {
    for (const listener of [...this.#feedListeners]) listener(event)
  }

  /**
   * Fetch the job states again after events may have been missed (login, reconnection of the SSE
   * stream, `jobsResync`): list the unfinished jobs of the user, fetch the jobs whose widgets are
   * no longer listed (they finished in the gap), and pass the states through the feed, so that
   * the widgets and pending {@link JobClient#wait} calls see them. Waited jobs of other users are
   * fetched by {@link JobClient#recheck}.
   */
  async #relist() {
    const client = this.#client
    if (!client) return
    client.recheck()
    /** @type {Job[]} */
    let jobs
    try {
      jobs = await client.list({ mine: true, status: UNFINISHED })
    } catch (error) {
      this.#logger.warn(`Could not list the jobs: ${error}`)
      return
    }
    if (this.#client !== client) return
    const listed = new Set(jobs.map(job => job.id))
    for (const job of jobs) this.#emit(this.#eventOf(job))
    for (const jobId of [...this.#jobs.keys()]) {
      if (listed.has(jobId)) continue
      try {
        const job = await client.get(jobId)
        if (this.#client === client) this.#emit(this.#eventOf(job))
      } catch (error) {
        this.#logger.warn(`Could not get job ${jobId}: ${error}`)
        if (/** @type {{statusCode?: number}} */ (error)?.statusCode === 404) this.#removeWidget(jobId)
      }
    }
  }

  /**
   * A job in the shape of an event of the stream.
   * @param {Job} job
   * @returns {JobEvent}
   */
  #eventOf(job) {
    return {
      id: null, seq: job.seq, job_id: job.id, type: job.type, status: job.status, progress: job.progress,
      message: job.message, data: job.data, result: job.result, error: job.error,
      cancel_requested: job.cancel_requested, at: job.updated_at, owner: job.owner
    }
  }

  // ── Widgets ──────────────────────────────────────────────────────────────

  /**
   * Update the widget of a job. Events older than the last one seen (from a list that crossed a
   * newer event) are ignored.
   * @param {JobEvent} event
   */
  #handleEvent(event) {
    const jobId = event.job_id
    const user = /** @type {ApplicationState} */ (this.state).user
    if (event.owner && event.owner !== user?.username) return
    const known = this.#jobs.get(jobId)
    if (known && known.seq > event.seq) return
    if (UNFINISHED.includes(event.status)) {
      if (this.#finished.has(jobId)) return
      this.#jobs.set(jobId, event)
      this.#render(event)
      return
    }
    if (this.#finished.has(jobId)) return
    this.#finished.add(jobId)
    this.#removeWidget(jobId)
    const waited = this.#waited.delete(jobId)
    if (event.status === 'error') {
      if (!waited) notify(event.error?.message ?? 'The job failed', 'danger', 'exclamation-octagon')
    } else if (!FINISHED_QUIETLY.includes(event.status)) {
      this.#logger.warn(`Unknown job status "${event.status}" of job ${jobId}`)
    }
  }

  /** @param {string} jobId */
  #removeWidget(jobId) {
    this.#jobs.delete(jobId)
    this.#progress.hide(`job-${jobId}`)
  }

  /** @param {JobEvent} event */
  #render(event) {
    const jobId = event.job_id
    this.#progress.show(`job-${jobId}`, {
      title: this.#titles.get(event.type) ?? event.type,
      label: event.cancel_requested ? 'Cancelling…' : this.#label(event),
      value: event.progress?.value ?? null,
      cancellable: !event.cancel_requested,
      onCancel: () => this.#handleCancel(jobId),
      minimized: event.data?.minimized === true
    })
  }

  /**
   * The progress of the job, or its message if it reports no progress.
   * @param {JobEvent} event
   * @returns {string}
   */
  #label(event) {
    const progress = event.progress
    const hasProgress = Boolean(progress && (progress.phase || progress.total))
    if (event.status !== 'queued' && !hasProgress && event.message) return event.message
    return formatJobProgress(/** @type {Job} */ (/** @type {unknown} */ (event)))
  }

  /**
   * The cancel button of a widget was clicked. The progress plugin removes the widget after this
   * call; it is shown again as "Cancelling…" until the job is finished.
   * @param {string} jobId
   */
  async #handleCancel(jobId) {
    try {
      await this.cancel(jobId)
    } catch (error) {
      this.#logger.warn(`Could not cancel job ${jobId}: ${error}`)
      return
    }
    const event = this.#jobs.get(jobId)
    if (event) {
      const cancelling = { ...event, cancel_requested: true }
      this.#jobs.set(jobId, cancelling)
      this.#render(cancelling)
    }
  }

  // ── Resume ───────────────────────────────────────────────────────────────

  /**
   * Resume the client jobs that a reload interrupted: those of this tab without asking, others
   * after asking the user; discarded jobs and jobs without a `jobs.resume` contribution are cancelled.
   * Active jobs that another tab drives are left alone.
   * @param {JobClient} client
   */
  async #resumeClientJobs(client) {
    /** @type {Job[]} */
    let jobs
    try {
      jobs = await client.list({ mine: true, resumable: true })
    } catch (error) {
      this.#logger.warn(`Could not list resumable jobs: ${error}`)
      return
    }
    if (jobs.length === 0) return
    const results = await this.context.invokePluginEndpoint(ep.jobs.resume, [], { result: 'values', throws: false })
    /** @type {JobResumeContribution[]} */
    const contributions = (Array.isArray(results) ? results : []).flat().filter(Boolean)

    for (const job of jobs) {
      if (this.#client !== client) return
      const contribution = contributions.find(c => c.type === job.type)
      if (!contribution) {
        this.#logger.info(`No plugin resumes jobs of type "${job.type}"; cancelling job ${job.id}`)
        await client.cancel(job.id).catch((error) => this.#logger.warn(`Could not cancel job ${job.id}: ${error}`))
        continue
      }
      const holder = job.lease?.holder ?? job.lease_holder ?? null
      if (holder === client.holder) {
        this.#resume(contribution, job)
        continue
      }
      if (job.status === 'active' && holder) continue
      const title = this.#titles.get(job.type) ?? job.type
      const resume = await this.getDependency('dialog').confirm(
        `The job "${title}" was interrupted. Confirm to resume it, or Cancel to discard it.`,
        'Resume job?'
      )
      if (this.#client !== client) return
      if (resume) {
        this.#resume(contribution, job)
      } else {
        await client.cancel(job.id).catch((error) => this.#logger.warn(`Could not cancel job ${job.id}: ${error}`))
      }
    }
  }

  /**
   * @param {JobResumeContribution} contribution
   * @param {Job} job
   */
  #resume(contribution, job) {
    this.#logger.info(`Resuming job ${job.id} of type "${job.type}"`)
    this.#waited.add(job.id)
    contribution.resume(job).catch((error) => {
      if (error instanceof JobCancelledError) return
      this.#logger.error(`Resuming job ${job.id} failed: ${error}`)
      notify(error instanceof Error ? error.message : String(error), 'danger', 'exclamation-octagon')
    })
  }
}

export default JobsPlugin

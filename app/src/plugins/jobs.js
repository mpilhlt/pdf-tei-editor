/**
 * Jobs plugin: the frontend of the job queue (`/api/v1/jobs`).
 *
 * Owns the {@link JobClient} of the logged-in session and shows every unfinished job of the user
 * as a progress widget (id `job-<job id>`), with a cancel button. Failed jobs are notified unless
 * this tab waits for them through {@link JobsPlugin#wait} or runs them through
 * {@link JobsPlugin#runClientJob}, in which case the caller reports the error. After a reload,
 * the event stream's snapshot re-creates the widgets, and interrupted client jobs are resumed
 * through the `jobs.resume` extension point. See docs/code-assistant/jobs.md.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { Job, JobEvent } from '../modules/api-client-v1.js'
 * @import { JobRun } from '../modules/job-client.js'
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

  /** @type {Set<string>} Jobs whose errors a caller in this tab reports */
  #waited = new Set()

  #appReady = false

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'jobs', deps: ['client', 'progress', 'logger', 'dialog'] })
  }

  get #logger() { return this.getDependency('logger') }
  get #progress() { return this.getDependency('progress') }

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
      eventSourceFactory: (url) => new EventSource(url),
      sessionStorage: window.sessionStorage,
      eventsUrl: `/api/v1/jobs/events?mine=true&sessionId=${encodeURIComponent(sessionId)}`
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
    this.#client = null
    this.#sessionId = null
  }

  // ── Widgets ──────────────────────────────────────────────────────────────

  /** @param {JobEvent} event */
  #handleEvent(event) {
    const jobId = event.job_id
    if (UNFINISHED.includes(event.status)) {
      this.#jobs.set(jobId, event)
      this.#render(event)
      return
    }
    this.#jobs.delete(jobId)
    this.#progress.hide(`job-${jobId}`)
    const waited = this.#waited.delete(jobId)
    if (event.status === 'error') {
      if (!waited) notify(event.error?.message ?? 'The job failed', 'danger', 'exclamation-octagon')
    } else if (!FINISHED_QUIETLY.includes(event.status)) {
      this.#logger.warn(`Unknown job status "${event.status}" of job ${jobId}`)
    }
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

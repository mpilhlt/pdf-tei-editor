/**
 * Coordination of the browser tabs of a user that drive client jobs (see {@link JobClient#runClientJob}).
 *
 * The lease holder id of a tab lives in session storage, which "Duplicate tab" copies. Without
 * coordination, a duplicated tab would take the holder id of the original, find the active
 * client job of the original as its own and drive it a second time. Over a BroadcastChannel the
 * tabs therefore answer two questions:
 *
 * - "Does a live tab use this holder id?" A tab whose stored holder id another tab answers for
 *   takes a fresh one ({@link JobTabChannel#ensureOwnHolder}).
 * - "Does a live tab drive this job?" An active job of the tab's own holder is resumed only if no
 *   tab answers within the timeout ({@link JobTabChannel#isDriven}); after a reload, no tab does.
 *
 * Has no plugin imports. See docs/code-assistant/jobs.md.
 *
 * @import { Job } from './api-client-v1.js'
 */

const HOLDER_KEY = 'job-holder'
const DEFAULT_TIMEOUT = 500

/**
 * The part of a BroadcastChannel that the tab channel uses.
 * @typedef {Object} TabChannelPort
 * @property {(message: TabMessage) => void} postMessage
 * @property {((event: {data: TabMessage}) => void) | null} onmessage
 * @property {() => void} close
 */

/**
 * A message between tabs.
 * @typedef {Object} TabMessage
 * @property {'ping-job'|'pong-job'|'ping-holder'|'pong-holder'} kind
 * @property {string} nonce - Pairs an answer with its question
 * @property {string} [jobId] - For `ping-job`
 * @property {string} [holder] - For `ping-holder`
 */

/**
 * What to do with a resumable client job of the user after login.
 * - `resume`: resume it without asking (this tab's interrupted job, or its active job that no live tab drives)
 * - `confirm`: ask the user (an interrupted job of another tab)
 * - `skip`: leave it alone (an active job that another live tab drives)
 * @typedef {'resume'|'confirm'|'skip'} ResumeAction
 */

export class JobTabChannel {
  /** @type {TabChannelPort|null} */
  #port
  #storage
  #timeout
  /** @type {Map<string, number>} Jobs that this tab drives, with the number of runs */
  #driving = new Map()
  /** @type {Map<string, () => void>} Nonce -> callback of a pending question */
  #pending = new Map()

  /**
   * @param {Object} options
   * @param {TabChannelPort|null} options.port - E.g. `new BroadcastChannel('pte-jobs')`; without it (no BroadcastChannel support) no tab ever answers
   * @param {Pick<Storage, 'getItem' | 'setItem'>} options.sessionStorage - The storage that holds the holder id (shared with {@link JobClient})
   * @param {number} [options.timeout] - Milliseconds to wait for an answer (default 500)
   */
  constructor({ port, sessionStorage, timeout = DEFAULT_TIMEOUT }) {
    this.#port = port
    this.#storage = sessionStorage
    this.#timeout = timeout
    if (port) port.onmessage = (event) => this.#handle(event.data)
  }

  /**
   * Mark a job as driven by this tab until the returned function is called.
   * @param {string} jobId
   * @returns {() => void} Ends the mark
   */
  drive(jobId) {
    this.#driving.set(jobId, (this.#driving.get(jobId) ?? 0) + 1)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const count = (this.#driving.get(jobId) ?? 1) - 1
      if (count > 0) this.#driving.set(jobId, count)
      else this.#driving.delete(jobId)
    }
  }

  /**
   * Whether another live tab drives the job.
   * @param {string} jobId
   * @returns {Promise<boolean>}
   */
  isDriven(jobId) {
    return this.#ask({ kind: 'ping-job', jobId, nonce: crypto.randomUUID() })
  }

  /**
   * Make sure that the stored holder id is not used by another live tab (a duplicated tab copies
   * it); if it is, store a fresh one. Call before the job client claims jobs.
   * @returns {Promise<boolean>} Whether a fresh holder id was stored
   */
  async ensureOwnHolder() {
    const holder = this.#storage.getItem(HOLDER_KEY)
    if (!holder) return false
    if (!(await this.#ask({ kind: 'ping-holder', holder, nonce: crypto.randomUUID() }))) return false
    if (this.#storage.getItem(HOLDER_KEY) !== holder) return false
    this.#storage.setItem(HOLDER_KEY, crypto.randomUUID())
    return true
  }

  /** Stop answering and close the channel. */
  close() {
    this.#port?.close()
    this.#port = null
    for (const answer of this.#pending.values()) answer()
    this.#pending.clear()
  }

  /**
   * Post a question and resolve whether an answer arrived within the timeout.
   * @param {TabMessage} message
   * @returns {Promise<boolean>}
   */
  #ask(message) {
    const port = this.#port
    if (!port) return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(message.nonce)
        resolve(false)
      }, this.#timeout)
      this.#pending.set(message.nonce, () => {
        clearTimeout(timer)
        this.#pending.delete(message.nonce)
        resolve(true)
      })
      port.postMessage(message)
    })
  }

  /** @param {TabMessage} message */
  #handle(message) {
    if (!message || typeof message !== 'object') return
    switch (message.kind) {
      case 'ping-job':
        if (message.jobId && this.#driving.has(message.jobId)) this.#port?.postMessage({ kind: 'pong-job', nonce: message.nonce })
        break
      case 'ping-holder':
        if (message.holder && message.holder === this.#storage.getItem(HOLDER_KEY)) this.#port?.postMessage({ kind: 'pong-holder', nonce: message.nonce })
        break
      case 'pong-job':
      case 'pong-holder':
        this.#pending.get(message.nonce)?.()
        break
    }
  }
}

/**
 * Decide what to do with a resumable client job of the user after login.
 * @param {Pick<Job, 'id'|'status'|'lease'|'lease_holder'>} job
 * @param {string} ownHolder - The holder id of this tab
 * @param {Pick<JobTabChannel, 'isDriven'>} tabs
 * @returns {Promise<ResumeAction>}
 */
export async function resumeAction(job, ownHolder, tabs) {
  const holder = job.lease?.holder ?? job.lease_holder ?? null
  if (job.status === 'active' && holder) {
    if (holder !== ownHolder) return 'skip'
    // this tab's holder id may be a copy (duplicated tab), so ask whether a live tab drives the job
    return (await tabs.isDriven(job.id)) ? 'skip' : 'resume'
  }
  return holder === ownHolder ? 'resume' : 'confirm'
}

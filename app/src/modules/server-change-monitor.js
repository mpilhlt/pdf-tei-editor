/**
 * Reloads the page when the server changed in a way the loaded frontend depends on: a backup
 * was restored, or the plugins were changed. After the reload, a message says why.
 *
 * The server reports its state at `GET /api/v1/maintenance/status`. The monitor remembers the
 * state at page load and checks it again whenever asked to (on SSE `serverChanged` events and
 * whenever the SSE connection opens or is lost, which happens when the server replaces its
 * workers). This works across worker processes and also when the restore invalidated the
 * session, because the status needs no authentication.
 *
 * @import { MaintenanceStatus } from './api-client-v1.js'
 */

/** sessionStorage key of the message to show after the reload */
export const NOTICE_KEY = 'pte-server-change-notice'

export const RESTORE_MESSAGE = 'The application data has been restored from a backup. If you have been logged out, log in with an account that exists in the backup.'
export const PLUGINS_MESSAGE = 'The plugins have been changed by an administrator, so the page has been reloaded.'

/**
 * @typedef {Object} ServerChangeMonitorOptions
 * @property {() => Promise<MaintenanceStatus>} fetchStatus - Requests the server status
 * @property {() => void} reload - Reloads the page
 * @property {Pick<Storage, 'getItem'|'setItem'|'removeItem'>|null} storage - Keeps the message across the reload
 * @property {{ debug: (msg: string) => void, info: (msg: string) => void }} logger
 */

export class ServerChangeMonitor {
  /** @type {ServerChangeMonitorOptions} */
  #options
  /** @type {MaintenanceStatus|null} */
  #baseline = null
  /** @type {Promise<void>|null} */
  #pending = null
  #reloading = false
  #held = false

  /** @param {ServerChangeMonitorOptions} options */
  constructor(options) {
    this.#options = options
  }

  /**
   * Remembers the current server state and returns the message left by the reload that led to
   * this page load, if any.
   * @returns {Promise<string|null>}
   */
  async init() {
    let notice = null
    try {
      notice = this.#options.storage?.getItem(NOTICE_KEY) ?? null
      this.#options.storage?.removeItem(NOTICE_KEY)
    } catch {
      // storage can be unavailable (private mode, blocked site data)
    }
    await this.check()
    return notice
  }

  /**
   * Postpones reloading, e.g. while an administrator works in the plugin manager. Releasing
   * the hold checks again and reloads if the server changed in the meantime.
   * @param {boolean} held
   * @returns {Promise<void>}
   */
  hold(held) {
    this.#held = held
    return held ? Promise.resolve() : this.check()
  }

  /**
   * Compares the server state with the remembered one and reloads the page if it changed.
   * Concurrent calls share one request.
   * @returns {Promise<void>}
   */
  check() {
    if (!this.#pending) {
      this.#pending = this.#check().finally(() => { this.#pending = null })
    }
    return this.#pending
  }

  async #check() {
    if (this.#reloading) return
    let status
    try {
      status = await this.#options.fetchStatus()
    } catch (error) {
      this.#options.logger.debug(`Server status not available: ${error}`)
      return
    }
    if (!this.#baseline) {
      this.#baseline = status
      return
    }
    const message = changeMessage(this.#baseline, status)
    if (message && this.#held) return
    if (status.plugins_version !== null) {
      this.#baseline = { ...this.#baseline, plugins_version: status.plugins_version }
    }
    if (!message) return
    this.#options.logger.info(`Server changed, reloading: ${message}`)
    this.#reloading = true
    try {
      this.#options.storage?.setItem(NOTICE_KEY, message)
    } catch {
      // the reload happens anyway, without the message
    }
    this.#options.reload()
  }
}

/**
 * The message for a change of the server state, or null if nothing relevant changed.
 * A `plugins_version` of null (workers still restarting) is not a change.
 * @param {MaintenanceStatus} before
 * @param {MaintenanceStatus} after
 * @returns {string|null}
 */
export function changeMessage(before, after) {
  if ((after.data_restore?.id ?? null) !== (before.data_restore?.id ?? null)) {
    return RESTORE_MESSAGE
  }
  if (after.plugins_version !== null && before.plugins_version !== after.plugins_version) {
    return PLUGINS_MESSAGE
  }
  return null
}

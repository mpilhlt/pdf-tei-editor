/**
 * Server-Sent Events (SSE) connection management
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { notify } from '../modules/sl-utils.js'

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_INTERVAL = 2000
const MAX_RECONNECT_DELAY = 30000

class SsePlugin extends Plugin {
  /** @type {EventSource|null} */
  #eventSource = null

  /** @type {string|null} */
  #cachedSessionId = null

  /** @type {Record<string, ((event: MessageEvent) => void)[]>} */
  #registeredListeners = {}

  /** @type {ReturnType<typeof setTimeout>|null} */
  #reconnectTimeout = null

  #reconnectAttempts = 0

  /** Track if app startup is complete */
  #appStarted = false

  /** Set during page unload to suppress reconnection */
  #isUnloading = false

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'sse' })
  }

  async install(state) {
    await super.install(state)
    window.addEventListener('beforeunload', () => {
      this.#isUnloading = true
      this.#cleanupConnection()
    }, { once: true })
  }

  async onStateUpdate(changedKeys) {
    if (!changedKeys.includes('user') && !changedKeys.includes('sessionId')) return

    const { user, sessionId } = this.state

    if (this.#eventSource && (sessionId !== this.#cachedSessionId || !user)) {
      this.getDependency('logger').debug('Closing SSE connection due to session change or logout.')
      this.#cleanupConnection()
    }

    if (user && sessionId && !this.#eventSource && this.#appStarted) {
      this.#establishConnection(sessionId)
    }
  }

  async ready() {
    const sseEnabled = await this.getDependency('config').get('sse.enabled')
    this.#appStarted = true
    if (sseEnabled === false) {
      this.getDependency('logger').debug('SSE is disabled.')
      return
    }
    if (!this.#eventSource && this.state.sessionId) {
      this.getDependency('logger').debug('App ready, SSE is connecting...')
      this.#establishConnection(this.state.sessionId)
    }
  }

  async shutdown() {
    this.#isUnloading = true
    this.#cleanupConnection()
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** @param {string} sessionId */
  #establishConnection(sessionId) {
    const url = `/api/v1/sse/subscribe?sessionId=${sessionId}`
    this.#eventSource = new EventSource(url)
    this.#cachedSessionId = sessionId

    this.#eventSource.onopen = () => {
      this.#reconnectAttempts = 0
      if (this.#reconnectTimeout) {
        clearTimeout(this.#reconnectTimeout)
        this.#reconnectTimeout = null
      }
    }

    // Re-add all registered listeners to the new EventSource
    for (const [type, listeners] of Object.entries(this.#registeredListeners)) {
      for (const listener of listeners) {
        this.#eventSource.addEventListener(type, listener)
      }
    }

    this.#eventSource.onerror = (_event) => {
      if (this.#isUnloading) return

      const readyState = this.#eventSource ? this.#eventSource.readyState : 'unknown'
      const errorMsg = `EventSource failed (readyState: ${readyState})`
      const logger = this.getDependency('logger')

      if (readyState === EventSource.CONNECTING) {
        logger.warn(`${errorMsg} - Connection attempt failed`)
      } else if (readyState === EventSource.CLOSED) {
        logger.warn(`${errorMsg} - Connection was closed`)
      } else {
        logger.error(`${errorMsg} - Unexpected error`)
      }

      if (this.#eventSource) {
        this.#eventSource.close()
        this.#eventSource = null
      }

      if (this.#reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(RECONNECT_INTERVAL * Math.pow(2, this.#reconnectAttempts), MAX_RECONNECT_DELAY)
        this.#reconnectAttempts++
        logger.log(`Attempting to reconnect in ${delay}ms (attempt ${this.#reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
        this.#reconnectTimeout = setTimeout(() => {
          if (this.#cachedSessionId) this.#establishConnection(this.#cachedSessionId)
        }, delay)
      } else {
        logger.error(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded. SSE connection abandoned.`)
        this.#cachedSessionId = null
        this.#reconnectAttempts = 0
      }
    }

    this.#eventSource.addEventListener('updateStatus', (evt) => {
      this.getDependency('logger').log('SSE Status Update:' + evt.data)
    })

    this.#eventSource.addEventListener('notification', (evt) => {
      try {
        const { message, variant, icon } = JSON.parse(evt.data)
        notify(message, variant === 'error' ? 'danger' : variant, icon)
      } catch (e) {
        this.getDependency('logger').warn(`Failed to parse notification event: ${e}`)
      }
    })
  }

  #cleanupConnection() {
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout)
      this.#reconnectTimeout = null
    }
    if (this.#eventSource) {
      this.#eventSource.close()
      this.#eventSource = null
    }
    this.#cachedSessionId = null
    this.#reconnectAttempts = 0
    this.getDependency('logger').debug('SSE connection cleaned up')
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * @param {string} type
   * @param {(event: MessageEvent) => void} listener
   */
  addEventListener(type, listener) {
    if (!this.#registeredListeners[type]) this.#registeredListeners[type] = []
    this.#registeredListeners[type].push(listener)
    if (this.#eventSource) this.#eventSource.addEventListener(type, listener)
  }

  /**
   * @param {string} type
   * @param {(event: MessageEvent) => void} listener
   */
  removeEventListener(type, listener) {
    if (this.#registeredListeners[type]) {
      this.#registeredListeners[type] = this.#registeredListeners[type].filter(l => l !== listener)
      if (this.#registeredListeners[type].length === 0) delete this.#registeredListeners[type]
    }
    if (this.#eventSource) this.#eventSource.removeEventListener(type, listener)
  }

  get readyState() {
    return this.#eventSource ? this.#eventSource.readyState : EventSource.CLOSED
  }

  get url() {
    return this.#eventSource ? this.#eventSource.url : null
  }

  get reconnectAttempts() {
    return this.#reconnectAttempts
  }

  reconnect() {
    if (this.#cachedSessionId) {
      this.getDependency('logger').info('Manual reconnection requested')
      this.#cleanupConnection()
      this.#establishConnection(this.#cachedSessionId)
    } else {
      this.getDependency('logger').warn('Cannot reconnect: no cached session ID')
    }
  }
}

export default SsePlugin

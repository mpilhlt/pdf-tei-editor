/**
 * Heartbeat plugin for file locking and offline detection
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import ui from '../ui.js'
import { notify } from '../modules/sl-utils.js'
import { Plugin } from '../modules/plugin-base.js'

class HeartbeatPlugin extends Plugin {
  /** @type {ReturnType<typeof setInterval>|null} */
  #heartbeatInterval = null

  #lockTimeoutSeconds = 60

  /** @type {boolean|undefined} */
  #editorReadOnlyState

  /** Tracks whether the heartbeat detected a client→server connection loss (independent of state.offline) */
  #isConnectionLost = false

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'heartbeat', deps: ['logger', 'client', 'dialog', 'authentication'] })
  }

  async install(state) {
    await super.install(state)
  }

  /**
   * Starts the heartbeat mechanism.
   * @param {any} [_state] - Ignored; present for backward compatibility
   * @param {number} [timeoutSeconds=60]
   */
  start(_state, timeoutSeconds = 60) {
    if (!Number.isInteger(timeoutSeconds)) {
      throw new Error(`Invalid timeout value: ${timeoutSeconds}`)
    }

    const logger = this.getDependency('logger')

    if (this.#heartbeatInterval) {
      logger.debug('Heartbeat already running, stopping previous instance')
      this.stop()
    }

    this.#lockTimeoutSeconds = timeoutSeconds
    logger.debug(`Starting heartbeat with ${this.#lockTimeoutSeconds} second interval`)

    const heartbeatFrequency = this.#lockTimeoutSeconds * 1000

    window.addEventListener('beforeunload', () => this.stop())

    this.#heartbeatInterval = setInterval(async () => {
      if (!this.state) {
        logger.debug('Skipping heartbeat: no current state available')
        return
      }

      const filePath = String(ui.toolbar.xml.value)
      const reasonsToSkip = {
        'Maintenance mode is active': this.state.maintenanceMode,
        'No user is logged in': this.state.user === null,
        'No file path specified': !filePath
      }

      for (const reason in reasonsToSkip) {
        if (reasonsToSkip[reason]) {
          logger.debug(`Skipping heartbeat: ${reason}.`)
          return
        }
      }

      const client = this.getDependency('client')
      const dialog = this.getDependency('dialog')
      const authentication = this.getDependency('authentication')

      try {
        if (this.state.editorReadOnly && !this.#isConnectionLost) {
          logger.debug(`Read-only mode: skipping heartbeat for ${filePath}`)
          return
        }
        logger.debug(`Sending heartbeat to server${this.#isConnectionLost ? ' (connectivity probe)' : ''} for ${filePath}`)
        await client.sendHeartbeat(filePath)

        if (this.#isConnectionLost) {
          this.#isConnectionLost = false
          logger.info('Connection restored.')
          notify('Connection restored.')
          await this.dispatchStateChange({ connectionLost: false, editorReadOnly: this.#editorReadOnlyState })
        }
      } catch (error) {
        console.warn('Error during heartbeat:', error.name, String(error), error.statusCode)
        if (error instanceof TypeError) {
          if (this.#isConnectionLost) {
            const message = `Still unreachable, will try again in ${this.#lockTimeoutSeconds} seconds ...`
            logger.warn(message)
            notify(message)
            return
          }
          logger.warn('Connection to backend lost.')
          notify(`Connection to the server was lost. Will retry in ${this.#lockTimeoutSeconds} seconds.`, 'warning')
          this.#isConnectionLost = true
          this.#editorReadOnlyState = this.state.editorReadOnly
          await this.dispatchStateChange({ connectionLost: true, editorReadOnly: true })
        } else if (error.statusCode === 409 || error.statusCode === 423) {
          if (this.#isConnectionLost) {
            this.#isConnectionLost = false
            logger.info('Connection restored (lock expired during outage).')
            notify('Connection restored.')
            await this.dispatchStateChange({ connectionLost: false, editorReadOnly: this.#editorReadOnlyState })
            return
          }
          const currentReadOnlyState = this.state?.editorReadOnly || false
          if (!currentReadOnlyState) {
            logger.critical('Lock lost for file: ' + filePath)
            dialog.error('Your file lock has expired or was taken by another user. To prevent data loss, please save your work to a new file. Further saving to the original file is disabled.')
            await this.dispatchStateChange({ editorReadOnly: true })
          } else {
            logger.debug(`Heartbeat received lock conflict for read-only file ${filePath} (expected, not showing error)`)
          }
        } else if (error.statusCode === 404) {
          logger.debug(`Heartbeat file not found (${filePath}), skipping. File may have been deleted.`)
          return
        } else if (error.statusCode === 504) {
          logger.warn('Temporary connection failure, will try again...')
        } else if (error.statusCode === 403) {
          notify('You have been logged out')
          authentication.logout()
        } else {
          logger.error('An unexpected server error occurred during heartbeat.', error)
        }
      }
    }, heartbeatFrequency)

    logger.info('Heartbeat started.')
  }

  /**
   * Stops the heartbeat mechanism.
   */
  stop() {
    const logger = this.getDependency('logger')
    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval)
      this.#heartbeatInterval = null
      logger.debug('Heartbeat stopped.')
    }

    const filePath = ui.toolbar.xml.value
    if (filePath) {
      this.getDependency('client').releaseLock(filePath).catch(() => {})
    }
  }
}

export default HeartbeatPlugin

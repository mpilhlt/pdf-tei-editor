/**
 * Progress Widget Plugin
 *
 * Provides a modal progress indicator widget for long-running server processes,
 * controlled via SSE (Server-Sent Events).
 *
 * ## SSE Event Types
 *
 * The widget listens for the following SSE event types:
 *
 * ### `progressShow`
 * Shows the progress widget. Data is optional JSON with initial settings:
 * ```json
 * {"label": "Processing...", "value": null, "cancellable": true}
 * ```
 * - `label` (string, optional): Initial text label
 * - `value` (number|null, optional): Initial progress value (0-100), null for indeterminate
 * - `cancellable` (boolean, optional): Whether to show cancel button (default: true)
 *
 * ### `progressValue`
 * Sets the progress value. Data is either:
 * - A number (0-100) for determinate progress
 * - "null" or empty string for indeterminate progress
 *
 * ### `progressLabel`
 * Sets the text label. Data is the label string.
 *
 * ### `progressHide`
 * Hides the progress widget. No data required.
 *
 * ## Cancel Callback
 *
 * When the user clicks the cancel button, a `progressCancel` event is sent
 * to the server via POST to `/api/v1/sse/send`. Backend code can listen for
 * this event type to handle cancellation.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlIconButton, SlProgressBar } from '../ui.js'
 */

import { registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js'
import ui from '../ui.js'
import { logger, sse, client } from '../app.js'

/**
 * Plugin API
 */
const api = {
  show,
  hide,
  setValue,
  setLabel,
  isVisible
}

/**
 * Plugin object
 */
const plugin = {
  name: 'progress',
  deps: ['sse'],
  install
}

export { api, plugin }
export default plugin

//
// UI typedef for ui.js
//

/**
 * Progress widget navigation properties
 * @typedef {object} progressWidgetPart
 * @property {SlProgressBar} progressBar - The progress bar component
 * @property {SlIconButton} cancelBtn - Cancel button
 * @property {SlIconButton} minimizeBtn - Minimize button
 * @property {SlIconButton} maximizeBtn - Maximize button (hidden when not minimized)
 * @property {HTMLDivElement} labelRow - Label text container
 */

//
// State
//

const MINIMIZED_STORAGE_KEY = 'progress-widget-minimized'

/** @type {string|null} */
let currentSessionId = null

/**
 * Get minimized state from session storage
 * @returns {boolean}
 */
function getMinimizedState() {
  return sessionStorage.getItem(MINIMIZED_STORAGE_KEY) === 'true'
}

/**
 * Save minimized state to session storage
 * @param {boolean} minimized
 */
function setMinimizedState(minimized) {
  sessionStorage.setItem(MINIMIZED_STORAGE_KEY, String(minimized))
}

//
// Implementation
//

// Register template at module level
await registerTemplate('progress-template', 'progress.html')

/**
 * Install the progress plugin
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  currentSessionId = state.sessionId

  // Create the progress widget element
  createSingleFromTemplate('progress-template', document.body)
  updateUi()

  // Set up button event handlers
  ui.progressWidget.cancelBtn.addEventListener('click', handleCancel)
  ui.progressWidget.minimizeBtn.addEventListener('click', handleMinimize)
  ui.progressWidget.maximizeBtn.addEventListener('click', handleMaximize)

  // Set up SSE listeners
  sse.addEventListener('progressShow', handleProgressShow)
  sse.addEventListener('progressValue', handleProgressValue)
  sse.addEventListener('progressLabel', handleProgressLabel)
  sse.addEventListener('progressHide', handleProgressHide)
}

/**
 * Handle cancel button click
 */
async function handleCancel() {
  logger.debug('Progress cancel requested')

  // Send cancel event to server if we have a session
  if (currentSessionId) {
    try {
      await client.request('POST', '/api/v1/sse/send', {
        session_id: currentSessionId,
        event_type: 'progressCancel',
        data: ''
      })
    } catch (err) {
      logger.warn(`Failed to send cancel event: ${err}`)
    }
  }

  hide()
}

/**
 * Handle minimize button click
 */
function handleMinimize() {
  setMinimizedState(true)
  applyMinimizedState(true)
}

/**
 * Handle maximize button click
 */
function handleMaximize() {
  setMinimizedState(false)
  applyMinimizedState(false)
}

/**
 * Apply the minimized/maximized visual state
 * @param {boolean} minimized
 */
function applyMinimizedState(minimized) {
  if (minimized) {
    ui.progressWidget.classList.add('minimized')
    ui.progressWidget.minimizeBtn.style.display = 'none'
    ui.progressWidget.maximizeBtn.style.display = ''
  } else {
    ui.progressWidget.classList.remove('minimized')
    ui.progressWidget.minimizeBtn.style.display = ''
    ui.progressWidget.maximizeBtn.style.display = 'none'
  }
}

/**
 * Handle progressShow SSE event
 * @param {MessageEvent} event
 */
function handleProgressShow(event) {
  let options = {}
  if (event.data) {
    try {
      options = JSON.parse(event.data)
    } catch {
      // Data might be empty or not JSON
    }
  }
  show(options)
}

/**
 * Handle progressValue SSE event
 * @param {MessageEvent} event
 */
function handleProgressValue(event) {
  const data = event.data
  if (data === 'null' || data === '' || data === null) {
    setValue(null)
  } else {
    const value = parseInt(data, 10)
    if (!isNaN(value)) {
      setValue(value)
    }
  }
}

/**
 * Handle progressLabel SSE event
 * @param {MessageEvent} event
 */
function handleProgressLabel(event) {
  setLabel(event.data)
}

/**
 * Handle progressHide SSE event
 * @param {MessageEvent} _event
 */
function handleProgressHide(_event) {
  hide()
}

//
// Public API
//

/**
 * Show the progress widget
 * @param {object} [options]
 * @param {string} [options.label] - Initial label text
 * @param {number|null} [options.value] - Initial value (null for indeterminate)
 * @param {boolean} [options.cancellable=true] - Whether to show cancel button
 */
function show(options = {}) {
  const { label = '', value = null, cancellable = true } = options

  // Restore minimized state from session storage
  const minimized = getMinimizedState()
  applyMinimizedState(minimized)

  // Set initial values
  setValue(value)
  setLabel(label)

  // Show/hide cancel button
  ui.progressWidget.cancelBtn.style.display = cancellable ? '' : 'none'

  // Show widget
  ui.progressWidget.style.display = ''
}

/**
 * Hide the progress widget
 */
function hide() {
  ui.progressWidget.style.display = 'none'
}

/**
 * Set the progress value
 * @param {number|null} value - Progress value (0-100), null for indeterminate
 */
function setValue(value) {
  if (value === null) {
    ui.progressWidget.progressBar.indeterminate = true
  } else {
    ui.progressWidget.progressBar.indeterminate = false
    ui.progressWidget.progressBar.value = value
  }
}

/**
 * Set the label text
 * @param {string} label
 */
function setLabel(label) {
  ui.progressWidget.labelRow.textContent = label
}

/**
 * Check if the progress widget is visible
 * @returns {boolean}
 */
function isVisible() {
  return ui.progressWidget.style.display !== 'none'
}

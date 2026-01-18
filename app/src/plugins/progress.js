/**
 * Progress Widget Plugin (Multi-Instance)
 *
 * Provides progress indicator widgets for long-running server processes,
 * controlled via SSE (Server-Sent Events). Supports multiple simultaneous
 * progress widgets, each identified by a unique progress_id.
 *
 * ## SSE Event Types
 *
 * All events include a `progress_id` field to identify the target widget.
 *
 * ### `progressShow`
 * Shows or creates a progress widget. Data is JSON:
 * ```json
 * {"progress_id": "abc123", "label": "Processing...", "value": null, "cancellable": true, "cancelUrl": "/api/plugins/grobid/cancel/abc123"}
 * ```
 * - `progress_id` (string, required): Unique identifier for this progress instance
 * - `label` (string, optional): Initial text label
 * - `value` (number|null, optional): Initial progress value (0-100), null for indeterminate
 * - `cancellable` (boolean, optional): Whether to show cancel button (default: true)
 * - `cancelUrl` (string, optional): URL to POST to when cancel button is clicked
 *
 * ### `progressValue`
 * Sets the progress value. Data is JSON:
 * ```json
 * {"progress_id": "abc123", "value": 50}
 * ```
 *
 * ### `progressLabel`
 * Sets the text label. Data is JSON:
 * ```json
 * {"progress_id": "abc123", "label": "Step 2/5..."}
 * ```
 *
 * ### `progressHide`
 * Hides and removes a progress widget. Data is JSON:
 * ```json
 * {"progress_id": "abc123"}
 * ```
 *
 * ## Cancel Callback
 *
 * When the user clicks the cancel button, a POST request is sent to the
 * `cancelUrl` provided in the progressShow event. The backend route that
 * created the progress widget should implement this endpoint.
 *
 * ## Widget Behavior
 *
 * - Click on widget toggles between minimized/maximized states
 * - Multiple widgets stack vertically (bottom-left when minimized, centered when maximized)
 * - Widget state (minimized) is stored per progress_id in session storage
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlIconButton, SlProgressBar } from '../ui.js'
 */

import { registerTemplate, createFromTemplate } from '../ui.js'
import { logger, sse, client } from '../app.js'

/**
 * Plugin API - operates on specific progress_id instances
 */
const api = {
  show,
  hide,
  setValue,
  setLabel,
  isVisible,
  getActiveWidgets
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
// State
//

/** @type {Map<string, HTMLElement>} Map of progress_id -> widget element */
const activeWidgets = new Map()

/** @type {Map<string, string>} Map of progress_id -> cancel URL */
const cancelUrls = new Map()

/** @type {HTMLTemplateElement|null} */
let widgetTemplate = null

/** @type {string} */
let currentSessionId = null

/**
 * Get minimized state from session storage for a specific widget
 * @param {string} progressId
 * @returns {boolean}
 */
function getMinimizedState(progressId) {
  return sessionStorage.getItem(`progress-widget-minimized-${progressId}`) === 'true'
}

/**
 * Save minimized state to session storage for a specific widget
 * @param {string} progressId
 * @param {boolean} minimized
 */
function setMinimizedState(progressId, minimized) {
  sessionStorage.setItem(`progress-widget-minimized-${progressId}`, String(minimized))
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

  // Get the template element
  createFromTemplate("progress-template", document.body)
  widgetTemplate = document.getElementById('progress-widget-template')
  if (!widgetTemplate) {
    logger.error('Progress widget template not found')
    return
  }

  // Set up SSE listeners
  sse.addEventListener('progressShow', handleProgressShow)
  sse.addEventListener('progressValue', handleProgressValue)
  sse.addEventListener('progressLabel', handleProgressLabel)
  sse.addEventListener('progressHide', handleProgressHide)
}

/**
 * Create a new widget instance from template
 * @param {string} progressId
 * @returns {HTMLElement}
 */
function createWidgetInstance(progressId) {
  if (!widgetTemplate) {
    throw new Error('Progress widget template not loaded')
  }

  // Clone the template content
  const content = widgetTemplate.content.cloneNode(true)
  const widget = /** @type {HTMLElement} */ (content.querySelector('.progress-widget'))

  // Set the progress ID
  widget.dataset.progressId = progressId

  // Get elements within the widget
  const progressBar = /** @type {SlProgressBar} */ (widget.querySelector('[name="progressBar"]'))
  const cancelBtn = /** @type {SlIconButton} */ (widget.querySelector('[data-name="cancelBtn"]'))
  const labelRow = /** @type {HTMLDivElement} */ (widget.querySelector('[name="labelRow"]'))

  // Store element references on the widget for easy access
  widget._progressBar = progressBar
  widget._cancelBtn = cancelBtn
  widget._labelRow = labelRow

  // Set up click handler for toggle minimize/maximize
  widget.addEventListener('click', (e) => {
    // Don't toggle if clicking on buttons
    if (e.target === cancelBtn || cancelBtn.contains(/** @type {Node} */ (e.target))) {
      return
    }
    toggleMinimized(progressId)
  })

  // Set up cancel button handler
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    handleCancel(progressId)
  })

  // Add to DOM
  document.body.appendChild(widget)

  // Store in map
  activeWidgets.set(progressId, widget)

  // Update stacking indices
  updateStackIndices()

  return widget
}

/**
 * Get or create widget for a progress ID
 * @param {string} progressId
 * @returns {HTMLElement}
 */
function getOrCreateWidget(progressId) {
  let widget = activeWidgets.get(progressId)
  if (!widget) {
    widget = createWidgetInstance(progressId)
  }
  return widget
}

/**
 * Remove a widget from the DOM
 * @param {string} progressId
 */
function removeWidget(progressId) {
  const widget = activeWidgets.get(progressId)
  if (widget) {
    widget.remove()
    activeWidgets.delete(progressId)
    cancelUrls.delete(progressId)
    updateStackIndices()
  }
}

/**
 * Update stack indices for all active widgets
 */
function updateStackIndices() {
  let index = 0
  for (const [, widget] of activeWidgets) {
    widget.dataset.stackIndex = String(index)
    index++
  }
}

/**
 * Toggle minimized state for a widget
 * @param {string} progressId
 */
function toggleMinimized(progressId) {
  const widget = activeWidgets.get(progressId)
  if (!widget) return

  const isMinimized = widget.classList.contains('minimized')
  setMinimizedState(progressId, !isMinimized)
  applyMinimizedState(widget, !isMinimized)
}

/**
 * Apply the minimized/maximized visual state to a widget
 * @param {HTMLElement} widget
 * @param {boolean} minimized
 */
function applyMinimizedState(widget, minimized) {
  if (minimized) {
    widget.classList.remove('maximized')
    widget.classList.add('minimized')
  } else {
    widget.classList.remove('minimized')
    widget.classList.add('maximized')
  }
}

/**
 * Handle cancel button click for a specific widget
 * @param {string} progressId
 */
async function handleCancel(progressId) {
  logger.debug(`Progress cancel requested for ${progressId}`)

  // Send cancel request to the backend cancel endpoint if one was provided
  const cancelUrl = cancelUrls.get(progressId)
  if (cancelUrl) {
    try {
      await client.request('POST', cancelUrl)
    } catch (err) {
      logger.warn(`Failed to send cancel request: ${err}`)
    }
  }

  // Hide the widget
  hide(progressId)
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
      logger.warn('Failed to parse progressShow event data')
      return
    }
  }

  const progressId = options.progress_id
  if (!progressId) {
    logger.warn('progressShow event missing progress_id')
    return
  }

  show(progressId, options)
}

/**
 * Handle progressValue SSE event
 * @param {MessageEvent} event
 */
function handleProgressValue(event) {
  let data = {}
  try {
    data = JSON.parse(event.data)
  } catch {
    logger.warn('Failed to parse progressValue event data')
    return
  }

  const progressId = data.progress_id
  if (!progressId) {
    logger.warn('progressValue event missing progress_id')
    return
  }

  setValue(progressId, data.value)
}

/**
 * Handle progressLabel SSE event
 * @param {MessageEvent} event
 */
function handleProgressLabel(event) {
  let data = {}
  try {
    data = JSON.parse(event.data)
  } catch {
    logger.warn('Failed to parse progressLabel event data')
    return
  }

  const progressId = data.progress_id
  if (!progressId) {
    logger.warn('progressLabel event missing progress_id')
    return
  }

  setLabel(progressId, data.label)
}

/**
 * Handle progressHide SSE event
 * @param {MessageEvent} event
 */
function handleProgressHide(event) {
  let data = {}
  try {
    data = JSON.parse(event.data)
  } catch {
    logger.warn('Failed to parse progressHide event data')
    return
  }

  const progressId = data.progress_id
  if (!progressId) {
    logger.warn('progressHide event missing progress_id')
    return
  }

  hide(progressId)
}

//
// Public API
//

/**
 * Show or create a progress widget
 * @param {string} progressId - Unique identifier for this progress instance
 * @param {object} [options]
 * @param {string} [options.label] - Initial label text
 * @param {number|null} [options.value] - Initial value (null for indeterminate)
 * @param {boolean} [options.cancellable=true] - Whether to show cancel button
 * @param {string} [options.cancelUrl] - URL to POST to when cancel is clicked
 */
function show(progressId, options = {}) {
  const { label = '', value = null, cancellable = true, cancelUrl } = options

  const widget = getOrCreateWidget(progressId)

  // Store cancel URL if provided
  if (cancelUrl) {
    cancelUrls.set(progressId, cancelUrl)
  }

  // Restore minimized state from session storage
  const minimized = getMinimizedState(progressId)
  applyMinimizedState(widget, minimized)

  // Set initial values
  setWidgetValue(widget, value)
  setWidgetLabel(widget, label)

  // Show/hide cancel button
  widget._cancelBtn.style.display = cancellable ? '' : 'none'

  // Show widget
  widget.style.display = ''
}

/**
 * Hide and remove a progress widget
 * @param {string} progressId
 */
function hide(progressId) {
  removeWidget(progressId)
}

/**
 * Set the progress value for a widget
 * @param {string} progressId
 * @param {number|null} value - Progress value (0-100), null for indeterminate
 */
function setValue(progressId, value) {
  const widget = activeWidgets.get(progressId)
  if (widget) {
    setWidgetValue(widget, value)
  }
}

/**
 * Set progress value on a widget element
 * @param {HTMLElement} widget
 * @param {number|null} value
 */
function setWidgetValue(widget, value) {
  const progressBar = widget._progressBar
  if (value === null || value === undefined) {
    progressBar.indeterminate = true
  } else {
    progressBar.indeterminate = false
    progressBar.value = value
  }
}

/**
 * Set the label text for a widget
 * @param {string} progressId
 * @param {string} label
 */
function setLabel(progressId, label) {
  const widget = activeWidgets.get(progressId)
  if (widget) {
    setWidgetLabel(widget, label)
  }
}

/**
 * Set label on a widget element
 * @param {HTMLElement} widget
 * @param {string} label
 */
function setWidgetLabel(widget, label) {
  widget._labelRow.textContent = label
}

/**
 * Check if a progress widget is visible
 * @param {string} progressId
 * @returns {boolean}
 */
function isVisible(progressId) {
  return activeWidgets.has(progressId)
}

/**
 * Get list of active widget progress IDs
 * @returns {string[]}
 */
function getActiveWidgets() {
  return Array.from(activeWidgets.keys())
}

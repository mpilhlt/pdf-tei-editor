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
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlIconButton, SlProgressBar } from '../ui.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createFromTemplate } from '../ui.js'

// Register template before class definition, per convention
await registerTemplate('progress-template', 'progress.html')

class ProgressPlugin extends Plugin {
  /** @type {Map<string, HTMLElement>} Map of progress_id -> widget element */
  #activeWidgets = new Map()

  /** @type {Map<string, string>} Map of progress_id -> cancel URL */
  #cancelUrls = new Map()

  /** @type {HTMLTemplateElement|null} */
  #widgetTemplate = null

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'progress', deps: ['sse'] })
  }

  async install(state) {
    await super.install(state)

    const logger = this.getDependency('logger')
    createFromTemplate('progress-template', document.body)
    this.#widgetTemplate = /** @type {HTMLTemplateElement|null} */ (document.getElementById('progress-widget-template'))
    if (!this.#widgetTemplate) {
      logger.error('Progress widget template not found')
      return
    }

    const sse = this.getDependency('sse')
    sse.addEventListener('progressShow', (e) => this.#handleProgressShow(e))
    sse.addEventListener('progressValue', (e) => this.#handleProgressValue(e))
    sse.addEventListener('progressLabel', (e) => this.#handleProgressLabel(e))
    sse.addEventListener('progressHide', (e) => this.#handleProgressHide(e))
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * @param {string} progressId
   * @returns {boolean}
   */
  #getMinimizedState(progressId) {
    return sessionStorage.getItem(`progress-widget-minimized-${progressId}`) === 'true'
  }

  /**
   * @param {string} progressId
   * @param {boolean} minimized
   */
  #setMinimizedState(progressId, minimized) {
    sessionStorage.setItem(`progress-widget-minimized-${progressId}`, String(minimized))
  }

  /**
   * @param {string} progressId
   * @returns {HTMLElement}
   */
  #createWidgetInstance(progressId) {
    if (!this.#widgetTemplate) {
      throw new Error('Progress widget template not loaded')
    }

    const content = this.#widgetTemplate.content.cloneNode(true)
    const widget = /** @type {HTMLElement} */ (/** @type {DocumentFragment} */ (content).querySelector('.progress-widget'))

    widget.dataset.progressId = progressId

    const progressBar = /** @type {SlProgressBar} */ (widget.querySelector('[name="progressBar"]'))
    const cancelBtn = /** @type {SlIconButton} */ (widget.querySelector('[data-name="cancelBtn"]'))
    const labelRow = /** @type {HTMLDivElement} */ (widget.querySelector('[name="labelRow"]'))

    widget._progressBar = progressBar
    widget._cancelBtn = cancelBtn
    widget._labelRow = labelRow

    widget.addEventListener('click', (e) => {
      if (e.target === cancelBtn || cancelBtn.contains(/** @type {Node} */ (e.target))) return
      this.#toggleMinimized(progressId)
    })

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.#handleCancel(progressId)
    })

    document.body.appendChild(widget)
    this.#activeWidgets.set(progressId, widget)
    this.#updateStackIndices()

    return widget
  }

  /**
   * @param {string} progressId
   * @returns {HTMLElement}
   */
  #getOrCreateWidget(progressId) {
    return this.#activeWidgets.get(progressId) ?? this.#createWidgetInstance(progressId)
  }

  /** @param {string} progressId */
  #removeWidget(progressId) {
    const widget = this.#activeWidgets.get(progressId)
    if (widget) {
      widget.remove()
      this.#activeWidgets.delete(progressId)
      this.#cancelUrls.delete(progressId)
      this.#updateStackIndices()
    }
  }

  #updateStackIndices() {
    let index = 0
    for (const [, widget] of this.#activeWidgets) {
      widget.dataset.stackIndex = String(index++)
    }
  }

  /** @param {string} progressId */
  #toggleMinimized(progressId) {
    const widget = this.#activeWidgets.get(progressId)
    if (!widget) return
    const isMinimized = widget.classList.contains('minimized')
    this.#setMinimizedState(progressId, !isMinimized)
    this.#applyMinimizedState(widget, !isMinimized)
  }

  /**
   * @param {HTMLElement} widget
   * @param {boolean} minimized
   */
  #applyMinimizedState(widget, minimized) {
    widget.classList.toggle('minimized', minimized)
    widget.classList.toggle('maximized', !minimized)
  }

  /** @param {string} progressId */
  async #handleCancel(progressId) {
    this.getDependency('logger').debug(`Progress cancel requested for ${progressId}`)
    const cancelUrl = this.#cancelUrls.get(progressId)
    if (cancelUrl) {
      try {
        await this.getDependency('client').callApi(cancelUrl, 'POST')
      } catch (err) {
        this.getDependency('logger').warn(`Failed to send cancel request: ${err}`)
      }
    }
    this.hide(progressId)
  }

  /** @param {MessageEvent} event */
  #handleProgressShow(event) {
    let options = {}
    if (event.data) {
      try {
        options = JSON.parse(event.data)
      } catch {
        this.getDependency('logger').warn('Failed to parse progressShow event data')
        return
      }
    }
    const progressId = options.progress_id
    if (!progressId) {
      this.getDependency('logger').warn('progressShow event missing progress_id')
      return
    }
    this.show(progressId, options)
  }

  /** @param {MessageEvent} event */
  #handleProgressValue(event) {
    let data = {}
    try { data = JSON.parse(event.data) } catch {
      this.getDependency('logger').warn('Failed to parse progressValue event data')
      return
    }
    if (!data.progress_id) { this.getDependency('logger').warn('progressValue event missing progress_id'); return }
    this.setValue(data.progress_id, data.value)
  }

  /** @param {MessageEvent} event */
  #handleProgressLabel(event) {
    let data = {}
    try { data = JSON.parse(event.data) } catch {
      this.getDependency('logger').warn('Failed to parse progressLabel event data')
      return
    }
    if (!data.progress_id) { this.getDependency('logger').warn('progressLabel event missing progress_id'); return }
    this.setLabel(data.progress_id, data.label)
  }

  /** @param {MessageEvent} event */
  #handleProgressHide(event) {
    let data = {}
    try { data = JSON.parse(event.data) } catch {
      this.getDependency('logger').warn('Failed to parse progressHide event data')
      return
    }
    if (!data.progress_id) { this.getDependency('logger').warn('progressHide event missing progress_id'); return }
    this.hide(data.progress_id)
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Show or create a progress widget.
   * @param {string} progressId
   * @param {object} [options]
   * @param {string} [options.label]
   * @param {number|null} [options.value]
   * @param {boolean} [options.cancellable=true]
   * @param {string} [options.cancelUrl]
   */
  show(progressId, options = {}) {
    const { label = '', value = null, cancellable = true, cancelUrl } = options
    const widget = this.#getOrCreateWidget(progressId)
    if (cancelUrl) this.#cancelUrls.set(progressId, cancelUrl)
    this.#applyMinimizedState(widget, this.#getMinimizedState(progressId))
    this.#setWidgetValue(widget, value)
    this.#setWidgetLabel(widget, label)
    widget._cancelBtn.style.display = cancellable ? '' : 'none'
    widget.style.display = ''
  }

  /**
   * Hide and remove a progress widget.
   * @param {string} progressId
   */
  hide(progressId) {
    this.#removeWidget(progressId)
  }

  /**
   * Set the progress value for a widget.
   * @param {string} progressId
   * @param {number|null} value
   */
  setValue(progressId, value) {
    const widget = this.#activeWidgets.get(progressId)
    if (widget) this.#setWidgetValue(widget, value)
  }

  /**
   * @param {HTMLElement} widget
   * @param {number|null} value
   */
  #setWidgetValue(widget, value) {
    const progressBar = widget._progressBar
    if (value === null || value === undefined) {
      progressBar.indeterminate = true
    } else {
      progressBar.indeterminate = false
      progressBar.value = value
    }
  }

  /**
   * Set the label text for a widget.
   * @param {string} progressId
   * @param {string} label
   */
  setLabel(progressId, label) {
    const widget = this.#activeWidgets.get(progressId)
    if (widget) this.#setWidgetLabel(widget, label)
  }

  /**
   * @param {HTMLElement} widget
   * @param {string} label
   */
  #setWidgetLabel(widget, label) {
    widget._labelRow.textContent = label
  }

  /**
   * Check if a progress widget is visible.
   * @param {string} progressId
   * @returns {boolean}
   */
  isVisible(progressId) {
    return this.#activeWidgets.has(progressId)
  }

  /**
   * Get list of active widget progress IDs.
   * @returns {string[]}
   */
  getActiveWidgets() {
    return Array.from(this.#activeWidgets.keys())
  }
}

export default ProgressPlugin

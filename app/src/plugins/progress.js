/**
 * Progress Widget Plugin (Multi-Instance)
 *
 * Provides progress indicator widgets for long-running server processes,
 * controlled via SSE (Server-Sent Events). Supports multiple simultaneous
 * progress widgets, each identified by a unique progress_id.
 *
 * Job widgets (`job-<job id>`) are created by the `jobs` plugin (`app/src/plugins/jobs.js`) from
 * the `job` SSE events; use jobs for new long-running work (docs/code-assistant/jobs.md).
 * The `progress*` SSE events below and `show()` are deprecated for new code and remain for
 * plugins that still use them.
 *
 * ## SSE Event Types
 *
 * All events include a `progress_id` field to identify the target widget.
 *
 * ### `progressShow`
 * Shows or creates a progress widget. Data is JSON:
 * ```json
 * {"progress_id": "abc123", "title": "Extracting references", "label": "Processing...", "value": null, "cancellable": true, "cancelUrl": "/api/plugins/my-plugin/cancel/abc123", "minimized": false}
 * ```
 * - `progress_id` (string, required): Unique identifier for this progress instance
 * - `title` (string, optional): Names the process; shown above the bar, in small cropped type when minimized
 * - `label` (string, optional): Initial text label
 * - `value` (number|null, optional): Initial progress value (0-100), null for indeterminate
 * - `cancellable` (boolean, optional): Whether to show cancel button (default: true)
 * - `cancelUrl` (string, optional): URL to POST to when cancel button is clicked
 * - `minimized` (boolean, optional): Start minimized (default: false), unless the user toggled this widget before
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
 * ### `progressTitle`
 * Sets the title. Data is JSON:
 * ```json
 * {"progress_id": "abc123", "title": "Extracting references"}
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
 * created the progress widget should implement this endpoint. Widgets created
 * directly via `show()` by client-side code can pass an `onCancel` callback
 * instead.
 *
 * ## Widget Behavior
 *
 * - Click on widget toggles between minimized/maximized states
 * - Multiple widgets stack vertically in two flex containers: minimized widgets
 *   bottom-left (growing upward), maximized widgets centered (scrolling when
 *   they exceed the viewport). Within each container, widgets keep the order
 *   in which they were created
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

  /** @type {Map<string, () => void>} Map of progress_id -> client-side cancel callback */
  #cancelHandlers = new Map()

  /** @type {HTMLTemplateElement|null} */
  #widgetTemplate = null

  /** @type {HTMLDivElement|null} Container for maximized widgets */
  #maximizedStack = null

  /** @type {HTMLDivElement|null} Container for minimized widgets */
  #minimizedStack = null

  /** Creation counter used to keep widgets in creation order within a container */
  #nextOrder = 0

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'progress', deps: ['sse'] })
  }

  async install(state) {
    await super.install(state)

    const logger = this.getDependency('logger')
    const nodes = createFromTemplate('progress-template', document.body)
    const stacks = nodes.filter(node => node instanceof HTMLDivElement && node.classList.contains('progress-stack'))
    this.#maximizedStack = /** @type {HTMLDivElement} */ (stacks.find(node => node.classList.contains('progress-stack-maximized')))
    this.#minimizedStack = /** @type {HTMLDivElement} */ (stacks.find(node => node.classList.contains('progress-stack-minimized')))
    this.#widgetTemplate = /** @type {HTMLTemplateElement|null} */ (document.getElementById('progress-widget-template'))
    if (!this.#widgetTemplate) {
      logger.error('Progress widget template not found')
      return
    }

    const sse = this.getDependency('sse')
    sse.addEventListener('progressShow', (e) => this.#handleProgressShow(e))
    sse.addEventListener('progressValue', (e) => this.#handleProgressValue(e))
    sse.addEventListener('progressLabel', (e) => this.#handleProgressLabel(e))
    sse.addEventListener('progressTitle', (e) => this.#handleProgressTitle(e))
    sse.addEventListener('progressHide', (e) => this.#handleProgressHide(e))
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * @param {string} progressId
   * @returns {boolean|null} null if the user has not toggled the widget yet
   */
  #getMinimizedState(progressId) {
    const stored = sessionStorage.getItem(`progress-widget-minimized-${progressId}`)
    return stored === null ? null : stored === 'true'
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
    widget.dataset.order = String(this.#nextOrder++)

    const progressBar = /** @type {SlProgressBar} */ (widget.querySelector('[name="progressBar"]'))
    const cancelBtn = /** @type {SlIconButton} */ (widget.querySelector('[data-name="cancelBtn"]'))
    const labelRow = /** @type {HTMLDivElement} */ (widget.querySelector('[name="labelRow"]'))
    const titleRow = /** @type {HTMLDivElement} */ (widget.querySelector('[name="titleRow"]'))

    widget._progressBar = progressBar
    widget._cancelBtn = cancelBtn
    widget._labelRow = labelRow
    widget._titleRow = titleRow

    widget.addEventListener('click', (e) => {
      if (e.target === cancelBtn || cancelBtn.contains(/** @type {Node} */ (e.target))) return
      this.#toggleMinimized(progressId)
    })

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.#handleCancel(progressId)
    })

    this.#activeWidgets.set(progressId, widget)

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
      this.#cancelHandlers.delete(progressId)
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
    const stack = minimized ? this.#minimizedStack : this.#maximizedStack
    if (!stack) throw new Error('Progress widget containers not created')
    if (widget.parentElement === stack) return
    const order = Number(widget.dataset.order)
    const next = Array.from(stack.children).find(child => Number(/** @type {HTMLElement} */ (child).dataset.order) > order)
    stack.insertBefore(widget, next ?? null)
  }

  /** @param {string} progressId */
  async #handleCancel(progressId) {
    this.getDependency('logger').debug(`Progress cancel requested for ${progressId}`)
    this.#cancelHandlers.get(progressId)?.()
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
  #handleProgressTitle(event) {
    let data = {}
    try { data = JSON.parse(event.data) } catch {
      this.getDependency('logger').warn('Failed to parse progressTitle event data')
      return
    }
    if (!data.progress_id) { this.getDependency('logger').warn('progressTitle event missing progress_id'); return }
    this.setTitle(data.progress_id, data.title)
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
   * @param {string} [options.title] Names the process; shown above the bar. Omit to keep the current title when re-showing
   * @param {string} [options.label] Current status, shown below the bar (hidden when minimized)
   * @param {number|null} [options.value]
   * @param {boolean} [options.cancellable=true]
   * @param {string} [options.cancelUrl]
   * @param {() => void} [options.onCancel] Called when the user clicks cancel (for client-driven work)
   * @param {boolean} [options.minimized=false] Start minimized, unless the user toggled this widget before
   */
  show(progressId, options = {}) {
    const { title, label = '', value = null, cancellable = true, cancelUrl, onCancel, minimized = false } = options
    const widget = this.#getOrCreateWidget(progressId)
    if (cancelUrl) this.#cancelUrls.set(progressId, cancelUrl)
    if (onCancel) this.#cancelHandlers.set(progressId, onCancel)
    this.#applyMinimizedState(widget, this.#getMinimizedState(progressId) ?? minimized)
    this.#setWidgetValue(widget, value)
    this.#setWidgetLabel(widget, label)
    if (title !== undefined) this.#setWidgetTitle(widget, title)
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
   * Set the title of a widget.
   * @param {string} progressId
   * @param {string} title
   */
  setTitle(progressId, title) {
    const widget = this.#activeWidgets.get(progressId)
    if (widget) this.#setWidgetTitle(widget, title)
  }

  /**
   * @param {HTMLElement} widget
   * @param {string} title
   */
  #setWidgetTitle(widget, title) {
    widget._titleRow.textContent = title ?? ''
    widget.title = title ?? ''
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

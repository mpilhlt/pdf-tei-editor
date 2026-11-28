/**
 * Jobs admin plugin: an admin-only dialog (Tools menu, "Administration" > "Jobs") that lists the
 * jobs of all users with their type, owner, status, progress and times. Admins cancel unfinished
 * jobs, delete finished ones, or cancel all unfinished jobs at once. While the dialog is open it
 * refreshes with `jobsList()` every 5 s (the SSE stream of an admin carries the events of other
 * users, but the dialog does not depend on them); the timer stops when the dialog closes.
 * See docs/code-assistant/jobs.md.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { jobsAdminDialogPart } from '../templates/jobs-admin-dialog.types.js'
 * @import { Job } from '../modules/api-client-v1.js'
 * @import { ToolsPlugin } from './tools.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'
import { formatJobProgress } from '../modules/job-client.js'

await registerTemplate('jobs-admin-dialog', 'jobs-admin-dialog.html')
await registerTemplate('jobs-admin-menu-item', 'jobs-admin-menu-item.html')

// Icons used in jobs-admin templates (needed for build system to include them)
// <sl-icon name="list-task"></sl-icon>
// <sl-icon name="x-circle"></sl-icon>
// <sl-icon name="trash"></sl-icon>

const REFRESH_MS = 5000
const UNFINISHED = ['queued', 'active', 'interrupted']

/**
 * Escape a string for use in HTML text and attribute values
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/**
 * Format an ISO timestamp for display in the local time zone
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function formatTime(iso) {
  return iso ? new Date(iso).toLocaleString() : ''
}

class JobsAdminPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'jobs-admin', deps: ['client', 'tools', 'dialog', 'logger'] })
  }

  /** @type {SlDialog & jobsAdminDialogPart} */
  #ui = null

  /** @type {HTMLElement | null} */
  #menuItem = null

  /** @type {Map<string, string>} Job type name -> title */
  #titles = new Map()

  /** @type {ReturnType<typeof setInterval> | null} */
  #timer = null

  /** @type {boolean} */
  #refreshing = false

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state)
    this.#ui = this.createUi(createSingleFromTemplate('jobs-admin-dialog', document.body))
    const ui = this.#ui
    ui.closeBtn.addEventListener('click', () => ui.hide())
    ui.addEventListener('sl-after-hide', event => {
      if (event.target === ui) this.#stopTimer()
    })
    ui.statusFilter.addEventListener('sl-change', () => this.#refresh())
    ui.typeFilter.addEventListener('sl-change', () => this.#refresh())
    ui.cancelAllBtn.addEventListener('click', () => this.#cancelAll())
    ui.jobsTable.jobsBody.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('[data-action]') : null
      if (!(button instanceof HTMLElement)) return
      const id = button.closest('tr')?.dataset.jobId
      if (id) this.#rowAction(button.dataset.action, id)
    })
  }

  async start() {
    this.#menuItem = createSingleFromTemplate('jobs-admin-menu-item')
    const tools = /** @type {ToolsPlugin} */ (this.getDependency('tools'))
    tools.addMenuItems([this.#menuItem], 'administration')
    this.#menuItem.addEventListener('click', () => this.#open())
    this.#menuItem.style.display = userIsAdmin(this.state.user) ? '' : 'none'
  }

  /**
   * Show the menu entry to admins only; close the dialog and stop the refresh timer when the
   * user logs out or is no longer an admin.
   * @param {ApplicationState['user']} newUser
   */
  async onUserChange(newUser) {
    const admin = userIsAdmin(newUser)
    if (this.#menuItem) this.#menuItem.style.display = admin ? '' : 'none'
    if (!admin) {
      this.#stopTimer()
      if (this.#ui?.open) this.#ui.hide()
    }
  }

  async shutdown() {
    this.#stopTimer()
  }

  /** Open the dialog, load the job types and start the refresh timer */
  async #open() {
    const ui = this.#ui
    try {
      if (this.#titles.size === 0) {
        for (const info of await this.#api.jobsTypes()) this.#titles.set(info.name, info.title)
        const current = ui.typeFilter.value
        ui.typeFilter.querySelectorAll('sl-option:not([value=""])').forEach(o => o.remove())
        for (const [name, title] of this.#titles) {
          const option = document.createElement('sl-option')
          option.value = name
          option.textContent = title
          ui.typeFilter.append(option)
        }
        ui.typeFilter.value = current
      }
      ui.show()
      await this.#refresh()
      this.#stopTimer()
      // the dialog may have been closed (or the user logged out) during the first refresh
      if (!ui.open || !userIsAdmin(this.state?.user)) return
      this.#timer = setInterval(() => this.#refresh(), REFRESH_MS)
    } catch (error) {
      this.getDependency('logger').error(`Failed to open the job list: ${error instanceof Error ? error.message : String(error)}`)
      notify('Failed to load the jobs', 'danger')
    }
  }

  #stopTimer() {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  get #api() {
    return this.getDependency('client').apiClient
  }

  /** @returns {{status?: string[], type?: string}} The list filter chosen in the dialog */
  #filter() {
    const type = String(this.#ui.typeFilter.value || '')
    return {
      ...(this.#ui.statusFilter.value === 'unfinished' ? { status: UNFINISHED } : {}),
      ...(type ? { type } : {})
    }
  }

  /** Reload the job list and render it */
  async #refresh() {
    if (this.#refreshing) return
    this.#refreshing = true
    try {
      this.#render(await this.#api.jobsList(this.#filter()))
    } catch (error) {
      this.getDependency('logger').warn(`Failed to refresh the job list: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.#refreshing = false
    }
  }

  /**
   * Render the table, newest job first
   * @param {Job[]} jobs
   */
  #render(jobs) {
    const rows = [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(job => {
      const unfinished = UNFINISHED.includes(job.status)
      const action = unfinished
        ? `<sl-button size="small" variant="warning" data-action="cancel"${job.cancel_requested ? ' disabled' : ''}>Cancel</sl-button>`
        : '<sl-button size="small" variant="danger" data-action="delete"><sl-icon slot="prefix" name="trash"></sl-icon>Delete</sl-button>'
      const progress = unfinished ? (job.message || formatJobProgress(job)) : (job.error?.message ?? job.message ?? '')
      const cell = 'style="padding: 0.4rem 0.6rem; border-top: 1px solid var(--sl-color-neutral-200);"'
      return `<tr data-job-id="${esc(job.id)}">` +
        `<td ${cell} data-column="type">${esc(this.#titles.get(job.type) ?? job.type)}</td>` +
        `<td ${cell} data-column="owner">${esc(job.owner)}</td>` +
        `<td ${cell} data-column="status">${esc(job.status)}</td>` +
        `<td ${cell} data-column="progress">${esc(progress)}</td>` +
        `<td ${cell}>${esc(formatTime(job.created_at))}</td>` +
        `<td ${cell}>${esc(formatTime(job.updated_at))}</td>` +
        `<td ${cell}>${action}</td></tr>`
    })
    this.#ui.jobsTable.jobsBody.innerHTML = rows.join('')
    this.#ui.summary.textContent = jobs.length ? `${jobs.length} job${jobs.length === 1 ? '' : 's'}` : 'No jobs'
  }

  /**
   * @param {string|undefined} action
   * @param {string} jobId
   */
  async #rowAction(action, jobId) {
    try {
      if (action === 'cancel') await this.#api.jobsCancel(jobId)
      else if (action === 'delete') await this.#api.jobsDelete(jobId)
      await this.#refresh()
    } catch (error) {
      notify(`Failed: ${error instanceof Error ? error.message : String(error)}`, 'danger')
    }
  }

  /** Cancel all unfinished jobs (of the chosen type) after a confirmation */
  async #cancelAll() {
    const type = this.#filter().type
    const what = type ? `all unfinished jobs of type "${this.#titles.get(type) ?? type}"` : 'all unfinished jobs of all users'
    if (!await this.getDependency('dialog').confirm(`Cancel ${what}?`, 'Cancel jobs', 'warning')) return
    try {
      const { count } = await this.#api.jobsCancelAll(type ? { type } : {})
      notify(`Cancelled ${count} job${count === 1 ? '' : 's'}`, 'success')
      await this.#refresh()
    } catch (error) {
      notify(`Failed: ${error instanceof Error ? error.message : String(error)}`, 'danger')
    }
  }
}

export { JobsAdminPlugin }
export default JobsAdminPlugin

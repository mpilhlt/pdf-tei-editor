/**
 * Plugin Manager UI
 *
 * Admin-only dialog (Tools menu, "Administration") to inspect backend plugins and
 * enable/disable them at runtime, with dependency cascade warnings.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { pluginAdminDialogPart } from '../templates/plugin-admin-dialog.types.js'
 * @import { pluginAdminConfirmDialogPart } from '../templates/plugin-admin-confirm-dialog.types.js'
 * @import { PluginAdminInfo } from '../modules/api-client-v1.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { userIsAdmin } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'

// Register templates
await registerTemplate('plugin-admin-dialog', 'plugin-admin-dialog.html')
await registerTemplate('plugin-admin-confirm-dialog', 'plugin-admin-confirm-dialog.html')
await registerTemplate('plugin-admin-menu-item', 'plugin-admin-menu-item.html')

// Icons used in plugin-admin templates (needed for build system to include them)
// <sl-icon name="plug"></sl-icon>
// <sl-icon name="search"></sl-icon>
// <sl-icon name="exclamation-triangle"></sl-icon>
// <sl-icon name="book"></sl-icon>

/** @type {Record<string, string>} */
const STATUS_LABELS = { active: 'Active', disabled: 'Disabled', inactive: 'Inactive', unavailable: 'Unavailable', failed: 'Failed' }
/** @type {Record<string, string>} */
const STATUS_VARIANTS = { active: 'success', disabled: 'neutral', inactive: 'warning', unavailable: 'warning', failed: 'danger' }
const STATUS_ORDER = ['all', 'active', 'disabled', 'inactive', 'unavailable', 'failed']

/**
 * Escape a string for use in HTML text and attribute values
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

class PluginAdminPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'plugin-admin', deps: ['client', 'tools', 'logger'] })
  }

  get #logger() { return this.getDependency('logger') }
  get #api() { return this.getDependency('client').apiClient }

  /** @type {SlDialog & pluginAdminDialogPart} */
  #dialogUi = null

  /** @type {SlDialog & pluginAdminConfirmDialogPart} */
  #confirmUi = null

  /** @type {HTMLElement | null} */
  #menuItem = null

  /** @type {PluginAdminInfo[]} */
  #plugins = []

  #statusFilter = 'all'

  /** True after a successful change; the banner asks the user to reload */
  #reloadPending = false

  /** @type {(() => void) | null} */
  #onConfirm = null

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.#logger.debug(`Installing plugin "plugin-admin"`)

    this.#dialogUi = this.createUi(createSingleFromTemplate('plugin-admin-dialog', document.body))
    this.#confirmUi = this.createUi(createSingleFromTemplate('plugin-admin-confirm-dialog', document.body))

    this.#dialogUi.closeBtn.addEventListener('click', () => this.#dialogUi.hide())
    this.#dialogUi.searchInput.addEventListener('sl-input', () => this.#render())
    this.#dialogUi.reloadBanner.reloadBtn.addEventListener('click', () => window.location.reload())

    this.#dialogUi.statusChips.addEventListener('click', e => {
      const chip = /** @type {HTMLElement} */ (e.target).closest('[data-status]')
      if (chip instanceof HTMLElement) {
        this.#statusFilter = chip.dataset.status
        this.#render()
      }
    })
    this.#dialogUi.pluginList.addEventListener('sl-change', e => {
      const sw = /** @type {HTMLElement} */ (e.target).closest('sl-switch')
      if (sw instanceof HTMLElement) this.#toggle(sw.dataset.id, /** @type {any} */ (sw).checked)
    })
    this.#dialogUi.pluginList.addEventListener('click', e => {
      const link = /** @type {HTMLElement} */ (e.target).closest('[data-go]')
      if (link instanceof HTMLElement) this.#goTo(link.dataset.go)
    })

    this.#confirmUi.cancelBtn.addEventListener('click', () => {
      this.#onConfirm = null
      this.#confirmUi.hide()
      this.#render() // reset the switch the user just flipped
    })
    this.#confirmUi.okBtn.addEventListener('click', () => {
      const run = this.#onConfirm
      this.#onConfirm = null
      this.#confirmUi.hide()
      if (run) run()
    })
  }

  async start() {
    this.#menuItem = createSingleFromTemplate('plugin-admin-menu-item')
    this.getDependency('tools').addMenuItems([this.#menuItem], 'administration')
    this.#menuItem.addEventListener('click', () => this.#open())
    this.#menuItem.style.display = userIsAdmin(this.state.user) ? '' : 'none'
  }

  /**
   * @param {any} newUser
   */
  async onUserChange(newUser) {
    if (this.#menuItem) {
      this.#menuItem.style.display = userIsAdmin(newUser) ? '' : 'none'
    }
  }

  /** Load the plugin list and open the dialog */
  async #open() {
    try {
      await this.#load()
      this.#render()
      this.#dialogUi.show()
    } catch (error) {
      this.#logger.error('Failed to open plugin manager: ' + String(error))
      notify('Failed to load plugins', 'danger', 'exclamation-octagon')
    }
  }

  async #load() {
    const response = await this.#api.pluginsAdmin()
    this.#plugins = response.plugins
  }

  /**
   * @param {string} id
   * @returns {PluginAdminInfo | undefined}
   */
  #byId(id) {
    return this.#plugins.find(p => p.id === id)
  }

  /** Re-render summary, status chips and plugin rows */
  #render() {
    const ui = this.#dialogUi
    /** @type {Record<string, number>} */
    const counts = { all: this.#plugins.length }
    for (const p of this.#plugins) counts[p.status] = (counts[p.status] || 0) + 1
    ui.summary.textContent = `${counts.active || 0} of ${this.#plugins.length} plugins active`

    ui.statusChips.innerHTML = STATUS_ORDER
      .filter(k => k === 'all' || counts[k])
      .map(k => `<sl-button size="small" pill data-status="${k}" variant="${this.#statusFilter === k ? 'primary' : 'default'}">${k === 'all' ? 'All' : STATUS_LABELS[k]} (${counts[k]})</sl-button>`)
      .join('')

    const q = ui.searchInput.value.trim().toLowerCase()
    const rows = this.#plugins.filter(p =>
      (this.#statusFilter === 'all' || p.status === this.#statusFilter) &&
      (!q || `${p.id} ${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q)))

    ui.pluginList.innerHTML = rows.length
      ? rows.map(p => this.#rowHtml(p)).join('')
      : '<div style="padding: 1.5rem; text-align: center; color: var(--sl-color-neutral-600);">No plugins match this filter.</div>'
    ui.reloadBanner.style.display = this.#reloadPending ? '' : 'none'
  }

  /**
   * @param {PluginAdminInfo} p
   * @returns {string}
   */
  #rowHtml(p) {
    const canToggle = !p.protected && ['active', 'disabled', 'inactive'].includes(p.status)
    const dim = p.status === 'active' ? '' : 'opacity: 0.65;'
    /** @param {string[]} ids */
    const chips = ids => ids.map(id => `<sl-button size="small" variant="default" data-go="${esc(id)}" style="font-family: var(--sl-font-mono);">${esc(id)}</sl-button>`).join(' ')
    const directDependents = this.#plugins.filter(o => o.dependencies.includes(p.id)).map(o => o.id)
    const reasonColor = p.status === 'failed' ? 'danger' : 'warning'
    return `<div id="plugin-row-${esc(p.id)}" style="display: grid; grid-template-columns: 3rem 1fr auto; gap: 0.75rem; padding: 0.85rem 1rem; border-bottom: 1px solid var(--sl-color-neutral-200);">
      <sl-switch style="align-self: start; justify-self: start; margin-top: 0.15rem;" data-id="${esc(p.id)}" ${p.enabled && !['unavailable', 'failed'].includes(p.status) ? 'checked' : ''} ${canToggle ? '' : 'disabled'} title="${p.protected ? 'Protected plugin, cannot be disabled' : ''}"></sl-switch>
      <div style="${dim}">
        <div style="display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap;">
          <strong>${esc(p.name)}</strong><small>v${esc(p.version)}</small>
          <sl-badge variant="${STATUS_VARIANTS[p.status]}" pill>${STATUS_LABELS[p.status]}</sl-badge>
          ${p.protected ? '<sl-badge variant="neutral" pill>Protected</sl-badge>' : ''}
        </div>
        <div style="color: var(--sl-color-neutral-600); margin-top: 0.15rem;">${esc(p.description)}</div>
        ${p.status_reason ? `<div style="font-size: 0.85em; margin-top: 0.3rem; color: var(--sl-color-${reasonColor}-700);">${esc(p.status_reason)}</div>` : ''}
        ${p.dependencies.length || directDependents.length ? `<div style="margin-top: 0.4rem; display: flex; gap: 0.25rem 1rem; flex-wrap: wrap; font-size: 0.85em; color: var(--sl-color-neutral-600); align-items: center;">
          ${p.dependencies.length ? `<span>Requires ${chips(p.dependencies)}</span>` : ''}
          ${directDependents.length ? `<span>Required by ${chips(directDependents)}</span>` : ''}</div>` : ''}
        <div style="margin-top: 0.3rem; font-size: 0.8em; color: var(--sl-color-neutral-500); display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <span>${esc(p.category)}</span><span>${p.source === 'external' ? 'external' : 'built-in'}</span>
          <span>${p.menu_endpoints} menu ${p.menu_endpoints === 1 ? 'item' : 'items'}</span>${p.has_frontend_extension ? '<span>frontend extension</span>' : ''}
        </div>
      </div>
      ${p.readme_url ? `<sl-button size="small" href="${esc(p.readme_url)}" target="_blank" rel="noopener"><sl-icon slot="prefix" name="book"></sl-icon>README</sl-button>` : '<span></span>'}
    </div>`
  }

  /**
   * Clear filters, scroll to a plugin row and highlight it briefly
   * @param {string} id
   */
  #goTo(id) {
    this.#statusFilter = 'all'
    this.#dialogUi.searchInput.value = ''
    this.#render()
    const row = this.#dialogUi.pluginList.querySelector(`#plugin-row-${CSS.escape(id)}`)
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.style.transition = 'background 0.3s'
      row.style.background = 'var(--sl-color-primary-100)'
      setTimeout(() => { row.style.background = '' }, 1200)
    }
  }

  /**
   * Show the confirmation dialog listing affected plugins
   * @param {string} title
   * @param {string} text
   * @param {string[]} ids
   * @param {string} okLabel
   * @param {'primary'|'danger'} variant
   * @param {() => void} onOk
   */
  #confirm(title, text, ids, okLabel, variant, onOk) {
    const c = this.#confirmUi
    c.label = title
    c.text.textContent = text
    c.affectedList.innerHTML = ids.map(id => {
      const p = this.#byId(id)
      const status = p?.status ?? 'inactive'
      return `<li style="display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.6rem; border: 1px solid var(--sl-color-neutral-200); border-radius: var(--sl-border-radius-small);"><span><strong>${esc(p?.name ?? id)}</strong> <small>${esc(id)}</small></span><sl-badge variant="${STATUS_VARIANTS[status]}" pill>${STATUS_LABELS[status]}</sl-badge></li>`
    }).join('')
    c.okBtn.textContent = okLabel
    c.okBtn.variant = variant
    this.#onConfirm = onOk
    c.show()
  }

  /**
   * Toggle a plugin. Asks for confirmation if other plugins are affected; the server
   * re-validates and answers 409 if a cascade was not confirmed.
   * @param {string} id
   * @param {boolean} enable
   */
  #toggle(id, enable) {
    const p = this.#byId(id)
    if (!p) return
    if (!enable) {
      const affected = p.dependents.filter(d => this.#byId(d)?.status === 'active')
      if (affected.length) {
        this.#confirm(
          `Disable ${p.name}?`,
          `${affected.length === 1 ? 'This plugin depends' : 'These plugins depend'} on ${p.name} and will be deactivated as well:`,
          affected, 'Disable all', 'danger', () => this.#apply(p, false, true))
        return
      }
      this.#apply(p, false, false)
      return
    }
    const needed = this.#requiredDisabled(p)
    if (needed.length) {
      this.#confirm(
        `Enable ${p.name}?`,
        `${p.name} requires ${needed.length === 1 ? 'a plugin that is' : 'plugins that are'} currently disabled. Enable ${needed.length === 1 ? 'it' : 'them'} as well?`,
        needed, 'Enable all', 'primary', () => this.#apply(p, true, true))
      return
    }
    this.#apply(p, true, false)
  }

  /**
   * @param {PluginAdminInfo} p
   * @returns {string[]} Explicitly disabled plugins that p depends on, directly or indirectly
   */
  #requiredDisabled(p) {
    /** @type {Set<string>} */
    const seen = new Set()
    /** @param {PluginAdminInfo} x */
    const walk = x => x.dependencies.forEach(d => {
      const dep = this.#byId(d)
      if (dep && !seen.has(d)) {
        seen.add(d)
        walk(dep)
      }
    })
    walk(p)
    return [...seen].filter(d => !this.#byId(d).enabled)
  }

  /**
   * Call the API, report the outcome and refresh the list
   * @param {PluginAdminInfo} p
   * @param {boolean} enable
   * @param {boolean} cascade
   */
  async #apply(p, enable, cascade) {
    try {
      const requestBody = { cascade }
      const result = enable
        ? await this.#api.pluginsAdminEnable(p.id, requestBody)
        : await this.#api.pluginsAdminDisable(p.id, requestBody)
      this.#reloadPending = true
      const others = Object.keys(result.changed).filter(id => id !== p.id).length
      const errors = Object.entries(result.errors)
      if (errors.length) {
        notify(`${p.name}: ${errors.map(([id, m]) => `${id}: ${m}`).join('; ')}`, 'danger', 'exclamation-octagon', 8000)
      } else {
        notify(`${enable ? 'Enabled' : 'Disabled'} ${p.name}` + (others ? ` and ${others} other plugin${others > 1 ? 's' : ''}` : ''), 'success', 'check-circle')
      }
    } catch (error) {
      this.#logger.error('Plugin change failed: ' + String(error))
      notify(`Could not ${enable ? 'enable' : 'disable'} ${p.name}: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
    }
    try {
      await this.#load()
    } catch (error) {
      this.#logger.error('Failed to refresh plugin list: ' + String(error))
    }
    this.#render()
  }
}

export { PluginAdminPlugin }
export default PluginAdminPlugin

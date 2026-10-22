/**
 * Plugin Manager UI
 *
 * Admin-only dialog (Tools menu, "Administration") to inspect backend plugins and
 * enable/disable them at runtime, with dependency cascade warnings. If the operator
 * enabled runtime install (PTE_PLUGIN_INSTALL), the "Available" tab lists the plugins
 * of the plugin repositories for installation and upgrade; upgrades and removals
 * take effect after the server processes restart ("Apply plugin changes").
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { pluginAdminDialogPart } from '../templates/plugin-admin-dialog.types.js'
 * @import { pluginAdminConfirmDialogPart } from '../templates/plugin-admin-confirm-dialog.types.js'
 * @import { AvailablePlugin, AvailablePluginsResponse, ChangeResult, InstallErrorDetail, PluginAdminInfo, PropagationInfo } from '../modules/api-client-v1.js'
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
// <sl-icon name="arrow-repeat"></sl-icon>
// <sl-icon name="arrow-clockwise"></sl-icon>
// <sl-icon name="trash"></sl-icon>
// <sl-icon name="download"></sl-icon>

/** @type {Record<string, string>} */
const STATUS_LABELS = { active: 'Active', disabled: 'Disabled', inactive: 'Inactive', unavailable: 'Unavailable', incompatible: 'Incompatible', failed: 'Failed' }
/** @type {Record<string, string>} */
const STATUS_VARIANTS = { active: 'success', disabled: 'neutral', inactive: 'warning', unavailable: 'warning', incompatible: 'danger', failed: 'danger' }
const STATUS_ORDER = ['all', 'active', 'disabled', 'inactive', 'unavailable', 'incompatible', 'failed']

// Waiting for the other server worker processes to apply a change (they check every 2 s)
const PROPAGATION_POLL_MS = 1000
const PROPAGATION_TIMEOUT_MS = 20000

// Waiting for the server processes to restart one after the other
const RESTART_POLL_MS = 2000
const RESTART_TIMEOUT_MS = 120000

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
    super(context, { name: 'plugin-admin', deps: ['client', 'tools', 'logger', 'services'] })
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

  /** @type {PropagationInfo | null} */
  #propagation = null

  /** @type {(() => void) | null} */
  #onConfirm = null

  /** Text the user must type to enable the OK button of the confirmation dialog, or null */
  #confirmExpected = null

  /** @type {AvailablePluginsResponse | null} */
  #available = null

  /** Whether the operator enabled runtime install */
  #installEnabled = false

  /** Whether the server can restart its worker processes itself */
  #restartSupported = false

  /** @returns {pluginAdminDialogPart['tabs']['installedPanel']} */
  get #installedUi() { return this.#dialogUi.tabs.installedPanel }

  /** @returns {pluginAdminDialogPart['tabs']['availablePanel']} */
  get #availableUi() { return this.#dialogUi.tabs.availablePanel }

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    this.#logger.debug(`Installing plugin "plugin-admin"`)

    this.#dialogUi = this.createUi(createSingleFromTemplate('plugin-admin-dialog', document.body))
    this.#confirmUi = this.createUi(createSingleFromTemplate('plugin-admin-confirm-dialog', document.body))

    this.#dialogUi.closeBtn.addEventListener('click', () => this.#dialogUi.hide())
    // Other clients reload when the plugins change; this one waits until the dialog is closed
    const services = this.getDependency('services')
    this.#dialogUi.addEventListener('sl-show', e => {
      if (e.target === this.#dialogUi) services.holdServerChangeReload(true)
    })
    this.#dialogUi.addEventListener('sl-after-hide', e => {
      if (e.target === this.#dialogUi) services.holdServerChangeReload(false)
    })
    this.#installedUi.searchInput.addEventListener('sl-input', () => this.#render())
    this.#dialogUi.reloadBanner.reloadBtn.addEventListener('click', () => window.location.reload())
    this.#dialogUi.restartBanner.restartBtn.addEventListener('click', () => this.#confirmRestart())

    this.#installedUi.statusChips.addEventListener('click', e => {
      const chip = /** @type {HTMLElement} */ (e.target).closest('[data-status]')
      if (chip instanceof HTMLElement) {
        this.#statusFilter = chip.dataset.status
        this.#render()
      }
    })
    this.#installedUi.pluginList.addEventListener('sl-change', e => {
      const sw = /** @type {HTMLElement} */ (e.target).closest('sl-switch')
      if (sw instanceof HTMLElement) this.#toggle(sw.dataset.id, /** @type {any} */ (sw).checked)
    })
    this.#installedUi.pluginList.addEventListener('click', e => {
      const target = /** @type {HTMLElement} */ (e.target)
      const link = target.closest('[data-go]')
      if (link instanceof HTMLElement) this.#goTo(link.dataset.go)
      const remove = target.closest('[data-remove]')
      if (remove instanceof HTMLElement) this.#confirmRemove(remove.dataset.remove)
    })

    this.#dialogUi.tabs.addEventListener('sl-tab-show', e => {
      if (/** @type {CustomEvent} */ (e).detail.name === 'available' && !this.#available) this.#loadAvailable(false)
    })
    this.#availableUi.availableSearch.addEventListener('sl-input', () => this.#renderAvailable())
    this.#availableUi.refreshBtn.addEventListener('click', () => this.#loadAvailable(true))
    this.#availableUi.availableList.addEventListener('click', e => {
      const button = /** @type {HTMLElement} */ (e.target).closest('[data-install]')
      if (button instanceof HTMLElement) this.#confirmInstall(button.dataset.repo, button.dataset.install)
    })

    this.#confirmUi.confirmInput.addEventListener('sl-input', () => {
      this.#confirmUi.okBtn.disabled = this.#confirmUi.confirmInput.value.trim() !== this.#confirmExpected
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
    this.#propagation = response.propagation
    this.#installEnabled = response.install_enabled
    this.#restartSupported = response.restart_supported
  }

  /**
   * Load the plugins of the plugin repositories and show them in the "Available" tab
   * @param {boolean} refresh - Read the repositories again instead of using the server's cache
   */
  async #loadAvailable(refresh) {
    const ui = this.#availableUi
    ui.refreshBtn.loading = true
    ui.availableNote.textContent = 'Reading the plugin repositories…'
    try {
      this.#available = await this.#api.pluginsAdminAvailable({ refresh })
    } catch (error) {
      this.#logger.error('Failed to load available plugins: ' + String(error))
      ui.availableNote.textContent = `Could not read the plugin repositories: ${error instanceof Error ? error.message : error}`
      return
    } finally {
      ui.refreshBtn.loading = false
    }
    this.#renderAvailable()
  }

  /**
   * Poll the plugin list until all server worker processes have applied a change
   * (each worker checks the shared plugin state every few seconds)
   * @param {number} generation - Generation of the change
   */
  async #awaitPropagation(generation) {
    const deadline = Date.now() + PROPAGATION_TIMEOUT_MS
    while (Date.now() < deadline) {
      await this.#load()
      const prop = this.#propagation
      if (!prop || prop.generation !== generation || prop.pending === 0) return
      this.#render()
      await new Promise(resolve => setTimeout(resolve, PROPAGATION_POLL_MS))
    }
    this.#logger.warn(`Plugin change ${generation} has not reached all server processes within ${PROPAGATION_TIMEOUT_MS} ms`)
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
    const ui = this.#installedUi
    /** @type {Record<string, number>} */
    const counts = { all: this.#plugins.length }
    for (const p of this.#plugins) counts[p.status] = (counts[p.status] || 0) + 1
    this.#dialogUi.summary.textContent = `${counts.active || 0} of ${this.#plugins.length} plugins active`
    this.#dialogUi.tabs.availableTab.style.display = this.#installEnabled ? '' : 'none'

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
    const banner = this.#dialogUi.reloadBanner
    banner.style.display = this.#reloadPending ? '' : 'none'
    const prop = this.#propagation
    banner.bannerText.textContent = prop && prop.pending > 0
      ? `Applying the change to all server processes (${prop.workers - prop.pending} of ${prop.workers} done)…`
      : 'Changes apply to open pages after a reload.'

    const restart = this.#dialogUi.restartBanner
    const restartPending = prop ? prop.restart_pending : 0
    restart.style.display = restartPending > 0 ? '' : 'none'
    restart.restartBtn.style.display = this.#restartSupported ? '' : 'none'
    restart.restartText.textContent = this.#restartSupported
      ? `Plugin upgrades and removals take effect after the server processes restart (${restartPending} of ${prop?.workers ?? 1} still running the previous code).`
      : 'Plugin upgrades and removals take effect after the server is restarted.'
  }

  /** Render the "Available" tab */
  #renderAvailable() {
    const ui = this.#availableUi
    const data = this.#available
    if (!data) return
    const owners = data.trusted_owners.join(', ') || 'none'
    const errors = Object.entries(data.errors)
    ui.availableNote.innerHTML = `Plugins run on the server with access to all documents, users and stored credentials. Trusted owners: ${esc(owners)}.`
      + (data.trusted_only ? ' Plugins of other owners are hidden.' : ' Plugins of other owners are marked unverified.')
      + errors.map(([source, message]) => `<div style="color: var(--sl-color-danger-700); margin-top: 0.25rem;">${esc(source)}: ${esc(message)}</div>`).join('')
    const q = ui.availableSearch.value.trim().toLowerCase()
    const rows = data.plugins.filter(p => !q || `${p.id} ${p.description} ${p.repository}`.toLowerCase().includes(q))
    ui.availableList.innerHTML = rows.length
      ? rows.map(p => this.#availableRowHtml(p)).join('')
      : '<div style="padding: 1.5rem; text-align: center; color: var(--sl-color-neutral-600);">No installable plugins found.</div>'
  }

  /**
   * @param {AvailablePlugin} p
   * @returns {string}
   */
  #availableRowHtml(p) {
    const installed = p.installed_version
    let action = ''
    if (p.installable && !installed) {
      action = `<sl-button size="small" variant="primary" data-install="${esc(p.id)}" data-repo="${esc(p.repository)}"><sl-icon slot="prefix" name="download"></sl-icon>Install v${esc(p.latest_version ?? '')}</sl-button>`
    } else if (p.installable && p.update_available) {
      action = `<sl-button size="small" variant="primary" data-install="${esc(p.id)}" data-repo="${esc(p.repository)}"><sl-icon slot="prefix" name="download"></sl-icon>Upgrade to v${esc(p.latest_version ?? '')}</sl-button>`
    }
    const reason = !p.latest_version
      ? 'No release with a wheel'
      : p.unmet_requirements.length
        ? `Needs packages that are not installed on the server (${p.unmet_requirements.join(', ')}); install it with uv sync`
        : p.incompatible_reason
    return `<div data-available="${esc(p.id)}" style="display: grid; grid-template-columns: 1fr auto; gap: 0.75rem; padding: 0.85rem 1rem; border-bottom: 1px solid var(--sl-color-neutral-200);">
      <div>
        <div style="display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap;">
          <strong>${esc(p.id)}</strong>${p.latest_version ? `<small>v${esc(p.latest_version)}</small>` : ''}
          ${p.trusted ? '<sl-badge variant="success" pill>Trusted</sl-badge>' : '<sl-badge variant="warning" pill>Unverified</sl-badge>'}
          ${installed ? `<sl-badge variant="neutral" pill>Installed v${esc(installed)}</sl-badge>` : ''}
          ${p.update_available ? '<sl-badge variant="primary" pill>Update available</sl-badge>' : ''}
        </div>
        <div style="color: var(--sl-color-neutral-600); margin-top: 0.15rem;">${esc(p.description)}</div>
        ${reason && !(installed && !p.update_available && p.compatible) ? `<div style="font-size: 0.85em; margin-top: 0.3rem; color: var(--sl-color-warning-700);">${esc(reason)}</div>` : ''}
        <div style="margin-top: 0.3rem; font-size: 0.8em; color: var(--sl-color-neutral-500); display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <a href="https://github.com/${esc(p.repository)}" target="_blank" rel="noopener">${esc(p.repository)}</a>
          ${p.requires.length ? `<span>requires ${p.requires.map(esc).join(', ')}</span>` : ''}
        </div>
      </div>
      <div style="align-self: start;">${action}</div>
    </div>`
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
    const reasonColor = ['failed', 'incompatible'].includes(p.status) ? 'danger' : 'warning'
    return `<div id="plugin-row-${esc(p.id)}" style="display: grid; grid-template-columns: 3rem 1fr auto; gap: 0.75rem; padding: 0.85rem 1rem; border-bottom: 1px solid var(--sl-color-neutral-200);">
      <sl-switch style="align-self: start; justify-self: start; margin-top: 0.15rem;" data-id="${esc(p.id)}" ${p.enabled && !['unavailable', 'incompatible', 'failed'].includes(p.status) ? 'checked' : ''} ${canToggle ? '' : 'disabled'} title="${p.protected ? 'Protected plugin, cannot be disabled' : ''}"></sl-switch>
      <div style="${dim}">
        <div style="display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap;">
          <strong>${esc(p.name)}</strong><small>v${esc(p.version)}</small>
          <sl-badge variant="${STATUS_VARIANTS[p.status]}" pill>${STATUS_LABELS[p.status]}</sl-badge>
          ${p.protected ? '<sl-badge variant="neutral" pill>Protected</sl-badge>' : ''}
          ${p.restart_pending ? '<sl-badge variant="primary" pill>Restart pending</sl-badge>' : ''}
        </div>
        <div style="color: var(--sl-color-neutral-600); margin-top: 0.15rem;">${esc(p.description)}</div>
        ${p.status_reason ? `<div style="font-size: 0.85em; margin-top: 0.3rem; color: var(--sl-color-${reasonColor}-700);">${esc(p.status_reason)}</div>` : ''}
        ${p.dependencies.length || directDependents.length ? `<div style="margin-top: 0.4rem; display: flex; gap: 0.25rem 1rem; flex-wrap: wrap; font-size: 0.85em; color: var(--sl-color-neutral-600); align-items: center;">
          ${p.dependencies.length ? `<span>Requires ${chips(p.dependencies)}</span>` : ''}
          ${directDependents.length ? `<span>Required by ${chips(directDependents)}</span>` : ''}</div>` : ''}
        <div style="margin-top: 0.3rem; font-size: 0.8em; color: var(--sl-color-neutral-500); display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <span>${esc(p.category)}</span><span>${p.source === 'site' ? `installed from ${esc(p.installed_from ?? '')}` : p.source === 'external' ? 'external' : 'built-in'}</span>${p.requires_pte ? `<span>requires PDF-TEI-Editor ${esc(p.requires_pte)}</span>` : ''}
          <span>${p.menu_endpoints} menu ${p.menu_endpoints === 1 ? 'item' : 'items'}</span>${p.has_frontend_extension ? '<span>frontend extension</span>' : ''}
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.35rem; align-items: flex-end;">
        ${p.readme_url ? `<sl-button size="small" href="${esc(p.readme_url)}" target="_blank" rel="noopener"><sl-icon slot="prefix" name="book"></sl-icon>README</sl-button>` : ''}
        ${p.removable ? `<sl-button size="small" data-remove="${esc(p.id)}"><sl-icon slot="prefix" name="trash"></sl-icon>Remove</sl-button>` : ''}
      </div>
    </div>`
  }

  /**
   * Clear filters, scroll to a plugin row and highlight it briefly
   * @param {string} id
   */
  #goTo(id) {
    this.#statusFilter = 'all'
    this.#installedUi.searchInput.value = ''
    this.#render()
    const row = this.#installedUi.pluginList.querySelector(`#plugin-row-${CSS.escape(id)}`)
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
   * @param {string | null} [expected] - Text the user must type to confirm
   */
  #confirm(title, text, ids, okLabel, variant, onOk, expected = null) {
    const c = this.#confirmUi
    this.#confirmExpected = expected
    c.confirmInput.value = ''
    c.confirmInput.style.display = expected ? '' : 'none'
    c.confirmInput.placeholder = expected ?? ''
    c.okBtn.disabled = Boolean(expected)
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
    /** @type {ChangeResult | null} */
    let result = null
    try {
      const requestBody = { cascade }
      result = enable
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
      if (result) {
        await this.#awaitPropagation(result.generation)
      } else {
        await this.#load()
      }
    } catch (error) {
      this.#logger.error('Failed to refresh plugin list: ' + String(error))
    }
    this.#render()
  }

  /**
   * Ask for confirmation and install or upgrade a plugin from the "Available" tab
   * @param {string} repository
   * @param {string} id
   */
  #confirmInstall(repository, id) {
    const p = this.#available?.plugins.find(x => x.id === id && x.repository === repository)
    if (!p || !p.latest_version) return
    const version = p.latest_version
    const upgrade = Boolean(p.installed_version)
    const text = (upgrade
      ? `Upgrade ${id} from v${p.installed_version} to v${version} (${repository})? If the plugin is in use, the new version takes effect after the server processes restart.`
      : `Install ${id} v${version} from ${repository}? Plugins run on the server with access to all documents, users and stored credentials. The plugin is installed disabled; enable it in the "Installed" tab.`)
      + (p.trusted ? '' : ` ${repository} does not belong to a trusted owner. Type the repository name to confirm.`)
    this.#confirm(`${upgrade ? 'Upgrade' : 'Install'} ${id}?`, text, [], upgrade ? 'Upgrade' : 'Install', p.trusted ? 'primary' : 'danger',
      () => this.#install(p, version), p.trusted ? null : repository)
  }

  /**
   * @param {AvailablePlugin} p
   * @param {string} version
   */
  async #install(p, version) {
    try {
      const result = await this.#api.pluginsAdminInstall({
        repository: p.repository, id: p.id, version, confirm: p.trusted ? undefined : p.repository
      })
      notify(`${result.action === 'upgrade' ? 'Upgraded' : 'Installed'} ${p.id} v${result.version}`
        + (result.restart_required ? '; apply the plugin changes to use the new version' : result.action === 'install' ? '; enable it in the "Installed" tab' : ''),
      'success', 'check-circle', 6000)
    } catch (error) {
      this.#logger.error('Plugin install failed: ' + String(error))
      /** @type {InstallErrorDetail | undefined} */
      const detail = /** @type {any} */ (error)?.detail
      const unmet = detail?.unmet?.length ? ` Missing: ${detail.unmet.join(', ')}` : ''
      notify(`Could not install ${p.id}: ${error instanceof Error ? error.message : error}.${unmet}`, 'danger', 'exclamation-octagon', 12000)
    }
    await this.#refreshAll()
  }

  /**
   * Ask for confirmation and remove a plugin installed in the plugin manager
   * @param {string} id
   */
  #confirmRemove(id) {
    const p = this.#byId(id)
    if (!p) return
    const affected = p.dependents.filter(d => this.#byId(d)?.status === 'active')
    const text = `Remove ${p.name} (installed from ${p.installed_from})? It is disabled now and its files are deleted when the server processes restart.`
      + (affected.length ? ` ${affected.length === 1 ? 'This plugin depends' : 'These plugins depend'} on it and will be deactivated as well:` : '')
    this.#confirm(`Remove ${p.name}?`, text, affected, 'Remove', 'danger', () => this.#remove(p, affected.length > 0))
  }

  /**
   * @param {PluginAdminInfo} p
   * @param {boolean} cascade
   */
  async #remove(p, cascade) {
    try {
      const result = await this.#api.pluginsAdminRemove(p.id, { cascade })
      this.#reloadPending = true
      notify(`Removed ${p.name}` + (result.restart_required ? '; apply the plugin changes to unload it' : ''), 'success', 'check-circle')
    } catch (error) {
      this.#logger.error('Plugin removal failed: ' + String(error))
      notify(`Could not remove ${p.name}: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
    }
    await this.#refreshAll()
  }

  /** Ask for confirmation and restart the server's worker processes */
  #confirmRestart() {
    this.#confirm('Apply plugin changes?',
      'The server processes restart one after the other. Requests are still answered during the restart, but jobs running in a restarting process (for example a batch extraction) are interrupted, and open pages reconnect.',
      [], 'Restart', 'danger', () => this.#restart())
  }

  /** Restart the worker processes and wait until none runs the previous plugin code */
  async #restart() {
    const button = this.#dialogUi.restartBanner.restartBtn
    button.loading = true
    try {
      await this.#api.pluginsAdminRestart()
      const deadline = Date.now() + RESTART_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, RESTART_POLL_MS))
        try {
          await this.#load()
        } catch {
          continue // the process answering may be restarting
        }
        this.#render()
        if (this.#propagation && this.#propagation.restart_pending === 0) break
      }
      this.#reloadPending = true
      notify('Plugin changes applied', 'success', 'check-circle')
    } catch (error) {
      this.#logger.error('Restart failed: ' + String(error))
      notify(`Could not restart the server processes: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
    } finally {
      button.loading = false
    }
    await this.#refreshAll()
  }

  /** Reload the installed and (if shown before) the available plugins */
  async #refreshAll() {
    try {
      await this.#load()
      if (this.#available) {
        this.#available = await this.#api.pluginsAdminAvailable({ refresh: false })
        this.#renderAvailable()
      }
    } catch (error) {
      this.#logger.error('Failed to refresh plugin lists: ' + String(error))
    }
    this.#render()
  }
}

export { PluginAdminPlugin }
export default PluginAdminPlugin

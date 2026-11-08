/**
 * Access tokens plugin: lets reviewers and admins create, list and revoke personal access tokens,
 * which scripts use instead of a username and password to call the API (`POST /api/v1/auth/token-login`).
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { UserData } from './authentication.js'
 * @import { SlDialog } from '../ui.js'
 * @import { accessTokensDialogPart } from '../templates/access-tokens-dialog.types.js'
 * @import { AccessTokenInfo, EligibleUser } from '../modules/api-client-v1.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { userHasRole, userIsAdmin } from '../modules/acl-utils.js'

await registerTemplate('access-tokens-dialog', 'access-tokens-dialog.html')
await registerTemplate('access-tokens-menu-item', 'access-tokens-menu-item.html')

/** Expiry choices in days; the first entry with `default` is preselected */
const EXPIRY_CHOICES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days', default: true },
  { days: 365, label: '1 year' },
]

/** Value of the "No expiry" option (admins only) */
const NO_EXPIRY = 'never'

class AccessTokensPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'access-tokens', deps: ['client', 'toolbar', 'dialog', 'config'] })
  }

  static extensionPoints = [ep.toolbar.menuItems];

  /**
   * Extension point handler for `ep.toolbar.menuItems`.
   * Called by ToolbarPlugin during start() to collect the user menu items; the item is placed below "API Keys".
   * Delegates to {@link AccessTokensPlugin#menuItems}.
   * @returns {Array<{element: HTMLElement, after: string}>}
   */
  [ep.toolbar.menuItems]() {
    return this.menuItems()
  }

  get #client() { return this.getDependency('client') }

  get #dialog() { return this.getDependency('dialog') }

  get #config() { return this.getDependency('config') }

  /** @type {SlDialog & accessTokensDialogPart} */
  #dialogUi = null

  /** @type {HTMLElement} */
  #menuItem = null

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState)
    this.#dialogUi = this.createUi(createSingleFromTemplate('access-tokens-dialog', document.body))
    this.#menuItem = createSingleFromTemplate('access-tokens-menu-item')
    this.#menuItem.addEventListener('click', () => this.show())
    this.#updateMenuItem(initialState.user)

    const ui = this.#dialogUi
    ui.closeBtn.addEventListener('click', () => ui.hide())
    ui.createForm.addEventListener('submit', event => {
      event.preventDefault()
      this.#create()
    })
    ui.createForm.userSelect.addEventListener('sl-change', () => this.#updateAttributionNote())
    const { newTokenInput, envLineInput } = ui.newTokenPanel
    newTokenInput.copyTokenBtn.addEventListener('click', () => this.#copy(newTokenInput.value))
    envLineInput.copyEnvLineBtn.addEventListener('click', () => this.#copy(envLineInput.value))
  }

  /**
   * The user menu items of the plugin.
   * @returns {Array<{element: HTMLElement, after: string}>}
   */
  menuItems() {
    return [{ element: this.#menuItem, after: 'apiKeysMenuItem' }]
  }

  /**
   * Show or hide the menu item when the user changes.
   * @param {UserData|null} newUser
   */
  async onUserChange(newUser) {
    this.#updateMenuItem(newUser)
  }

  /** Open the dialog with the current tokens and an empty "New token" form */
  async show() {
    const ui = this.#dialogUi
    ui.errorMessage.style.display = 'none'
    ui.newTokenPanel.style.display = 'none'
    ui.newTokenPanel.newTokenInput.value = ''
    ui.newTokenPanel.envLineInput.value = ''
    ui.createForm.labelInput.value = ''
    await this.#run(async () => {
      const [users] = await Promise.all([
        this.#client.apiClient.authTokenEligibleUsers(),
        this.#populateExpiry(),
        this.#loadTokens(),
      ])
      this.#populateUsers(users)
    })
    ui.show()
  }

  /** @param {UserData|null} user */
  #updateMenuItem(user) {
    this.#menuItem.style.display = userHasRole(user, ['reviewer', 'admin']) ? '' : 'none'
  }

  /** @returns {string} */
  #currentUsername() {
    return this.state?.user?.username ?? ''
  }

  /** @param {EligibleUser[]} users */
  #populateUsers(users) {
    const select = this.#dialogUi.createForm.userSelect
    select.replaceChildren()
    for (const user of users) {
      const option = document.createElement('sl-option')
      option.value = user.username
      option.textContent = user.fullname ? `${user.fullname} (${user.username})` : user.username
      select.append(option)
    }
    select.value = this.#currentUsername()
    // Only offer the choice if there is one
    select.style.display = users.length > 1 ? '' : 'none'
    this.#updateAttributionNote()
  }

  async #populateExpiry() {
    const select = this.#dialogUi.createForm.expirySelect
    const admin = userIsAdmin(this.state?.user ?? null)
    const maxDays = admin ? Infinity : Number(await this.#config.get('auth.access-tokens.max-days', 365))
    const allowNoExpiry = admin && Boolean(await this.#config.get('auth.access-tokens.allow-no-expiry', false))
    const choices = EXPIRY_CHOICES.filter(c => c.days <= maxDays)
    select.replaceChildren()
    for (const choice of choices) {
      const option = document.createElement('sl-option')
      option.value = String(choice.days)
      option.textContent = choice.label
      select.append(option)
    }
    if (allowNoExpiry) {
      const option = document.createElement('sl-option')
      option.value = NO_EXPIRY
      option.textContent = 'No expiry'
      select.append(option)
    }
    const preselected = choices.find(c => c.default) ?? choices[choices.length - 1]
    select.value = preselected ? String(preselected.days) : NO_EXPIRY
  }

  #updateAttributionNote() {
    const { userSelect } = this.#dialogUi.createForm
    const other = userSelect.value && userSelect.value !== this.#currentUsername()
    this.#dialogUi.createForm.attributionNote.style.display = other ? '' : 'none'
  }

  async #loadTokens() {
    this.#renderTokens(await this.#client.apiClient.authListTokens())
  }

  /** @param {AccessTokenInfo[]} tokens */
  #renderTokens(tokens) {
    const list = this.#dialogUi.tokenList
    list.replaceChildren()
    if (tokens.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'access-tokens-empty'
      empty.textContent = 'There are no access tokens.'
      list.append(empty)
      return
    }
    const table = document.createElement('table')
    table.className = 'access-tokens-table'
    const head = table.createTHead().insertRow()
    for (const title of ['Label', 'User', 'Created by', 'Created', 'Expires', 'Last used', '']) {
      const th = document.createElement('th')
      th.textContent = title
      head.append(th)
    }
    const body = table.createTBody()
    for (const token of tokens) {
      const row = body.insertRow()
      row.dataset.tokenId = token.token_id
      if (token.expired) row.classList.add('expired')
      const cells = [
        token.label,
        token.username,
        token.created_by,
        formatDate(token.created_at),
        token.expired ? 'Expired' : (token.expires_at ? formatDate(token.expires_at) : 'Never'),
        token.last_used_at ? formatDate(token.last_used_at) : 'Never',
      ]
      for (const text of cells) {
        row.insertCell().textContent = text
      }
      row.cells[0].title = `pte_${token.token_id}_…`
      const revoke = document.createElement('sl-button')
      revoke.setAttribute('size', 'small')
      revoke.setAttribute('variant', 'danger')
      revoke.setAttribute('outline', '')
      revoke.textContent = 'Revoke'
      revoke.addEventListener('click', () => this.#revoke(token))
      row.insertCell().append(revoke)
    }
    list.append(table)
  }

  async #create() {
    const form = this.#dialogUi.createForm
    const label = form.labelInput.value.trim()
    if (!label) {
      form.labelInput.focus()
      return
    }
    const expiry = String(form.expirySelect.value)
    const username = String(form.userSelect.value || this.#currentUsername())
    await this.#run(async () => {
      const { token, info } = await this.#client.apiClient.authCreateToken({
        label,
        username,
        expires_in_days: expiry === NO_EXPIRY ? null : Number(expiry),
      })
      const panel = this.#dialogUi.newTokenPanel
      panel.newTokenInput.value = token
      panel.envLineInput.value = `API_TOKEN=${token}`
      panel.style.display = ''
      form.labelInput.value = ''
      await this.#loadTokens()
      notify(`Created access token "${info.label}" for ${info.username}`, 'success', 'check-circle')
    })
  }

  /** @param {AccessTokenInfo} token */
  async #revoke(token) {
    const confirmed = await this.#dialog.confirm(
      `Revoke the access token "${token.label}" of ${token.username}? Scripts that use it can no longer log in, and their sessions end.`,
      'Revoke access token'
    )
    if (!confirmed) return
    await this.#run(async () => {
      await this.#client.apiClient.authRevokeToken(token.token_id)
      await this.#loadTokens()
      notify(`Revoked access token "${token.label}"`, 'success', 'check-circle')
    })
  }

  /** @param {string} text */
  async #copy(text) {
    try {
      await navigator.clipboard.writeText(text)
      notify('Copied to the clipboard', 'success', 'clipboard-check')
    } catch {
      notify('Could not copy; select the text and copy it manually', 'warning', 'exclamation-triangle')
    }
  }

  /** @param {() => Promise<void>} fn */
  async #run(fn) {
    this.#dialogUi.errorMessage.style.display = 'none'
    try {
      await fn()
    } catch (error) {
      this.#dialogUi.errorMessage.textContent = String(error instanceof Error ? error.message : error)
      this.#dialogUi.errorMessage.style.display = 'block'
    }
  }
}

/**
 * @param {number} epochSeconds
 * @returns {string}
 */
function formatDate(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default AccessTokensPlugin

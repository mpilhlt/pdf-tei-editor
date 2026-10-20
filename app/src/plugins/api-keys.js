/**
 * API keys plugin: lets users store the API keys of services that bill them (encrypted on the server),
 * and prompts for a missing key when an action needs it.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { apiKeysDialogPart } from '../templates/api-keys-dialog.types.js'
 * @import { SecretServiceResponse } from '../modules/api-client-v1.js'
 * @import { SecretRequiredDetail } from '../modules/secret-required.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { withKeyPrompt } from '../modules/secret-required.js'

await registerTemplate('api-keys-dialog', 'api-keys-dialog.html')
await registerTemplate('api-keys-menu-item', 'api-keys-menu-item.html')

class ApiKeysPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'api-keys', deps: ['client', 'toolbar'] })
  }

  static extensionPoints = [ep.toolbar.menuItems];

  /**
   * Extension point handler for `ep.toolbar.menuItems`.
   * @returns {Array<{element: HTMLElement}>}
   */
  [ep.toolbar.menuItems]() {
    return [{ element: this.#menuItem }]
  }

  get #client() { return this.getDependency('client') }

  /** @type {import('../ui.js').SlDialog & apiKeysDialogPart} */
  #dialogUi = null

  /** @type {HTMLElement} */
  #menuItem = null

  /** Resolves the pending `ensureKey()` / `show()` promise when the dialog closes
   * @type {((saved: boolean) => void)|null} */
  #resolveClose = null

  /** Whether a key was saved while the dialog was open */
  #saved = false

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState)
    this.#dialogUi = this.createUi(createSingleFromTemplate('api-keys-dialog', document.body))
    this.#menuItem = createSingleFromTemplate('api-keys-menu-item')
    this.#menuItem.addEventListener('click', () => this.show())
    this.#dialogUi.closeBtn.addEventListener('click', () => this.#dialogUi.hide())
    this.#dialogUi.addEventListener('sl-after-hide', event => {
      if (event.target !== this.#dialogUi) return
      this.#resolveClose?.(this.#saved)
      this.#resolveClose = null
    })
  }

  /**
   * Show the dialog with the keys of all services that need one.
   * @param {string=} message - Explanation shown above the list
   * @param {string=} onlyService - Show only this service
   * @returns {Promise<boolean>} Resolves when the dialog is closed; true if a key was saved
   */
  async show(message, onlyService) {
    this.#saved = false
    this.#dialogUi.errorMessage.style.display = 'none'
    this.#dialogUi.intro.textContent = message ||
      'Some features use services that are billed to you. Your keys are stored encrypted on the server and are only used for your own requests.'
    const services = (await this.#client.apiClient.secretsList()).filter(s => !onlyService || s.id === onlyService)
    this.#renderServices(services)
    this.#dialogUi.show()
    return new Promise(resolve => { this.#resolveClose = resolve })
  }

  /**
   * Ask the user for the key a failed request needed.
   * @param {SecretRequiredDetail} detail - The `detail` of the backend's `secret_required` error
   * @returns {Promise<boolean>} True if the key was saved and the request can be repeated
   */
  async promptForKey(detail) {
    const message = `${detail.label} needs your API key.` + (detail.description ? ` ${detail.description}` : '')
    return this.show(message, detail.service)
  }

  /**
   * Run an action that may need a key the user has not stored yet: if the backend answers with
   * `secret_required`, prompt for the key and run the action once more.
   * @template T
   * @param {() => Promise<T>} action
   * @param {{before?: () => void, after?: () => void}=} blocker - Called around the prompt, e.g. to lift a
   *   page blocker that would cover the dialog; `after` runs even if the prompt fails or is cancelled
   * @returns {Promise<T>}
   */
  async withKeyPrompt(action, blocker) {
    return withKeyPrompt(action, detail => this.promptForKey(detail), blocker)
  }

  /** @param {SecretServiceResponse[]} services */
  #renderServices(services) {
    const list = this.#dialogUi.serviceList
    list.replaceChildren()
    if (services.length === 0) {
      list.textContent = 'No installed feature needs an API key.'
      return
    }
    for (const service of services) {
      const row = document.createElement('div')
      row.className = 'dialog-column'
      const input = document.createElement('sl-input')
      input.setAttribute('type', 'password')
      input.setAttribute('password-toggle', '')
      input.setAttribute('size', 'small')
      input.setAttribute('label', service.label)
      input.setAttribute('autocomplete', 'off')
      input.setAttribute('placeholder', service.is_set ? 'Stored; enter a new key to replace it' : 'Enter your API key')
      const help = []
      if (service.description) help.push(service.description)
      input.setAttribute('help-text', help.join(' '))
      if (service.help_url) {
        const link = document.createElement('a')
        link.slot = 'help-text'
        link.href = service.help_url
        link.target = '_blank'
        link.rel = 'noopener'
        link.textContent = 'Get a key'
        input.removeAttribute('help-text')
        input.append(link)
      }
      const save = document.createElement('sl-button')
      save.setAttribute('variant', 'primary')
      save.setAttribute('size', 'small')
      save.textContent = 'Save'
      const remove = document.createElement('sl-button')
      remove.setAttribute('size', 'small')
      remove.textContent = 'Remove'
      remove.toggleAttribute('disabled', !service.is_set)
      const buttons = document.createElement('div')
      buttons.style.display = 'flex'
      buttons.style.gap = '0.5rem'
      buttons.append(save, remove)

      save.addEventListener('click', () => this.#save(service, input, remove))
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') this.#save(service, input, remove)
      })
      remove.addEventListener('click', async () => {
        await this.#run(async () => {
          await this.#client.apiClient.secretsDelete(service.id)
          input.setAttribute('placeholder', 'Enter your API key')
          remove.setAttribute('disabled', '')
          notify(`Removed the ${service.label} key`, 'success', 'check-circle')
        })
      })
      row.append(input, buttons)
      list.append(row)
    }
  }

  /**
   * @param {SecretServiceResponse} service
   * @param {HTMLElement & {value: string}} input
   * @param {HTMLElement} remove
   */
  async #save(service, input, remove) {
    const value = input.value.trim()
    if (!value) return
    await this.#run(async () => {
      await this.#client.apiClient.secretsSet(service.id, { value })
      input.value = ''
      input.setAttribute('placeholder', 'Stored; enter a new key to replace it')
      remove.removeAttribute('disabled')
      this.#saved = true
      notify(`Saved the ${service.label} key`, 'success', 'check-circle')
      // a prompt for one missing key is complete when it is stored
      if (this.#dialogUi.serviceList.childElementCount === 1) this.#dialogUi.hide()
    })
  }

  /** @param {() => Promise<void>} fn */
  async #run(fn) {
    this.#dialogUi.errorMessage.style.display = 'none'
    try {
      await fn()
    } catch (error) {
      this.#dialogUi.errorMessage.textContent = String(error)
      this.#dialogUi.errorMessage.style.display = 'block'
    }
  }
}

export default ApiKeysPlugin

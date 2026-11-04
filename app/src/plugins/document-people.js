/**
 * Document People Plugin
 *
 * Adds a "People" button next to "Edit header metadata" in the XML editor toolbar. It opens a
 * dialog listing the persons of `/TEI/teiHeader/fileDesc/titleStmt/respStmt` with their
 * responsibilities and the number of revisions and comments they own in the document (see
 * modules/document-people.js). Reviewers and admins can add users from the user database with a
 * responsibility (annotator, reviewer, commenter) that matches the user's roles. Each person who is
 * a user can be sent a short message, which appears in the recipient's messages and is not stored
 * in the document (`POST /api/v1/messages/direct`). See docs/user-manual/document-people.md.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { SlDialog, SlSelect, SlInput } from '../ui.js'
 * @import { User } from '../modules/api-client-v1.js'
 * @import { DocumentPerson } from '../modules/document-people.js'
 * @import { documentPeopleDialogPart } from '../templates/document-people-dialog.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { PanelUtils } from '../modules/panels/index.js'
import { prettyPrintXmlDom } from '../modules/xml-utils.js'
import { notify } from '../modules/sl-utils.js'
import { testLog } from '../modules/test-log.js'
import { readPeople, rolesForUser, canAddPeople, addPersonRole, PERSON_ROLES } from '../modules/document-people.js'
import ui from '../ui.js'

await registerTemplate('document-people-dialog', 'document-people-dialog.html')

/** Maximum length of a message */
const MAX_MESSAGE_LENGTH = 500

const CSS = `
.document-people-dialog .document-people-list { display: flex; flex-direction: column; max-height: 50vh; overflow: auto; }
.document-people-dialog .document-people-empty { color: var(--sl-color-neutral-500); padding: 8px 0; }
.document-people-row { display: grid; grid-template-columns: 1fr auto auto; gap: 4px 12px; align-items: center;
  padding: 6px 4px; border-bottom: 1px solid var(--sl-color-neutral-200); }
.document-people-row .document-people-who { min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.document-people-row .document-people-name { font-weight: var(--sl-font-weight-semibold); }
.document-people-row .document-people-id { color: var(--sl-color-neutral-500); font-size: var(--sl-font-size-x-small); }
.document-people-row .document-people-resps { display: flex; flex-wrap: wrap; gap: 4px; }
.document-people-row .document-people-counts { color: var(--sl-color-neutral-600); font-size: var(--sl-font-size-small); white-space: nowrap; }
.document-people-row .document-people-message { grid-column: 1 / 4; display: flex; gap: 6px; }
.document-people-row .document-people-message sl-input { flex: 1; }
.document-people-dialog .document-people-add { margin-top: 14px; }
.document-people-dialog .document-people-add-title { font: var(--sl-font-weight-semibold) var(--sl-font-size-small) var(--sl-font-sans); margin-bottom: 4px; }
.document-people-dialog .document-people-add-row { display: flex; gap: 8px; }
.document-people-dialog .document-people-add-row sl-select { flex: 1; }
.document-people-dialog .document-people-note { color: var(--sl-color-neutral-500); font-size: var(--sl-font-size-x-small); margin-top: 4px; }
`

class DocumentPeoplePlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    // tei-header-editor first, so that the button is placed after its button
    super(context, { name: 'document-people', deps: ['xmleditor', 'client', 'logger', 'tei-header-editor'] })
  }

  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {StatusButton} */
  #button

  /** @type {SlDialog & documentPeopleDialogPart} */
  #dialogUi

  /** @type {User[]} The users of the user database, loaded when the dialog opens */
  #users = []

  /** @type {DocumentPerson[]} */
  #people = []

  /** @type {boolean|null} Whether the teiHeader was folded when the dialog opened */
  #headerFolded = null

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.getDependency('logger').debug(`Installing plugin "${this.name}"`)
    if (!document.getElementById('document-people-style')) {
      const style = document.createElement('style')
      style.id = 'document-people-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }
    this.#button = PanelUtils.createButton({
      icon: 'people',
      tooltip: 'People involved in this document',
      name: 'documentPeopleBtn'
    })
    this.#button.dataset.testid = 'document-people-btn'
    ui.xmlEditor.toolbar.headerGroup.append(this.#button)
    this.#dialogUi = this.createUi(createSingleFromTemplate('document-people-dialog', document.body))
  }

  async start() {
    this.#button.addEventListener('widget-click', () => this.show())
    this.#dialogUi.closeBtn.addEventListener('click', () => this.#dialogUi.hide())
    this.#dialogUi.addEventListener('sl-after-hide', event => {
      // nested Shoelace elements (selects) emit their own, bubbling sl-after-hide
      if (event.target === this.#dialogUi) this.#restoreHeaderFold()
    })
    this.#dialogUi.addSection.userSelect.addEventListener('sl-change', () => this.#updateRoleSelect())
    this.#dialogUi.addSection.roleSelect.addEventListener('sl-change', () => this.#updateAddButton())
    this.#dialogUi.addSection.addBtn.addEventListener('click', () => this.#onAdd())
  }

  /**
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    this.#button.disabled = !this.state?.xml
    if (changedKeys.includes('xml') && this.#dialogUi.open) this.#dialogUi.hide()
    if (changedKeys.includes('editorReadOnly') && this.#dialogUi.open) this.#renderAddSection()
  }

  //
  // Public API
  //

  /**
   * Opens the dialog for the current document.
   * @returns {Promise<void>}
   */
  async show() {
    if (!this.state?.xml) return
    try {
      this.#users = await this.getDependency('client').apiClient.listUsers()
    } catch (error) {
      this.getDependency('logger').warn(`Cannot load the users: ${String(error)}`)
      this.#users = []
    }
    await this.#refresh()
    this.#headerFolded = this.#isHeaderFolded()
    await this.#dialogUi.show()
  }

  /**
   * Returns the people of the current document.
   * @returns {DocumentPerson[]}
   */
  getPeople() {
    const xmlDoc = this.#xmlEditor.getXmlTree()
    return xmlDoc ? readPeople(xmlDoc) : []
  }

  //
  // Rendering
  //

  async #refresh() {
    // the DOM tree is synced with a delay
    await this.#xmlEditor.sync()
    this.#people = this.getPeople()
    this.#renderList()
    this.#renderAddSection()
  }

  #renderList() {
    this.#dialogUi.peopleList.replaceChildren(...this.#people.map(person => this.#renderRow(person)))
    this.#dialogUi.emptyNote.style.display = this.#people.length ? 'none' : ''
  }

  /**
   * @param {DocumentPerson} person
   * @returns {HTMLElement}
   */
  #renderRow(person) {
    const row = document.createElement('div')
    row.className = 'document-people-row'
    row.dataset.testid = 'document-people-row'
    if (person.id) row.dataset.id = person.id

    const who = document.createElement('div')
    who.className = 'document-people-who'
    const name = document.createElement('span')
    name.className = 'document-people-name'
    name.textContent = person.name
    who.append(name)
    if (person.id && person.id !== person.name) {
      const id = document.createElement('span')
      id.className = 'document-people-id'
      id.textContent = person.id
      who.append(id)
    }
    const resps = document.createElement('span')
    resps.className = 'document-people-resps'
    for (const resp of person.responsibilities) {
      const tag = document.createElement('sl-tag')
      tag.setAttribute('size', 'small')
      tag.textContent = resp
      resps.append(tag)
    }
    who.append(resps)

    const counts = document.createElement('span')
    counts.className = 'document-people-counts'
    counts.textContent = `${plural(person.edits, 'edit')} · ${plural(person.comments, 'comment')}`
    counts.title = 'Revisions in the revision history, and comments on elements'

    const messageBtn = document.createElement('sl-icon-button')
    messageBtn.setAttribute('name', 'chat-dots')
    messageBtn.dataset.testid = 'document-people-message-btn'
    const recipient = this.#messageRecipient(person)
    messageBtn.setAttribute('label', recipient ? `Send a message to ${person.name}` : 'Not a user who can receive messages')
    messageBtn.title = messageBtn.getAttribute('label') ?? ''
    if (!recipient) messageBtn.setAttribute('disabled', '')
    messageBtn.addEventListener('click', () => this.#toggleMessageField(row, person))

    row.append(who, counts, messageBtn)
    return row
  }

  /**
   * Returns the user name a message to the person goes to, or null if the person is not a user
   * or is the current user.
   * @param {DocumentPerson} person
   * @returns {string|null}
   */
  #messageRecipient(person) {
    if (!person.id || person.id === this.state?.user?.username) return null
    return this.#users.some(u => u.username === person.id) ? person.id : null
  }

  /**
   * Shows or hides the one-line message field under a person.
   * @param {HTMLElement} row
   * @param {DocumentPerson} person
   */
  #toggleMessageField(row, person) {
    const existing = row.querySelector('.document-people-message')
    if (existing) {
      existing.remove()
      return
    }
    const recipient = this.#messageRecipient(person)
    if (!recipient) return
    const field = document.createElement('div')
    field.className = 'document-people-message'
    const input = /** @type {SlInput} */ (document.createElement('sl-input'))
    input.setAttribute('size', 'small')
    input.setAttribute('maxlength', String(MAX_MESSAGE_LENGTH))
    input.setAttribute('placeholder', `Message to ${person.name}`)
    input.dataset.testid = 'document-people-message-input'
    const send = document.createElement('sl-button')
    send.setAttribute('size', 'small')
    send.setAttribute('variant', 'primary')
    send.dataset.testid = 'document-people-message-send'
    const icon = document.createElement('sl-icon')
    icon.setAttribute('slot', 'prefix')
    icon.setAttribute('name', 'send')
    send.append(icon, 'Send')
    const submit = async () => {
      const text = String(input.value ?? '').trim()
      if (!text || !this.state?.xml) return
      try {
        await this.getDependency('client').apiClient.messagesSendDirect({ stable_id: this.state.xml, recipient, text })
      } catch (error) {
        notify(`The message could not be sent: ${String(error)}`, 'danger', 'exclamation-octagon')
        return
      }
      field.remove()
      notify(`Message sent to ${person.name}.`, 'success', 'check-circle')
      testLog('DOCUMENT_PEOPLE_MESSAGE_SENT', { recipient })
    }
    send.addEventListener('click', submit)
    input.addEventListener('keydown', event => {
      if (/** @type {KeyboardEvent} */ (event).key === 'Enter') submit()
    })
    field.append(input, send)
    row.append(field)
    setTimeout(() => input.focus(), 0)
  }

  /**
   * Shows the "Add a person" section to reviewers and admins, enabled while the document can be edited.
   */
  #renderAddSection() {
    const { addSection } = this.#dialogUi
    const { userSelect, addNote } = addSection
    const allowed = canAddPeople(this.state?.user ?? null)
    addSection.style.display = allowed ? '' : 'none'
    if (!allowed) return
    const readOnly = Boolean(this.state?.editorReadOnly)
    const previous = String(userSelect.value || '')
    const users = [...this.#users].sort((a, b) => displayName(a).localeCompare(displayName(b)))
    userSelect.replaceChildren(...users.map(user => {
      const option = document.createElement('sl-option')
      option.setAttribute('value', user.username)
      option.textContent = user.fullname && user.fullname !== user.username ? `${user.fullname} (${user.username})` : user.username
      return option
    }))
    userSelect.value = users.some(u => u.username === previous) ? previous : ''
    userSelect.disabled = readOnly || users.length === 0
    addNote.textContent = readOnly
      ? 'The document is read-only.'
      : 'The responsibilities offered are those matching the roles of the selected user.'
    this.#updateRoleSelect()
  }

  /**
   * Offers the responsibilities that the selected user's roles allow and the person does not have yet.
   */
  #updateRoleSelect() {
    const { roleSelect, userSelect } = this.#dialogUi.addSection
    const user = this.#selectedUser()
    const person = user ? this.#people.find(p => p.id === user.username) : undefined
    const has = new Set((person?.responsibilities ?? []).map(r => r.toLowerCase()))
    const roles = rolesForUser(user ? { username: user.username, fullname: user.fullname ?? '', roles: user.roles ?? ['user'] } : null)
      .filter(role => !has.has(role.resp.toLowerCase()))
    const previous = String(roleSelect.value || '')
    roleSelect.replaceChildren(...roles.map(role => {
      const option = document.createElement('sl-option')
      option.setAttribute('value', role.id)
      option.textContent = role.resp
      return option
    }))
    roleSelect.value = roles.some(r => r.id === previous) ? previous : (roles[0]?.id ?? '')
    roleSelect.disabled = userSelect.disabled || roles.length === 0
    this.#updateAddButton()
  }

  #updateAddButton() {
    const { addBtn, roleSelect } = this.#dialogUi.addSection
    addBtn.disabled = roleSelect.disabled || !roleSelect.value || !this.#selectedUser()
  }

  /** @returns {User|undefined} */
  #selectedUser() {
    const username = String(/** @type {SlSelect} */ (this.#dialogUi.addSection.userSelect).value || '')
    return username ? this.#users.find(u => u.username === username) : undefined
  }

  /**
   * @returns {boolean|null} Whether the teiHeader is folded, null without a header
   */
  #isHeaderFolded() {
    try {
      if (!this.#xmlEditor.getDomNodeByXpath(HEADER_XPATH)) return null
      return this.#xmlEditor.isFoldedByXpath(HEADER_XPATH)
    } catch {
      return null
    }
  }

  /**
   * Folds or unfolds the teiHeader as it was when the dialog opened.
   */
  #restoreHeaderFold() {
    const wanted = this.#headerFolded
    const current = this.#isHeaderFolded()
    if (wanted === null || current === null || wanted === current) return
    try {
      if (wanted) this.#xmlEditor.foldByXpath(HEADER_XPATH)
      else this.#xmlEditor.unfoldByXpath(HEADER_XPATH)
    } catch (error) {
      this.getDependency('logger').debug(`Cannot restore the header fold: ${String(error)}`)
    }
  }

  /**
   * Adds the selected user with the selected responsibility to the document and saves it.
   */
  async #onAdd() {
    if (this.state?.editorReadOnly || !canAddPeople(this.state?.user ?? null)) return
    const user = this.#selectedUser()
    const role = PERSON_ROLES.find(r => r.id === String(this.#dialogUi.addSection.roleSelect.value || ''))
    if (!user || !role) return
    const allowed = rolesForUser({ username: user.username, fullname: user.fullname ?? '', roles: user.roles ?? ['user'] })
    if (!allowed.includes(role)) {
      notify(`${displayName(user)} does not have the role required to be ${role.resp.toLowerCase()}.`, 'warning', 'exclamation-triangle')
      return
    }
    await this.#xmlEditor.sync()
    const xmlDoc = this.#xmlEditor.getXmlTree()
    if (!xmlDoc) return
    let added
    try {
      added = addPersonRole(xmlDoc, { username: user.username, fullname: user.fullname || undefined }, role)
    } catch (error) {
      notify(`The person could not be added: ${String(error)}`, 'danger', 'exclamation-octagon')
      return
    }
    if (added) {
      prettyPrintXmlDom(xmlDoc, 'teiHeader')
      // replaces only the changed ranges, so that the folds (e.g. of the teiHeader) stay
      await this.#xmlEditor.updateEditorFromXmlTree()
      this.#restoreHeaderFold()
      await this.#xmlEditor.saveIfDirty()
    }
    testLog('DOCUMENT_PEOPLE_ADDED', { username: user.username, role: role.id, added })
    this.#dialogUi.addSection.userSelect.value = ''
    await this.#refresh()
  }
}

/** XPath of the TEI header, whose fold state the dialog keeps */
const HEADER_XPATH = '//tei:teiHeader'

/**
 * @param {number} count
 * @param {string} word
 * @returns {string}
 */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * @param {User} user
 * @returns {string}
 */
function displayName(user) {
  return user.fullname || user.username
}

export default DocumentPeoplePlugin

export const plugin = DocumentPeoplePlugin

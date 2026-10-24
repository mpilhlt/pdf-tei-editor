/**
 * Messages plugin: lists the review marks and comments addressed to the current user (not-OK
 * marks on documents they own, comments that mention them or answer their threads), shows the
 * number of unread messages on the toolbar menu button, and opens a message's document with the
 * review or comment focused. See docs/user-manual/messages.md.
 *
 * The messages come from the server's message index (`/api/v1/messages`); the unread count is
 * updated live by the SSE event `messagesChanged`, or polled when SSE is disabled.
 *
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { MessageItem } from '../modules/api-client-v1.js'
 * @import { SlDialog, SlMenuItem, SlBadge, SlRadioGroup } from '../ui.js'
 * @import { messagesDialogPart } from '../templates/messages-dialog.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { renderWithMentions } from '../modules/mention-autocomplete.js'
import { testLog } from '../modules/test-log.js'

await registerTemplate('messages-dialog', 'messages-dialog.html')
await registerTemplate('messages-menu-item', 'messages-menu-item.html')

/** Messages per page */
const PAGE_SIZE = 50

/** Polling interval for the count when SSE is disabled */
const POLL_INTERVAL_MS = 60000

/** Notes on settled messages, by `settled_note` */
const SETTLED_NOTES = {
  resolved: 'resolved',
  'unit-edited': 'unit edited',
  'changed-to-ok': 'changed to OK',
  superseded: 'superseded by a newer review'
}

const CSS = `
.messages-dialog .messages-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.messages-dialog .messages-toolbar sl-button { margin-left: auto; }
.messages-dialog .messages-list { display: flex; flex-direction: column; max-height: 60vh; overflow: auto; }
.messages-dialog .messages-empty { color: var(--sl-color-neutral-500); padding: 12px 0; }
.messages-dialog .messages-more { margin-top: 8px; }
.message-row { display: grid; grid-template-columns: 12px 18px 1fr auto; gap: 8px; align-items: start; padding: 8px 6px;
  border-bottom: 1px solid var(--sl-color-neutral-200); cursor: pointer; }
.message-row:hover { background: var(--sl-color-neutral-50); }
.message-row .message-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; }
.message-row.unread .message-dot { background: var(--sl-color-primary-600); }
.message-row .message-kind { font-size: 15px; line-height: 1.2; }
.message-row .message-kind.review { color: var(--sl-color-danger-600); }
.message-row .message-kind.comment { color: var(--sl-color-primary-600); }
.message-row .message-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.message-row .message-head { display: flex; gap: 6px; align-items: baseline; font-size: 13px; }
.message-row .message-head b { font-weight: 600; }
.message-row .message-head .message-doc { color: var(--sl-color-neutral-600); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-row .message-excerpt { color: var(--sl-color-neutral-500); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-row .message-text { font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.message-row .message-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 12px; color: var(--sl-color-neutral-500); white-space: nowrap; }
.message-row .message-actions { display: flex; gap: 2px; }
.message-row.settled .message-main, .message-row.settled .message-kind { opacity: .55; }
.message-row .message-note { font-size: 11px; font-style: italic; }
.message-row .message-reply { grid-column: 3 / 5; display: flex; gap: 6px; }
.message-row .message-reply sl-input { flex: 1; }
`

class MessagesPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'messages',
      deps: ['client', 'toolbar', 'sse', 'config', 'services', 'unit-review', 'unit-comments', 'logger']
    })
  }

  static extensionPoints = [ep.toolbar.menuItems];

  /**
   * Extension point handler for `ep.toolbar.menuItems`. The item is placed below the user's name.
   * @returns {Array<{element: HTMLElement, after: string}>}
   */
  [ep.toolbar.menuItems]() {
    return [{ element: this.#menuItem, after: 'userFullnameMenuItem' }]
  }

  get #client() { return this.getDependency('client') }

  /** @type {SlDialog & messagesDialogPart} */
  #dialogUi = null

  /** @type {SlMenuItem} */
  #menuItem = null

  /** @type {SlBadge} */
  #menuBadge = null

  #unread = 0

  /** @type {MessageItem[]} */
  #items = []

  #total = 0

  /** @type {ReturnType<typeof setInterval>|undefined} */
  #pollTimer = undefined

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState)
    if (!document.getElementById('messages-style')) {
      const style = document.createElement('style')
      style.id = 'messages-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }
    this.#dialogUi = this.createUi(createSingleFromTemplate('messages-dialog', document.body))
    this.#menuItem = /** @type {SlMenuItem} */ (createSingleFromTemplate('messages-menu-item'))
    this.#menuBadge = /** @type {SlBadge} */ (this.#menuItem.querySelector('sl-badge'))
    this.#menuItem.addEventListener('click', () => this.show())
    this.#dialogUi.closeBtn.addEventListener('click', () => this.#dialogUi.hide())
    this.#dialogUi.statusFilter.addEventListener('sl-change', () => this.#reload())
    this.#dialogUi.kindFilter.addEventListener('sl-change', () => this.#reload())
    this.#dialogUi.markAllBtn.addEventListener('click', () => this.#markAllRead())
    this.#dialogUi.loadMoreBtn.addEventListener('click', () => this.#loadMore())

    const sse = this.getDependency('sse')
    sse.addEventListener('messagesChanged', (/** @type {MessageEvent} */ event) => {
      try {
        this.#setUnread(JSON.parse(event.data).unread)
      } catch {
        this.refreshCount()
      }
      if (this.#dialogUi.open) this.#reload()
    })
    // events may have been missed while disconnected
    sse.onConnectionChange((/** @type {boolean} */ connected) => { if (connected) this.refreshCount() })
  }

  async ready() {
    if (await this.getDependency('config').get('sse.enabled') === false) {
      this.#pollTimer = setInterval(() => this.refreshCount(), POLL_INTERVAL_MS)
    }
  }

  async shutdown() {
    clearInterval(this.#pollTimer)
  }

  /** @param {ApplicationState['user']} user */
  async onUserChange(user) {
    if (!user) {
      this.#setUnread(0)
      this.#dialogUi?.hide()
      return
    }
    await this.refreshCount()
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Fetches the number of unread messages and updates the badges.
   * @returns {Promise<number>}
   */
  async refreshCount() {
    if (!this.state?.user) return 0
    try {
      const { unread } = await this.#client.apiClient.messagesCount()
      this.#setUnread(unread)
    } catch (error) {
      this.getDependency('logger').debug('Cannot fetch the message count: ' + String(error))
    }
    return this.#unread
  }

  /**
   * Returns the number of unread messages last received.
   * @returns {number}
   */
  getUnreadCount() {
    return this.#unread
  }

  /**
   * Opens the Messages dialog.
   */
  async show() {
    /** @type {SlRadioGroup} */ (this.#dialogUi.statusFilter).value = this.#unread > 0 ? 'unread' : 'all'
    await this.#reload()
    this.#dialogUi.show()
  }

  /**
   * Opens a message: marks it read, opens its document and focuses the review or comment.
   * @param {MessageItem} item
   */
  async open(item) {
    this.#dialogUi.hide()
    if (!item.read) await this.#setRead([item.key], true)
    await this.getDependency('services').load({ xml: item.stable_id })
    if (this.state?.xml !== item.stable_id) return
    let found = true
    if (item.key.startsWith('c:') && item.thread_id) {
      found = this.getDependency('unit-comments').openThread(item.thread_id)
      if (!found) notify('The comment is no longer attached to an element. Detached comments are listed in the diagnostics drawer.', 'warning', 'exclamation-triangle')
    } else if (item.fingerprint) {
      const review = this.getDependency('unit-review')
      if (!review.isEnabled()) await review.setEnabled(true)
      found = await review.openReviewAtUnit(item.fingerprint)
      if (!found) notify('The reviewed unit has been edited since the review.', 'warning', 'exclamation-triangle')
    }
    testLog('MESSAGE_OPENED', { key: item.key, found })
  }

  // ── Badge ───────────────────────────────────────────────────────────

  /** @param {number} count */
  #setUnread(count) {
    this.#unread = Math.max(0, Number(count) || 0)
    this.getDependency('toolbar').setMenuButtonBadge(this.#unread)
    if (this.#menuBadge) {
      this.#menuBadge.textContent = this.#unread > 99 ? '99+' : String(this.#unread)
      // not `hidden`: the sl-badge host sets `display`
      this.#menuBadge.style.display = this.#unread === 0 ? 'none' : ''
    }
  }

  // ── List ────────────────────────────────────────────────────────────

  /** @returns {{status: 'unread'|'all', kind?: 'review'|'comment'}} */
  #filter() {
    const status = /** @type {SlRadioGroup} */ (this.#dialogUi.statusFilter).value === 'all' ? 'all' : 'unread'
    const kind = String(this.#dialogUi.kindFilter.value)
    return kind === 'review' || kind === 'comment' ? { status, kind } : { status }
  }

  async #reload() {
    try {
      const response = await this.#client.apiClient.messagesList({ ...this.#filter(), limit: PAGE_SIZE, offset: 0 })
      this.#items = response.items
      this.#total = response.total
      this.#setUnread(response.unread)
    } catch (error) {
      notify(`Cannot load the messages: ${String(error)}`, 'danger', 'exclamation-octagon')
      this.#items = []
      this.#total = 0
    }
    this.#render()
  }

  async #loadMore() {
    const response = await this.#client.apiClient.messagesList({ ...this.#filter(), limit: PAGE_SIZE, offset: this.#items.length })
    this.#items = [...this.#items, ...response.items]
    this.#total = response.total
    this.#render()
  }

  #render() {
    const list = this.#dialogUi.messageList
    list.replaceChildren(...this.#items.map(item => this.#row(item)))
    this.#dialogUi.emptyNote.style.display = this.#items.length ? 'none' : ''
    this.#dialogUi.emptyNote.textContent = this.#filter().status === 'unread' ? 'No unread messages.' : 'No messages.'
    this.#dialogUi.loadMoreBtn.style.display = this.#items.length < this.#total ? '' : 'none'
    this.#dialogUi.markAllBtn.disabled = this.#unread === 0
  }

  /**
   * @param {MessageItem} item
   * @returns {HTMLElement}
   */
  #row(item) {
    const isReview = item.key.startsWith('r:')
    const unread = !item.read && !item.settled
    const row = document.createElement('div')
    row.className = `message-row${unread ? ' unread' : ''}${item.settled ? ' settled' : ''}`
    row.dataset.testid = 'message-row'
    row.dataset.key = item.key

    const dot = document.createElement('span')
    dot.className = 'message-dot'
    const kind = document.createElement('sl-icon')
    kind.className = `message-kind ${isReview ? 'review' : 'comment'}`
    kind.setAttribute('name', isReview ? 'x-circle-fill' : 'chat-left-text')
    kind.setAttribute('label', isReview ? 'Review' : 'Comment')

    const main = document.createElement('div')
    main.className = 'message-main'
    const head = document.createElement('div')
    head.className = 'message-head'
    const author = document.createElement('b')
    author.textContent = item.author_name || item.author
    const doc = document.createElement('span')
    doc.className = 'message-doc'
    doc.textContent = `${this.#reasonText(item)} · ${item.doc_label}`
    head.append(author, doc)
    main.appendChild(head)
    if (item.excerpt) {
      const excerpt = document.createElement('div')
      excerpt.className = 'message-excerpt'
      excerpt.textContent = item.excerpt
      main.appendChild(excerpt)
    }
    if (item.text) {
      const text = document.createElement('div')
      text.className = 'message-text'
      const names = new Map(this.state?.user ? [[this.state.user.username, this.state.user.fullname || this.state.user.username]] : [])
      renderWithMentions(text, item.text, names)
      main.appendChild(text)
    }

    const side = document.createElement('div')
    side.className = 'message-side'
    const when = document.createElement('span')
    when.textContent = relativeTime(item.created_at)
    when.title = new Date(item.created_at).toLocaleString()
    side.appendChild(when)
    if (item.settled) {
      const note = document.createElement('span')
      note.className = 'message-note'
      note.textContent = SETTLED_NOTES[/** @type {keyof typeof SETTLED_NOTES} */ (item.settled_note ?? '')] ?? 'settled'
      side.appendChild(note)
    }
    const actions = document.createElement('div')
    actions.className = 'message-actions'
    if (!item.settled) {
      const toggle = document.createElement('sl-icon-button')
      toggle.setAttribute('name', item.read ? 'envelope' : 'envelope-open')
      toggle.setAttribute('label', item.read ? 'Mark as unread' : 'Mark as read')
      toggle.title = item.read ? 'Mark as unread' : 'Mark as read'
      toggle.dataset.testid = 'message-read-toggle'
      toggle.addEventListener('click', async event => {
        event.stopPropagation()
        await this.#setRead([item.key], !item.read)
        await this.#reload()
      })
      actions.appendChild(toggle)
    }
    const canReply = !item.settled && (isReview ? item.reason === 'owner' && !item.author.startsWith('llm-') : Boolean(item.thread_id))
    if (canReply) {
      const reply = document.createElement('sl-icon-button')
      reply.setAttribute('name', 'reply')
      reply.setAttribute('label', 'Reply')
      reply.title = isReview ? 'Reply with a comment on the unit' : 'Reply'
      reply.dataset.testid = 'message-reply'
      reply.addEventListener('click', event => {
        event.stopPropagation()
        if (isReview) this.#replyToReview(item)
        else this.#toggleReplyField(row, item)
      })
      actions.appendChild(reply)
    }
    side.appendChild(actions)

    row.append(dot, kind, main, side)
    row.addEventListener('click', () => this.open(item))
    return row
  }

  /**
   * @param {MessageItem} item
   * @returns {string}
   */
  #reasonText(item) {
    switch (item.reason) {
      case 'owner': return 'marked a unit not OK'
      case 'thread-author': return 'replied to your comment'
      case 'thread-mention': return 'replied in a thread you were mentioned in'
      default: return item.kind === 'mention' ? 'mentioned you in a review' : 'mentioned you'
    }
  }

  /**
   * Shows or hides an inline reply field under a comment message.
   * @param {HTMLElement} row
   * @param {MessageItem} item
   */
  #toggleReplyField(row, item) {
    const existing = row.querySelector('.message-reply')
    if (existing) {
      existing.remove()
      return
    }
    // a reply to the document that is open for editing goes into the editor, so that it is saved with it
    if (item.stable_id === this.state?.xml && !this.state?.editorReadOnly) {
      this.open(item)
      return
    }
    const field = document.createElement('div')
    field.className = 'message-reply'
    field.addEventListener('click', event => event.stopPropagation())
    const input = document.createElement('sl-input')
    input.setAttribute('size', 'small')
    input.setAttribute('placeholder', 'Reply')
    input.dataset.testid = 'message-reply-input'
    const send = document.createElement('sl-button')
    send.setAttribute('size', 'small')
    send.setAttribute('variant', 'primary')
    send.textContent = 'Send'
    const submit = async () => {
      const text = String(/** @type {any} */ (input).value ?? '').trim()
      if (!text || !item.thread_id) return
      try {
        await this.#client.apiClient.filesCommentReply(item.stable_id, item.thread_id, { text })
      } catch (error) {
        notify(`The reply could not be saved: ${String(error)}`, 'danger', 'exclamation-octagon')
        return
      }
      if (!item.read) await this.#setRead([item.key], true)
      notify('Reply sent.', 'success', 'check-circle')
      testLog('MESSAGE_REPLY_SENT', { key: item.key })
      await this.#reload()
    }
    send.addEventListener('click', submit)
    input.addEventListener('keydown', event => {
      if (/** @type {KeyboardEvent} */ (event).key === 'Enter') submit()
    })
    field.append(input, send)
    row.appendChild(field)
    setTimeout(() => /** @type {any} */ (input).focus(), 0)
  }

  /**
   * Replies to a review: opens the document and starts a comment thread on the unit that
   * mentions the reviewer.
   * @param {MessageItem} item
   */
  async #replyToReview(item) {
    await this.open(item)
    if (this.state?.xml !== item.stable_id || !item.fingerprint) return
    const unit = this.getDependency('unit-review').getUnits().find(u => u.fingerprint === item.fingerprint)
    if (unit) this.getDependency('unit-comments').addComment(unit.from, `@${item.author} `)
  }

  // ── Read state ──────────────────────────────────────────────────────

  /**
   * @param {string[]} keys
   * @param {boolean} read
   */
  async #setRead(keys, read) {
    try {
      const { unread } = await this.#client.apiClient.messagesMarkRead({ keys, read })
      this.#setUnread(unread)
    } catch (error) {
      notify(`Cannot change the message: ${String(error)}`, 'danger', 'exclamation-octagon')
    }
  }

  async #markAllRead() {
    const { unread } = await this.#client.apiClient.messagesMarkAllRead()
    this.#setUnread(unread)
    await this.#reload()
  }
}

/**
 * Formats a timestamp relative to now ("5 minutes ago").
 * @param {string} iso
 * @returns {string}
 */
function relativeTime(iso) {
  const time = new Date(iso).getTime()
  if (isNaN(time)) return ''
  const seconds = Math.round((time - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  /** @type {[Intl.RelativeTimeFormatUnit, number][]} */
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(seconds, 'second')
}

export default MessagesPlugin

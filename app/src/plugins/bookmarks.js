/**
 * Bookmarks plugin: lets users bookmark elements inside `/TEI/text` from the XML editor's context
 * menu, lists their bookmarks in a dialog opened from the user menu, and opens a bookmark's
 * document with the element selected. See docs/user-manual/bookmarks.md.
 *
 * Bookmarks are private to the user who created them and stored on the server
 * (`/api/v1/bookmarks`), not in the document, so they can also be added to documents the user
 * cannot edit. They are anchored on the element like unit comments, by its XPath and a fingerprint
 * of its content (see modules/node-anchor.js), so that the element is found again after edits.
 * The list is refreshed by the SSE event `bookmarksChanged` when another session of the user
 * changes the bookmarks.
 *
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { BookmarkItem } from '../modules/api-client-v1.js'
 * @import { SlDialog, SlMenuItem, SlRadioGroup, SlInput } from '../ui.js'
 * @import { bookmarksDialogPart } from '../templates/bookmarks-dialog.types.js'
 * @import { EditorView } from '@codemirror/view'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { EditorView as View } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { testLog } from '../modules/test-log.js'
import { relativeTime } from '../modules/relative-time.js'
import { elementAt, elementPath, resolveAnchor, FingerprintCache } from '../modules/node-anchor.js'
import { elementName } from '../modules/unit-review.js'
import { openCommentPrompt } from '../modules/unit-review-popover.js'

await registerTemplate('bookmarks-dialog', 'bookmarks-dialog.html')
await registerTemplate('bookmarks-menu-item', 'bookmarks-menu-item.html')

/** XPath prefix of the elements that can be bookmarked */
const TEXT_PATH_PREFIX = '/TEI/text/'

/** Maximum length of a bookmark title (as checked by the server) */
const TITLE_MAX_LENGTH = 200

/** Length of the element text stored with a bookmark */
const EXCERPT_LENGTH = 200

/** Length of the title proposed from the element text */
const PROPOSED_TITLE_LENGTH = 60

const CSS = `
.bookmarks-dialog .bookmarks-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.bookmarks-dialog .bookmarks-toolbar sl-input { margin-left: auto; }
.bookmarks-dialog .bookmarks-list { display: flex; flex-direction: column; max-height: 60vh; overflow: auto; }
.bookmarks-dialog .bookmarks-empty { color: var(--sl-color-neutral-500); padding: 12px 0; }
.bookmark-row { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: start; padding: 8px 6px;
  border-bottom: 1px solid var(--sl-color-neutral-200); cursor: pointer; }
.bookmark-row:hover { background: var(--sl-color-neutral-50); }
.bookmark-row .bookmark-icon { font-size: 15px; line-height: 1.2; color: var(--sl-color-primary-600); }
.bookmark-row .bookmark-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.bookmark-row .bookmark-head { display: flex; gap: 6px; align-items: baseline; font-size: 13px; min-width: 0; }
.bookmark-row .bookmark-head b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; max-width: 60%; }
.bookmark-row .bookmark-doc { color: var(--sl-color-neutral-600); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bookmark-row .bookmark-excerpt { color: var(--sl-color-neutral-500); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bookmark-row .bookmark-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 12px; color: var(--sl-color-neutral-500); white-space: nowrap; }
.bookmark-row .bookmark-actions { display: flex; gap: 2px; }
.bookmark-row.unavailable .bookmark-main, .bookmark-row.unavailable .bookmark-icon { opacity: .55; }
.bookmark-row.unavailable { cursor: default; }
.bookmark-row .bookmark-note { font-size: 11px; font-style: italic; }
.bookmark-row .bookmark-rename { grid-column: 2 / 4; display: flex; gap: 6px; }
.bookmark-row .bookmark-rename sl-input { flex: 1; }
`

class BookmarksPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'bookmarks',
      deps: ['client', 'toolbar', 'sse', 'xmleditor', 'services', 'logger']
    })
  }

  static extensionPoints = [ep.toolbar.menuItems, ep.xmlEditor.contextMenuItems];

  /**
   * Extension point handler for `ep.toolbar.menuItems`. Called by the toolbar plugin when it
   * builds the user menu; the item is placed below the Messages item.
   * Delegates to {@link BookmarksPlugin#getMenuItems}.
   * @returns {Array<{element: HTMLElement, after: string}>}
   */
  [ep.toolbar.menuItems]() { return this.getMenuItems() }

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`. Called by the xmleditor plugin
   * when it builds the editor's context menu.
   * Delegates to {@link BookmarksPlugin#getContextMenuItems}.
   * @returns {Array<{element: HTMLElement, prepend: boolean, onBeforeShow: (ctx: {readOnly: boolean, pos: number}) => void}>}
   */
  [ep.xmlEditor.contextMenuItems]() { return this.getContextMenuItems() }

  get #client() { return this.getDependency('client') }
  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {SlDialog & bookmarksDialogPart} */
  #dialogUi = null

  /** @type {SlMenuItem} */
  #menuItem = null

  /** @type {BookmarkItem[]} */
  #items = []

  #cache = new FingerprintCache()

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState)
    if (!document.getElementById('bookmarks-style')) {
      const style = document.createElement('style')
      style.id = 'bookmarks-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }
    this.#dialogUi = this.createUi(createSingleFromTemplate('bookmarks-dialog', document.body))
    this.#menuItem = /** @type {SlMenuItem} */ (createSingleFromTemplate('bookmarks-menu-item'))
    this.#menuItem.addEventListener('click', () => this.show())
    this.#dialogUi.closeBtn.addEventListener('click', () => this.#dialogUi.hide())
    this.#dialogUi.scopeFilter.addEventListener('sl-change', () => this.#reload())
    this.#dialogUi.searchInput.addEventListener('sl-input', () => this.#render())
    this.getDependency('sse').addEventListener('bookmarksChanged', () => {
      if (this.#dialogUi.open) this.#reload()
    })
  }

  /** @param {ApplicationState['user']} user */
  async onUserChange(user) {
    if (!user) {
      this.#items = []
      this.#dialogUi?.hide()
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * The "Bookmarks" entry of the user menu.
   * @returns {Array<{element: HTMLElement, after: string}>}
   */
  getMenuItems() {
    return [{ element: this.#menuItem, after: 'messagesMenuItem' }]
  }

  /**
   * The "Bookmark…" entry at the top of the editor's context menu, for the right-clicked element.
   * It is disabled outside `/TEI/text`.
   * @returns {Array<{element: HTMLElement, prepend: boolean, onBeforeShow: (ctx: {readOnly: boolean, pos: number}) => void}>}
   */
  getContextMenuItems() {
    let pos = 0
    const item = document.createElement('sl-menu-item')
    item.dataset.testid = 'bookmark-menu-item'
    item.innerHTML = '<sl-icon slot="prefix" name="bookmark-plus"></sl-icon>Bookmark…'
    item.title = 'Bookmark the element you right-clicked. Your bookmarks are only visible to you and are listed under Bookmarks in the user menu.'
    item.addEventListener('click', () => this.addBookmark(pos))
    /** @param {{readOnly: boolean, pos: number}} ctx */
    const onBeforeShow = ctx => {
      pos = ctx.pos
      const visible = Boolean(this.state?.user && this.state?.xml)
      item.hidden = !visible
      if (visible) item.disabled = this.#bookmarkableAt(pos) === null
    }
    return [{ element: item, prepend: true, onBeforeShow }]
  }

  /**
   * Asks for a title and bookmarks the element at a position, which must be inside `/TEI/text`.
   * @param {number} [pos] - Document position, default: the cursor
   */
  addBookmark(pos) {
    const view = this.#view()
    const stableId = this.state?.xml
    if (!stableId) return
    const at = pos ?? view.state.selection.main.head
    const target = this.#bookmarkableAt(at)
    if (!target) {
      notify('Place the cursor in an element inside the text to bookmark it.', 'primary', 'info-circle')
      return
    }
    const coords = view.coordsAtPos(target.from)
    if (!coords) return
    const line = view.state.doc.lineAt(target.from).number
    const proposed = target.excerpt.length > PROPOSED_TITLE_LENGTH
      ? target.excerpt.slice(0, PROPOSED_TITLE_LENGTH - 1).trimEnd() + '…'
      : target.excerpt
    openCommentPrompt({ left: coords.left, bottom: coords.bottom }, `Bookmark <${target.element}> · line ${line}`, proposed, async title => {
      view.focus()
      if (!title) return
      try {
        const bookmark = await this.#client.apiClient.bookmarksCreate({
          stable_id: stableId,
          path: target.path,
          fingerprint: target.fingerprint,
          element: target.element,
          title,
          excerpt: target.excerpt || null
        })
        notify(`Bookmark "${bookmark.title}" added.`, 'success', 'bookmark-check')
        testLog('BOOKMARK_ADDED', { id: bookmark.id, path: bookmark.path, title: bookmark.title })
      } catch (error) {
        notify(`The bookmark could not be saved: ${String(error)}`, 'danger', 'exclamation-octagon')
      }
    }, { placeholder: 'Bookmark title', hint: 'Enter: save · Esc: cancel', testid: 'bookmark-prompt', maxLength: TITLE_MAX_LENGTH, selectAll: true })
  }

  /**
   * Opens the Bookmarks dialog.
   */
  async show() {
    const scope = /** @type {SlRadioGroup} */ (this.#dialogUi.scopeFilter)
    // only the bookmarks of the open document if it has some
    scope.value = 'all'
    if (this.state?.xml) {
      try {
        const { items } = await this.#client.apiClient.bookmarksList({ stable_id: this.state.xml })
        if (items.length) scope.value = 'document'
      } catch { /* the reload below reports the error */ }
    }
    this.#setScopeEnabled()
    await this.#reload()
    this.#dialogUi.show()
  }

  /**
   * Opens a bookmark: loads its document and selects the bookmarked element.
   * @param {BookmarkItem} item
   * @returns {Promise<boolean>} False if the document or the element was not found
   */
  async open(item) {
    if (!item.available) {
      notify('The document of this bookmark was deleted or you can no longer view it.', 'warning', 'exclamation-triangle')
      return false
    }
    this.#dialogUi.hide()
    if (this.state?.xml !== item.stable_id) {
      await this.getDependency('services').load({ xml: item.stable_id })
    }
    if (this.state?.xml !== item.stable_id) return false
    const view = this.#view()
    const element = resolveAnchor(view.state, { path: item.path, fingerprint: item.fingerprint ?? null }, this.#cache)
    const found = element !== null
    if (element) {
      view.dispatch({
        selection: EditorSelection.range(element.from, element.to),
        effects: View.scrollIntoView(element.from, { y: 'center' })
      })
      view.focus()
    } else {
      notify('The bookmarked element was not found in the document. It may have been removed.', 'warning', 'exclamation-triangle')
    }
    testLog('BOOKMARK_OPENED', { id: item.id, found, from: element?.from ?? null, to: element?.to ?? null, match: element?.match ?? null })
    return found
  }

  // ── Editor ──────────────────────────────────────────────────────────

  /** @returns {EditorView} */
  #view() {
    return this.#xmlEditor.getView()
  }

  /**
   * Returns the element at a position that can be bookmarked (inside `/TEI/text`), or null.
   * @param {number} pos
   * @returns {{from: number, path: string, fingerprint: string, element: string, excerpt: string}|null}
   */
  #bookmarkableAt(pos) {
    const view = this.#view()
    if (!view) return null
    const node = elementAt(view.state, pos)
    if (!node) return null
    const read = (/** @type {number} */ from, /** @type {number} */ to) => view.state.doc.sliceString(from, to)
    const path = elementPath(node, read)
    if (!path.startsWith(TEXT_PATH_PREFIX)) return null
    const excerpt = read(node.from, Math.min(node.to, node.from + EXCERPT_LENGTH * 4))
      .replace(/^<[^>]*>/, '')
      .replace(/<[^>]*>?/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, EXCERPT_LENGTH)
    return { from: node.from, path, fingerprint: this.#cache.get(node, read), element: elementName(node, read) ?? 'element', excerpt }
  }

  // ── List ────────────────────────────────────────────────────────────

  #setScopeEnabled() {
    this.#dialogUi.scopeFilter.documentScope.toggleAttribute('disabled', !this.state?.xml)
  }

  async #reload() {
    const scope = /** @type {SlRadioGroup} */ (this.#dialogUi.scopeFilter).value
    const params = scope === 'document' && this.state?.xml ? { stable_id: this.state.xml } : {}
    try {
      this.#items = (await this.#client.apiClient.bookmarksList(params)).items
    } catch (error) {
      notify(`Cannot load the bookmarks: ${String(error)}`, 'danger', 'exclamation-octagon')
      this.#items = []
    }
    this.#render()
  }

  #render() {
    const query = String(/** @type {SlInput} */ (this.#dialogUi.searchInput).value ?? '').trim().toLowerCase()
    const items = query
      ? this.#items.filter(item => [item.title, item.doc_label, item.excerpt ?? ''].some(text => text.toLowerCase().includes(query)))
      : this.#items
    this.#dialogUi.bookmarkList.replaceChildren(...items.map(item => this.#row(item)))
    this.#dialogUi.emptyNote.style.display = items.length ? 'none' : ''
    this.#dialogUi.emptyNote.textContent = query
      ? 'No matching bookmarks.'
      : 'No bookmarks. Right-click an element in the text and choose "Bookmark…" to add one.'
  }

  /**
   * @param {BookmarkItem} item
   * @returns {HTMLElement}
   */
  #row(item) {
    const row = document.createElement('div')
    row.className = `bookmark-row${item.available ? '' : ' unavailable'}`
    row.dataset.testid = 'bookmark-row'
    row.dataset.id = item.id

    const icon = document.createElement('sl-icon')
    icon.className = 'bookmark-icon'
    icon.setAttribute('name', 'bookmark-fill')

    const main = document.createElement('div')
    main.className = 'bookmark-main'
    const head = document.createElement('div')
    head.className = 'bookmark-head'
    const title = document.createElement('b')
    title.textContent = item.title
    title.title = item.title
    const doc = document.createElement('span')
    doc.className = 'bookmark-doc'
    doc.textContent = `<${item.element}> · ${item.doc_label}`
    head.append(title, doc)
    main.appendChild(head)
    if (item.excerpt) {
      const excerpt = document.createElement('div')
      excerpt.className = 'bookmark-excerpt'
      excerpt.textContent = item.excerpt
      main.appendChild(excerpt)
    }

    const side = document.createElement('div')
    side.className = 'bookmark-side'
    const when = document.createElement('span')
    when.textContent = relativeTime(item.created_at)
    when.title = new Date(item.created_at).toLocaleString()
    side.appendChild(when)
    if (!item.available) {
      const note = document.createElement('span')
      note.className = 'bookmark-note'
      note.textContent = 'document not available'
      side.appendChild(note)
    }
    const actions = document.createElement('div')
    actions.className = 'bookmark-actions'
    const rename = document.createElement('sl-icon-button')
    rename.setAttribute('name', 'pencil')
    rename.setAttribute('label', 'Rename')
    rename.title = 'Rename'
    rename.dataset.testid = 'bookmark-rename'
    rename.addEventListener('click', event => {
      event.stopPropagation()
      this.#toggleRenameField(row, item)
    })
    const remove = document.createElement('sl-icon-button')
    remove.setAttribute('name', 'trash')
    remove.setAttribute('label', 'Delete')
    remove.title = 'Delete'
    remove.dataset.testid = 'bookmark-delete'
    remove.addEventListener('click', async event => {
      event.stopPropagation()
      try {
        await this.#client.apiClient.bookmarksDelete(item.id)
      } catch (error) {
        notify(`The bookmark could not be deleted: ${String(error)}`, 'danger', 'exclamation-octagon')
        return
      }
      testLog('BOOKMARK_DELETED', { id: item.id })
      await this.#reload()
    })
    actions.append(rename, remove)
    side.appendChild(actions)

    row.append(icon, main, side)
    row.addEventListener('click', () => this.open(item))
    return row
  }

  /**
   * Shows or hides an inline field to rename a bookmark.
   * @param {HTMLElement} row
   * @param {BookmarkItem} item
   */
  #toggleRenameField(row, item) {
    const existing = row.querySelector('.bookmark-rename')
    if (existing) {
      existing.remove()
      return
    }
    const field = document.createElement('div')
    field.className = 'bookmark-rename'
    field.addEventListener('click', event => event.stopPropagation())
    const input = /** @type {SlInput} */ (document.createElement('sl-input'))
    input.setAttribute('size', 'small')
    input.setAttribute('maxlength', String(TITLE_MAX_LENGTH))
    input.value = item.title
    input.dataset.testid = 'bookmark-rename-input'
    const save = document.createElement('sl-button')
    save.setAttribute('size', 'small')
    save.setAttribute('variant', 'primary')
    save.textContent = 'Save'
    const submit = async () => {
      const title = String(input.value ?? '').trim()
      if (!title || title === item.title) {
        field.remove()
        return
      }
      try {
        await this.#client.apiClient.bookmarksUpdate(item.id, { title })
      } catch (error) {
        notify(`The bookmark could not be renamed: ${String(error)}`, 'danger', 'exclamation-octagon')
        return
      }
      testLog('BOOKMARK_RENAMED', { id: item.id, title })
      await this.#reload()
    }
    save.addEventListener('click', submit)
    input.addEventListener('keydown', event => {
      const key = /** @type {KeyboardEvent} */ (event).key
      if (key === 'Enter') submit()
      else if (key === 'Escape') {
        event.stopPropagation()
        field.remove()
      }
    })
    field.append(input, save)
    row.appendChild(field)
    setTimeout(() => input.focus(), 0)
  }
}

export default BookmarksPlugin

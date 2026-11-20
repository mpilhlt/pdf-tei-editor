/**
 * The search field and result list of the user manual, used by the manual drawer (`app/src/plugins/info.js`) and the
 * standalone manual window (`app/src/manual.js`). Matching and ranking are in `manual-search.js`.
 */

/**
 * @import { SlDrawer, SlIconButton, SlInput } from '../ui.js'
 * @import { ManualIndex, ManualIndexPage, ManualPageHit } from './manual-search.js'
 * @import { ManualViewer } from './manual-viewer.js'
 * @import { ManualContributionItem, ManualPageItem } from './api-client-v1.js'
 */

import { buildIndex, highlightParts, parseQuery, search } from './manual-search.js'
import { pickManualFile, pluginPagePath } from './manual-slots.js'

/**
 * What to open when a result is chosen
 * @typedef {object} ManualSearchTarget
 * @property {string} path - Page path
 * @property {string} anchor - Heading anchor, "" for the top of the page
 * @property {number} occurrence - Index among the headings with the same anchor
 * @property {string[]} words - Folded query words, for highlighting them on the page
 */

/**
 * Options of a ManualSearchBox
 * @typedef {object} ManualSearchBoxOptions
 * @property {SlInput} input - The search field
 * @property {HTMLElement} panel - Element the results are rendered into; hidden while there are none to show
 * @property {() => Promise<ManualIndex>} loadIndex - Builds the index; called once until `invalidate()`
 * @property {(target: ManualSearchTarget) => void} onOpen - Called when a result is chosen
 * @property {() => void} [onClose] - Called when the search is closed with Esc
 * @property {string} [subject] - What is searched, in the messages (default: "the manual")
 * @property {boolean} [groupByPage] - Whether to list the results under their page (default: yes); without, a
 *   single page is searched
 */

const DEBOUNCE_MS = 150

export class ManualSearchBox {
  /** @type {ManualSearchBoxOptions} */
  #options

  /** @type {Promise<ManualIndex> | null} */
  #index = null

  /** @type {ManualSearchTarget[]} */
  #targets = []

  #selected = -1

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer

  /**
   * @param {ManualSearchBoxOptions} options
   */
  constructor(options) {
    this.#options = options
    const { input, panel } = options
    panel.hidden = true
    panel.classList.add('manual-search-results')
    panel.setAttribute('role', 'listbox')
    input.addEventListener('sl-input', () => {
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => this.update(), DEBOUNCE_MS)
    })
    input.addEventListener('sl-clear', () => this.update())
    input.addEventListener('sl-focus', () => this.update())
    input.addEventListener('sl-blur', () => setTimeout(() => this.hideResults(), 150))
    input.addEventListener('keydown', event => this.#handleKey(event))
    // keep the focus in the field when a result is clicked
    panel.addEventListener('mousedown', event => event.preventDefault())
  }

  /** Drops the index, e.g. when the plugin pages changed */
  invalidate() {
    this.#index = null
  }

  /** @returns {Promise<ManualIndex>} */
  #getIndex() {
    if (!this.#index) {
      this.#index = this.#options.loadIndex().catch(error => {
        this.#index = null
        throw error
      })
    }
    return this.#index
  }

  /** Hides the results */
  hideResults() {
    this.#options.panel.hidden = true
    this.#selected = -1
  }

  /**
   * Runs the search for the current value of the field and shows the results.
   * @returns {Promise<void>}
   */
  async update() {
    const { input, panel } = this.#options
    const query = input.value
    const subject = this.#options.subject ?? 'the manual'
    if (!this.#index) this.#showMessage(`Loading ${subject}…`)
    let index
    try {
      index = await this.#getIndex()
    } catch (error) {
      this.#showMessage(`${subject.charAt(0).toUpperCase()}${subject.slice(1)} could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (input.value !== query) return
    const hits = search(index, query, (this.#options.groupByPage ?? true) ? {} : { sectionsPerPage: 10 })
    if (hits.length === 0) {
      this.#showMessage(`Nothing in ${subject} matches.`)
      return
    }
    this.#render(hits, parseQuery(query).words)
    panel.hidden = false
  }

  /**
   * @param {string} message
   */
  #showMessage(message) {
    const { panel } = this.#options
    panel.replaceChildren()
    const div = document.createElement('div')
    div.className = 'manual-search-message'
    div.textContent = message
    panel.append(div)
    panel.hidden = false
    this.#targets = []
    this.#selected = -1
  }

  /**
   * @param {ManualPageHit[]} hits
   * @param {string[]} queryWords
   */
  #render(hits, queryWords) {
    const { panel } = this.#options
    panel.replaceChildren()
    this.#targets = []
    this.#selected = -1
    let bestIndex = 0
    for (const [hitIndex, hit] of hits.entries()) {
      const groupByPage = this.#options.groupByPage ?? true
      const pageRow = groupByPage ? this.#row('manual-search-page', { path: hit.path, anchor: '', occurrence: 0, words: queryWords }) : null
      pageRow?.append(...this.#highlighted(hit.title, queryWords))
      if (pageRow && hit.source) {
        const badge = document.createElement('span')
        badge.className = 'manual-search-source'
        badge.textContent = `${hit.source} plugin`
        pageRow.append(badge)
      }
      for (const [sectionIndex, section] of hit.sections.entries()) {
        const isPageTop = !section.anchor
        if (isPageTop && !section.snippet) continue
        if (hitIndex === 0 && sectionIndex === 0) bestIndex = this.#targets.length
        const row = this.#row(groupByPage ? 'manual-search-section' : 'manual-search-section manual-search-ungrouped', { path: hit.path, anchor: section.anchor, occurrence: section.occurrence, words: queryWords })
        const heading = document.createElement('span')
        heading.className = 'manual-search-heading'
        heading.append(...this.#highlighted(isPageTop ? 'Introduction' : section.heading, queryWords))
        row.append(heading)
        if (section.snippet) {
          const snippet = document.createElement('span')
          snippet.className = 'manual-search-snippet'
          snippet.append(...this.#highlighted(section.snippet, queryWords))
          row.append(snippet)
        }
      }
    }
    if (queryWords.length > 0) {
      // preselect the best match: the best section of the first page, or the page itself if that is its title
      this.#select(bestIndex)
      const footer = document.createElement('div')
      footer.className = 'manual-search-message'
      footer.textContent = '↑↓ to select · Enter to open · Esc to close'
      panel.append(footer)
    }
  }

  /**
   * Adds a result row.
   * @param {string} className
   * @param {ManualSearchTarget} target
   * @returns {HTMLElement}
   */
  #row(className, target) {
    const row = document.createElement('div')
    row.className = className
    row.setAttribute('role', 'option')
    const index = this.#targets.length
    this.#targets.push(target)
    row.dataset.index = String(index)
    row.addEventListener('click', () => this.#open(index))
    this.#options.panel.append(row)
    return row
  }

  /**
   * Text with the query words in `<mark>` elements, built as nodes.
   * @param {string} text
   * @param {string[]} queryWords
   * @returns {Node[]}
   */
  #highlighted(text, queryWords) {
    return highlightParts(text, queryWords).map(part => {
      if (!part.match) return document.createTextNode(part.text)
      const mark = document.createElement('mark')
      mark.textContent = part.text
      return mark
    })
  }

  /**
   * @param {number} index
   */
  #open(index) {
    const target = this.#targets[index]
    if (!target) return
    this.hideResults()
    this.#options.onOpen(target)
  }

  /**
   * @param {number} index
   */
  #select(index) {
    const rows = this.#options.panel.querySelectorAll('[role="option"]')
    if (rows.length === 0) return
    this.#selected = (index + rows.length) % rows.length
    rows.forEach((row, i) => row.classList.toggle('selected', i === this.#selected))
    rows[this.#selected].scrollIntoView({ block: 'nearest' })
  }

  /**
   * @param {KeyboardEvent} event
   */
  #handleKey(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (this.#options.panel.hidden) {
        this.update()
        return
      }
      this.#select(this.#selected + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      this.#open(this.#selected === -1 ? 0 : this.#selected)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.#options.input.value = ''
      this.hideResults()
      this.#options.onClose?.()
    }
  }
}

/**
 * Highlights the query words in the section of a rendered page that starts at a heading (up to the next heading),
 * with `<mark class="manual-search-mark">` elements. Removes the marks of an earlier call first.
 * @param {HTMLElement} container - The rendered page
 * @param {Element | null} heading - The heading the section starts with, or null for the text before the first
 *   heading below the title
 * @param {string[]} queryWords - Folded query words
 * @returns {number} Number of marks added
 */
export function markSectionMatches(container, heading, queryWords) {
  clearSectionMarks(container)
  if (queryWords.length === 0) return 0
  const headings = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')]
  const start = heading ?? headings[0] ?? null
  const startIndex = start ? headings.indexOf(start) : -1
  const end = headings[startIndex + 1] ?? null
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  /** @type {Text[]} */
  const nodes = []
  while (walker.nextNode()) {
    const node = /** @type {Text} */ (walker.currentNode)
    if (start && !(start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) && !start.contains(node)) continue
    if (end && (end.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING || end.contains(node))) break
    if (node.parentElement?.closest('sl-icon-button, script, style')) continue
    nodes.push(node)
  }
  let count = 0
  for (const node of nodes) {
    const parts = highlightParts(node.data, queryWords)
    if (!parts.some(part => part.match)) continue
    const fragment = container.ownerDocument.createDocumentFragment()
    for (const part of parts) {
      if (part.match) {
        const mark = container.ownerDocument.createElement('mark')
        mark.className = 'manual-search-mark'
        mark.textContent = part.text
        fragment.append(mark)
        count++
      } else {
        fragment.append(part.text)
      }
    }
    node.replaceWith(fragment)
  }
  return count
}

/**
 * Removes the marks added by markSectionMatches.
 * @param {HTMLElement} container
 */
export function clearSectionMarks(container) {
  for (const mark of container.querySelectorAll('mark.manual-search-mark')) {
    mark.replaceWith(mark.textContent ?? '')
  }
  container.normalize()
}

/**
 * Builds the search index of the manual: fetches the core pages and the plugin pages (each once, in the preferred
 * language) from the same source as the viewer renders them. Pages that cannot be fetched are left out.
 * @param {ManualViewer} viewer
 * @param {ManualPageItem[]} corePages - From `GET /api/v1/manual/pages`, in manual order
 * @param {ManualContributionItem[]} contributions - The plugin pages, in slot order
 * @param {readonly string[]} [languages] - Preferred languages for plugin pages
 * @returns {Promise<ManualIndex>}
 */
export async function loadManualIndex(viewer, corePages, contributions, languages = navigator.languages) {
  /** @type {{path: string, title?: string, source?: string, description?: string}[]} */
  const pages = corePages.map(page => ({ path: page.path, title: page.title }))
  const seen = new Set()
  for (const contribution of contributions) {
    if (!contribution.active) continue
    const path = pluginPagePath(contribution.plugin_id, pickManualFile(contribution.files, languages))
    if (seen.has(path)) continue
    seen.add(path)
    pages.push({ path, title: contribution.title, source: contribution.plugin_name, description: contribution.description })
  }
  const fetched = await Promise.all(pages.map(async page => {
    try {
      const source = await viewer.fetchPage(page.path)
      return /** @type {ManualIndexPage} */ ({ ...page, markdown: source.markdown })
    } catch {
      return null
    }
  }))
  const indexPages = /** @type {ManualIndexPage[]} */ (fetched.filter(Boolean))
  return buildIndex(indexPages, page => page.source ? viewer.pluginMd : viewer.md)
}

/**
 * Elements of a drawer with a search field in place of its title
 * @typedef {object} DrawerSearchElements
 * @property {SlDrawer} drawer
 * @property {SlIconButton} button - Search button in the header
 * @property {SlInput} input - The search field, hidden while the search is closed
 * @property {HTMLElement} title - The title, hidden while the search is open
 */

/**
 * Lets a drawer's search button and Ctrl+K (while the drawer is open) replace the title with the search field, and
 * Esc close the search instead of the drawer.
 * @param {DrawerSearchElements} elements
 * @param {() => ManualSearchBox | null} getSearchBox - The search box of the field
 * @returns {(show: boolean) => void} Shows or hides the search field
 */
export function attachDrawerSearch({ drawer, button, input, title }, getSearchBox) {
  /** @param {boolean} show */
  const toggle = show => {
    input.hidden = !show
    title.hidden = show
    if (show) {
      setTimeout(() => input.focus(), 0)
    } else {
      input.value = ''
      getSearchBox()?.hideResults()
    }
  }
  button.addEventListener('click', () => toggle(input.hidden))
  document.addEventListener('keydown', event => {
    if (drawer.open && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      toggle(true)
    }
  })
  drawer.addEventListener('sl-request-close', event => {
    if (event.detail.source === 'keyboard' && !input.hidden) {
      event.preventDefault()
      toggle(false)
    }
  })
  return toggle
}

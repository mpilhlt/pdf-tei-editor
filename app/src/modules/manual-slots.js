/**
 * Slots in the user manual that list the pages plugins contribute.
 *
 * A core manual page declares a slot with an HTML comment, e.g. `<!-- plugin-docs: tutorials -->`,
 * optionally followed by `hide-heading` to remove the heading directly before the slot when no
 * page is contributed to it. The manual drawer (`app/src/plugins/info.js`) replaces the comment with a
 * list of links to the contributed pages, which it gets from `GET /api/v1/manual/contributions`.
 * Contributed pages are shown under the virtual path `plugins/<plugin id>/<file>` and fetched from
 * `/api/v1/manual/plugins/<plugin id>/<file>`; a page can open at a heading (`anchors`). See docs/code-assistant/backend-plugins.md#manual-pages.
 */

/**
 * @import { ManualContributionItem } from './api-client-v1.js'
 */

/** URL prefix of the files of plugin manual pages */
export const PLUGIN_MANUAL_API = '/api/v1/manual/plugins'

/** Prefix of the virtual paths of plugin manual pages in the manual drawer */
export const PLUGIN_PAGE_PREFIX = 'plugins/'

const SLOT_COMMENT = /^\s*plugin-docs:\s*([a-z0-9-]+)((?:\s+[a-z-]+)*)\s*$/

/**
 * A plugin manual page addressed by its virtual path
 * @typedef {object} PluginPage
 * @property {string} pluginId - Id of the plugin
 * @property {string} file - Path of the Markdown file relative to the plugin directory
 */

/**
 * The language of a contributed page that matches the preferred languages best.
 * @param {Object<string, string>} files - File per language code
 * @param {readonly string[]} [languages] - Preferred languages, e.g. `navigator.languages`
 * @returns {string} The first preferred language (or its base language) that has a file, else "en" if it has one,
 *   else the first language
 */
export function pickManualLanguage(files, languages = []) {
  for (const language of languages) {
    if (files[language]) return language
    const base = language.split('-')[0]
    if (files[base]) return base
  }
  return files.en ? 'en' : Object.keys(files)[0]
}

/**
 * The file of a contributed page in the preferred language.
 * @param {Object<string, string>} files - File per language code
 * @param {readonly string[]} [languages] - Preferred languages, e.g. `navigator.languages`
 * @returns {string} The file of the first preferred language (or its base language) that exists, else the English
 *   file, else the first one
 */
export function pickManualFile(files, languages = []) {
  return files[pickManualLanguage(files, languages)]
}

/**
 * The virtual path a contributed page opens at in the manual drawer, in the preferred language.
 * @param {ManualContributionItem} contribution
 * @param {readonly string[]} [languages] - Preferred languages, e.g. `navigator.languages`
 * @returns {string} `plugins/<plugin id>/<file>`, followed by `#<anchor>` if the page opens at a heading
 */
export function contributionPagePath(contribution, languages = []) {
  const language = pickManualLanguage(contribution.files, languages)
  const path = pluginPagePath(contribution.plugin_id, contribution.files[language])
  const anchor = contribution.anchors?.[language]
  return anchor ? `${path}#${anchor}` : path
}

/**
 * The virtual path of a plugin manual page in the manual drawer.
 * @param {string} pluginId
 * @param {string} file - Path relative to the plugin directory
 * @returns {string}
 */
export function pluginPagePath(pluginId, file) {
  return `${PLUGIN_PAGE_PREFIX}${pluginId}/${file}`
}

/**
 * Parses the virtual path of a plugin manual page.
 * @param {string} path - Path in the manual drawer, without leading "/"
 * @returns {PluginPage | null} The page, or null if `path` is a core manual page
 */
export function parsePluginPagePath(path) {
  if (!path.startsWith(PLUGIN_PAGE_PREFIX)) return null
  const rest = path.slice(PLUGIN_PAGE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  return { pluginId: rest.slice(0, slash), file: rest.slice(slash + 1) }
}

/**
 * The URL of a file of a plugin manual page.
 * @param {PluginPage} page
 * @returns {string}
 */
export function pluginPageUrl(page) {
  return `${PLUGIN_MANUAL_API}/${encodeURIComponent(page.pluginId)}/${page.file.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Replaces the slot comments in rendered manual HTML with lists of links to the contributed pages.
 * All text is inserted as text, never as HTML.
 * @param {HTMLElement} container - Element with the rendered page
 * @param {ManualContributionItem[]} contributions - Pages the user can see
 * @param {(contribution: ManualContributionItem) => void} onOpen - Called when a link is clicked
 * @returns {number} Number of slots found
 */
export function fillManualSlots(container, contributions, onOpen) {
  const doc = container.ownerDocument
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_COMMENT)
  /** @type {Comment[]} */
  const comments = []
  while (walker.nextNode()) comments.push(/** @type {Comment} */ (walker.currentNode))
  let count = 0
  for (const comment of comments) {
    const match = comment.data.match(SLOT_COMMENT)
    if (!match) continue
    count++
    const [, slot, options] = match
    const items = contributions.filter(c => c.slot === slot)
    if (items.length === 0) {
      if (options.split(/\s+/).includes('hide-heading')) {
        const previous = previousElement(comment)
        if (previous && /^H[1-6]$/.test(previous.tagName)) previous.remove()
      }
      comment.remove()
      continue
    }
    const list = doc.createElement('ul')
    list.className = 'plugin-docs'
    list.dataset.slot = slot
    for (const contribution of items) {
      const item = doc.createElement('li')
      const strong = doc.createElement('strong')
      const link = doc.createElement('a')
      link.href = '#'
      link.textContent = contribution.title
      link.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        onOpen(contribution)
      })
      strong.append(link)
      item.append(strong)
      if (contribution.description) item.append(` - ${contribution.description}`)
      if (!contribution.active) {
        const note = doc.createElement('em')
        note.textContent = ` (${contribution.plugin_name} plugin or a plugin it needs is not enabled)`
        item.append(note)
      }
      list.append(item)
    }
    comment.replaceWith(list)
  }
  return count
}

/**
 * The element sibling before a node, skipping whitespace text and comments.
 * @param {Node} node
 * @returns {Element | null}
 */
function previousElement(node) {
  let previous = node.previousSibling
  while (previous && previous.nodeType !== Node.ELEMENT_NODE) {
    if (previous.nodeType === Node.TEXT_NODE && previous.textContent?.trim()) return null
    previous = previous.previousSibling
  }
  return /** @type {Element | null} */ (previous)
}

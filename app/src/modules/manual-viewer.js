/**
 * Renders pages of the user manual into a container element. Used by the manual drawer
 * (`app/src/plugins/info.js`) and the standalone manual window (`app/src/manual.js`).
 *
 * Pages are addressed by their path relative to `docs/` (e.g. `user-manual/review-workflow.md`) or by the virtual
 * path `plugins/<plugin id>/<file>` of a page that a plugin contributes (see `manual-slots.js`). Core pages are
 * rendered with raw HTML passed through, plugin pages without. Links to other manual pages call the `onNavigate`
 * callback instead of leaving the page; links to other sites open in a new tab.
 */

/**
 * @import MarkdownIt from 'markdown-it'
 * @import { MarkdownHeading } from './markdown-utils.js'
 * @import { ManualContributionItem } from './api-client-v1.js'
 * @import { PluginPage } from './manual-slots.js'
 */

import { createMarkdownRenderer, extractHeadings } from './markdown-utils.js'
import { MarkdownPageViewer, isExternalHref } from './markdown-page-viewer.js'
import { contributionPagePath, fillManualSlots, parsePluginPagePath, pickManualFile, pluginPagePath, pluginPageUrl } from './manual-slots.js'
import { parseManualUrl } from './manual-links.js'

/**
 * The Markdown of a manual page
 * @typedef {object} ManualPageSource
 * @property {string} path - Path of the page (relative to `docs/`, or the virtual plugin page path)
 * @property {string} markdown - The Markdown text
 * @property {string} url - URL the Markdown was fetched from; relative images resolve against it
 * @property {PluginPage | null} pluginPage - The plugin page, or null for a core page
 * @property {ManualContributionItem | null} contribution - The contribution of a plugin page, if listed
 */

/**
 * The result of rendering a page
 * @typedef {object} RenderedManualPage
 * @property {string} path - Path of the page that was rendered (for a plugin page: the file in the chosen language)
 * @property {string} title - Text of the first heading, or the file name
 * @property {MarkdownHeading[]} headings - The headings of the page
 * @property {PluginPage | null} pluginPage - The plugin page, or null for a core page
 */

/**
 * Options of a ManualViewer
 * @typedef {object} ManualViewerOptions
 * @property {HTMLElement} container - Element the page is rendered into
 * @property {() => Promise<string[]>} getDocsBases - URLs of the `docs/` directory (without trailing "/") to try in
 *   order, e.g. `['/docs']`
 * @property {() => Promise<ManualContributionItem[]>} getContributions - The plugin pages to list in slots
 * @property {(target: string) => void} onNavigate - Called with "path#anchor" when a link to another manual page is
 *   clicked
 * @property {readonly string[]} [languages] - Preferred languages for plugin pages (default: `navigator.languages`)
 * @property {() => boolean} [isCacheEnabled] - Whether to use the browser cache when fetching pages (default: yes)
 */

/**
 * Resolves a link on a manual page to a page path and anchor.
 * @param {string} currentPage - Path of the page with the link, e.g. "user-manual/a.md"
 * @param {string} href - The link: relative to the current page, absolute from `docs/` with a leading "/",
 *   optionally with "#anchor"
 * @returns {{path: string, anchor: string}} The page path (without leading "/"; the current page for "#anchor") and
 *   the anchor ("" if none)
 */
export function resolveManualPath(currentPage, href) {
  const hashIndex = href.indexOf('#')
  const anchor = hashIndex === -1 ? '' : decodeURIComponent(href.slice(hashIndex + 1))
  const target = hashIndex === -1 ? href : href.slice(0, hashIndex)
  if (!target) return { path: currentPage, anchor }
  if (target.startsWith('/')) return { path: normalizeSegments([], target.replace(/^\/+/, '')), anchor }
  const dir = currentPage.includes('/') ? currentPage.slice(0, currentPage.lastIndexOf('/')).split('/') : []
  return { path: normalizeSegments(dir, target), anchor }
}

/**
 * Appends the segments of a relative path to a directory, resolving "." and "..".
 * @param {string[]} dir - Segments of the directory
 * @param {string} relativePath
 * @returns {string}
 */
function normalizeSegments(dir, relativePath) {
  const parts = [...dir]
  for (const part of relativePath.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

export class ManualViewer extends MarkdownPageViewer {
  /** @type {ManualViewerOptions} */
  #options

  /** @type {MarkdownIt} */
  #md

  /** Renderer for plugin pages, which does not pass raw HTML through @type {MarkdownIt} */
  #pluginMd

  /** Path of the page shown */
  #currentPage = ''

  /**
   * @param {ManualViewerOptions} options
   */
  constructor(options) {
    super(options.container)
    this.#options = options
    this.#md = createMarkdownRenderer()
    this.#pluginMd = createMarkdownRenderer({ html: false })
  }

  /** The Markdown renderer of core pages @returns {MarkdownIt} */
  get md() {
    return this.#md
  }

  /** The Markdown renderer of plugin pages @returns {MarkdownIt} */
  get pluginMd() {
    return this.#pluginMd
  }

  /** Path of the page shown, "" before the first page @returns {string} */
  get currentPage() {
    return this.#currentPage
  }

  /** @returns {readonly string[]} */
  get #languages() {
    return this.#options.languages ?? (typeof navigator !== 'undefined' ? navigator.languages : [])
  }

  /**
   * The contribution that lists a plugin page, and the file of that page in the preferred language.
   * @param {PluginPage} page
   * @param {string} [lang] - Requested language; the preferred languages if omitted
   * @returns {Promise<{contribution: ManualContributionItem | null, file: string}>}
   */
  async #pluginPageFile(page, lang) {
    const contributions = await this.#options.getContributions()
    const contribution = contributions.find(c => c.plugin_id === page.pluginId && Object.values(c.files).includes(page.file)) ?? null
    if (!contribution || !lang) return { contribution, file: page.file }
    return { contribution, file: pickManualFile(contribution.files, [lang, ...this.#languages]) }
  }

  /**
   * Fetches the Markdown of a page.
   * @param {string} path - Page path
   * @param {string} [lang] - Language of a plugin page
   * @returns {Promise<ManualPageSource>}
   * @throws {Error} If the page cannot be fetched
   */
  async fetchPage(path, lang) {
    const fetchOptions = this.#options.isCacheEnabled?.() === false ? { cache: /** @type {RequestCache} */ ('no-cache') } : {}
    const parsed = parsePluginPagePath(path)
    if (parsed) {
      const { contribution, file } = await this.#pluginPageFile(parsed, lang)
      const pluginPage = { pluginId: parsed.pluginId, file }
      const url = pluginPageUrl(pluginPage)
      const response = await fetch(url, fetchOptions)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return { path: pluginPagePath(pluginPage.pluginId, file), markdown: await response.text(), url, pluginPage, contribution }
    }
    /** @type {unknown} */
    let lastError = null
    for (const base of await this.#options.getDocsBases()) {
      const url = `${base}/${path}`
      try {
        const response = await fetch(url, fetchOptions)
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        return { path, markdown: await response.text(), url, pluginPage: null, contribution: null }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Cannot load ${path}`)
  }

  /**
   * Renders a page into the container.
   * @param {string} path - Page path
   * @param {{lang?: string}} [options] - `lang`: language of a plugin page
   * @returns {Promise<RenderedManualPage>}
   * @throws {Error} If the page cannot be fetched; the container is empty then
   */
  async render(path, { lang } = {}) {
    const container = this.#options.container
    container.innerHTML = ''
    const source = await this.fetchPage(path, lang)
    this.#currentPage = source.path
    const md = source.pluginPage ? this.#pluginMd : this.#md
    this.renderMarkdown(md, source.markdown, source.url)
    this.#rewriteLinks()
    if (source.pluginPage) {
      const note = document.createElement('p')
      note.className = 'plugin-docs-source'
      note.textContent = source.contribution
        ? `Provided by the ${source.contribution.plugin_name} plugin, version ${source.contribution.plugin_version}.`
        : `Provided by the ${source.pluginPage.pluginId} plugin.`
      container.prepend(note)
    } else {
      const contributions = await this.#options.getContributions()
      fillManualSlots(container, contributions, contribution => {
        this.#options.onNavigate(`/${contributionPagePath(contribution, this.#languages)}`)
      })
    }
    const headings = extractHeadings(md, source.markdown)
    const first = headings.find(h => h.level === 1) ?? headings[0]
    const title = first?.text ?? source.path.split('/').pop()?.replace(/\.md$/i, '') ?? source.path
    return { path: source.path, title, headings, pluginPage: source.pluginPage }
  }

  /**
   * Links to other manual pages call `onNavigate`, links to other sites open in a new tab.
   */
  #rewriteLinks() {
    this.rewriteLinks(href => {
      const manualTarget = parseManualUrl(href)
      if (manualTarget) {
        return (/** @type {MouseEvent} */ event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey) return
          event.preventDefault()
          event.stopPropagation()
          this.#options.onNavigate(`/${manualTarget.path}${manualTarget.anchor ? `#${manualTarget.anchor}` : ''}`)
        }
      }
      if (isExternalHref(href)) return null
      return event => {
        event.preventDefault()
        const { path, anchor } = resolveManualPath(this.#currentPage, href)
        this.#options.onNavigate(`/${path}${anchor ? `#${anchor}` : ''}`)
      }
    })
  }
}

/**
 * Base class of the viewers that render a Markdown page into a container element: the user manual
 * (`manual-viewer.js`) and the annotation guide (`guide-viewer.js`), each used by a drawer and a standalone window.
 *
 * Renders the Markdown, resolves relative image sources against the URL of the page, optionally sanitizes the HTML,
 * lets subclasses decide what links do, and keeps links to sections of the page ("#anchor") in the container.
 */

/**
 * @import MarkdownIt from 'markdown-it'
 */

import DOMPurify from 'dompurify'
import { resolveRelativeSources } from './markdown-utils.js'

/**
 * Whether a link points to another site (or uses a scheme such as mailto:)
 * @param {string} href
 * @returns {boolean}
 */
export function isExternalHref(href) {
  return /^(https?:)?\/\//i.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href)
}

/**
 * Removes scripts, event handlers and other active content from HTML. Keeps the formatting markup that Markdown pages
 * use (e.g. `<sup>`, `<details>`) and the heading ids.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
}

export class MarkdownPageViewer {
  /** @type {HTMLElement} */
  #container

  /**
   * @param {HTMLElement} container - Element the page is rendered into
   */
  constructor(container) {
    this.#container = container
    container.addEventListener('click', event => this.#handleAnchorClick(event))
  }

  /** Element the page is rendered into @returns {HTMLElement} */
  get container() {
    return this.#container
  }

  /**
   * Renders Markdown into the container.
   * @param {MarkdownIt} md - The renderer
   * @param {string} markdown - The Markdown text
   * @param {string} url - URL of the page; relative image sources resolve against it
   * @param {{sanitize?: boolean}} [options] - `sanitize`: remove active content (for pages from other sites)
   */
  renderMarkdown(md, markdown, url, { sanitize = false } = {}) {
    let html = resolveRelativeSources(md.render(markdown), url)
    if (sanitize) html = sanitizeHtml(html)
    this.#container.innerHTML = html
  }

  /**
   * Calls `handler` for each link in the container except links to sections of the page ("#anchor"). If it returns
   * a click listener, the listener is added; if it returns null and the link points to another site, the link opens
   * in a new tab.
   * @param {(href: string, link: HTMLAnchorElement) => ((event: MouseEvent) => void) | null} handler
   */
  rewriteLinks(handler) {
    for (const link of /** @type {NodeListOf<HTMLAnchorElement>} */ (this.#container.querySelectorAll('a[href]'))) {
      const href = link.getAttribute('href') || ''
      if (!href || href.startsWith('#')) continue
      const listener = handler(href, link)
      if (listener) {
        link.addEventListener('click', listener)
      } else if (isExternalHref(link.getAttribute('href') || '')) {
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noopener')
      }
    }
  }

  /**
   * Scrolls to a heading of the page shown.
   * @param {string} anchor - Heading anchor without "#"
   * @param {ScrollBehavior} [behavior]
   * @param {number} [occurrence] - Index among the headings with the same anchor
   * @returns {boolean} Whether the heading was found
   */
  scrollToAnchor(anchor, behavior = 'smooth', occurrence = 0) {
    if (!anchor) return false
    const target = this.#container.querySelectorAll(`[id="${CSS.escape(anchor)}"]`)[occurrence]
    if (!target) return false
    target.scrollIntoView({ behavior, block: 'start' })
    return true
  }

  /**
   * Keeps links to sections of the page shown ("#anchor") in the container.
   * @param {MouseEvent} event
   */
  #handleAnchorClick(event) {
    const link = /** @type {HTMLElement} */ (event.target).closest?.('a[href^="#"]')
    if (!link) return
    const anchor = decodeURIComponent((link.getAttribute('href') || '').slice(1))
    if (!anchor) return
    event.preventDefault()
    this.scrollToAnchor(anchor)
  }
}

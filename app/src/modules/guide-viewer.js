/**
 * Renders an annotation guide (a Markdown file on a git forge or another site) into a container element. Used by
 * the annotation guide drawer (`app/src/plugins/annotation-guide.js`) and the standalone guide window
 * (`app/src/guide.js`).
 *
 * The guide is fetched as raw text (`blobUrlToRawUrl()`), images resolve against the raw URL, and the HTML is
 * sanitized, since the guide comes from another site. Links to other files open them on the forge in a new tab.
 */

/**
 * @import MarkdownIt from 'markdown-it'
 * @import { MarkdownHeading } from './markdown-utils.js'
 */

import { createMarkdownRenderer, extractHeadings, fetchMarkdown, generateTOC } from './markdown-utils.js'
import { MarkdownPageViewer } from './markdown-page-viewer.js'
import { blobUrlToRawUrl } from './git-forge-urls.js'

/**
 * The result of rendering a guide
 * @typedef {object} RenderedGuide
 * @property {string} title - Text of the first level-1 heading, or the file name
 * @property {MarkdownHeading[]} headings - The headings of the guide
 */

/** `[TOC]` on a line of its own is replaced by a table of contents */
const TOC_REGEX = /^(\[TOC\]|\[toc\])$/m

export class GuideViewer extends MarkdownPageViewer {
  /** @type {MarkdownIt} */
  #md

  /** URL of the guide shown (as configured, e.g. a GitHub blob URL, without anchor) */
  #url = ''

  /**
   * @param {HTMLElement} container - Element the guide is rendered into
   */
  constructor(container) {
    super(container)
    this.#md = createMarkdownRenderer()
  }

  /** The Markdown renderer @returns {MarkdownIt} */
  get md() {
    return this.#md
  }

  /** URL of the guide shown, "" before the first guide @returns {string} */
  get url() {
    return this.#url
  }

  /**
   * Fetches the Markdown of a guide.
   * @param {string} url - URL of the guide (a forge blob URL or a raw URL), without anchor
   * @param {{cache?: boolean}} [options] - `cache`: use the browser cache (default)
   * @returns {Promise<string>}
   * @throws {Error} If the guide cannot be fetched
   */
  async fetch(url, { cache = true } = {}) {
    return fetchMarkdown(blobUrlToRawUrl(url), cache)
  }

  /**
   * Renders the Markdown of a guide into the container.
   * @param {string} markdown - The Markdown, e.g. from `fetch()`
   * @param {string} url - URL of the guide, without anchor
   * @returns {RenderedGuide}
   */
  render(markdown, url) {
    this.#url = url
    const source = TOC_REGEX.test(markdown) ? markdown.replace(TOC_REGEX, generateTOC(markdown)) : markdown
    this.renderMarkdown(this.#md, source, blobUrlToRawUrl(url), { sanitize: true })
    this.rewriteLinks((href, link) => {
      let resolved
      try {
        resolved = new URL(href, url).href
      } catch {
        return null
      }
      link.setAttribute('href', resolved)
      return null
    })
    const headings = extractHeadings(this.#md, source)
    const first = headings.find(h => h.level === 1) ?? headings[0]
    const title = first?.text ?? url.split('/').pop()?.replace(/\.md$/i, '') ?? url
    return { title, headings }
  }
}

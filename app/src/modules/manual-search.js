/**
 * Full-text search in the user manual: index building, matching, ranking and snippets. Has no DOM dependencies;
 * the search field and result list are in `manual-search-box.js`.
 *
 * The index has one entry per section of a page: a heading and the text up to the next heading (the text before the
 * first heading belongs to the first section). A section matches if every query word is the start of a word in its
 * page title, heading or text. Words weigh by the field they occur in: page title (in the page's first section),
 * heading, plugin page description, body text. See issue #875.
 */

/**
 * @import MarkdownIt from 'markdown-it'
 */

import { extractHeadings } from './markdown-utils.js'

/** Weight of a query word by the field it occurs in */
export const FIELD_WEIGHTS = Object.freeze({ title: 8, heading: 5, description: 3, body: 1, pageTitle: 0.5 })

/**
 * A page to index
 * @typedef {object} ManualIndexPage
 * @property {string} path - Page path (relative to `docs/`, or the virtual plugin page path)
 * @property {string} markdown - The Markdown of the page
 * @property {string} [title] - Page title; the first heading if omitted
 * @property {string} [source] - Name of the plugin that provides the page; omitted for core pages
 * @property {string} [description] - Description of a plugin page
 */

/**
 * A section of a page
 * @typedef {object} ManualSection
 * @property {number} page - Index of the page in the index (manual order)
 * @property {string} path - Page path
 * @property {string} pageTitle - Title of the page
 * @property {string} [source] - Plugin that provides the page
 * @property {string} heading - Text of the heading ("" for text before the first heading)
 * @property {number} level - Heading level (1 for the page title section)
 * @property {string} anchor - Heading anchor ("" for the top of the page)
 * @property {number} occurrence - Index among the headings with the same anchor
 * @property {string} text - Plain text of the section
 * @property {string} [description] - Description of the page (first section of a plugin page only)
 * @property {string[]} headingWords - Folded words of the heading
 * @property {string[]} bodyWords - Folded words of the text
 * @property {string[]} titleWords - Folded words of the page title
 * @property {string[]} descriptionWords - Folded words of the description
 * @property {string} headingFolded - Folded heading, words separated by single spaces
 * @property {string} bodyFolded - Folded text, words separated by single spaces
 * @property {boolean} isTitle - Whether this is the section of the page title
 */

/**
 * The search index
 * @typedef {object} ManualIndex
 * @property {{path: string, title: string, source?: string}[]} pages - The pages in manual order
 * @property {ManualSection[]} sections - The sections of all pages
 */

/**
 * A matching section
 * @typedef {object} ManualSectionHit
 * @property {string} heading - Heading text
 * @property {string} anchor - Heading anchor
 * @property {number} occurrence - Index among the headings with the same anchor
 * @property {number} level - Heading level
 * @property {number} score - Score of the section
 * @property {string} snippet - Text around the first match in the section's text, or "" if the heading contains all
 *   query words
 */

/**
 * The matching sections of a page
 * @typedef {object} ManualPageHit
 * @property {string} path - Page path
 * @property {string} title - Page title
 * @property {string} [source] - Plugin that provides the page
 * @property {number} score - Score of the best section
 * @property {ManualSectionHit[]} sections - The best matching sections, best first
 */

/**
 * A parsed query
 * @typedef {object} ManualQuery
 * @property {string[]} words - Folded query words
 * @property {string[]} phrases - Folded quoted phrases
 * @property {string} folded - All words of the query, separated by single spaces
 */

/**
 * Lowercases text, removes diacritics and treats "-" and "_" as spaces.
 * @param {string} text
 * @returns {string}
 */
export function fold(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-_]/g, ' ')
}

/**
 * The folded words of a text.
 * @param {string} text
 * @returns {string[]}
 */
export function words(text) {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/**
 * Parses a query: words, and phrases in double quotes.
 * @param {string} query
 * @returns {ManualQuery}
 */
export function parseQuery(query) {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map(match => words(match[1]).join(' ')).filter(Boolean)
  const queryWords = words(query)
  return { words: queryWords, phrases, folded: queryWords.join(' ') }
}

/**
 * Splits Markdown into sections and extracts their plain text.
 * @param {MarkdownIt} md - The renderer of the page (for the heading anchors to match the rendered ids)
 * @param {string} markdown
 * @returns {{heading: string, level: number, anchor: string, occurrence: number, text: string}[]}
 */
export function splitSections(md, markdown) {
  const headings = extractHeadings(md, markdown)
  const tokens = md.parse(markdown, {})
  /** @type {{heading: string, level: number, anchor: string, occurrence: number, text: string[]}[]} */
  const sections = [{ heading: '', level: 0, anchor: '', occurrence: 0, text: [] }]
  let headingIndex = 0
  let inHeading = false
  for (const token of tokens) {
    if (token.type === 'heading_open') {
      const heading = headings[headingIndex++]
      sections.push({ heading: heading.text, level: heading.level, anchor: heading.anchor, occurrence: heading.occurrence, text: [] })
      inHeading = true
    } else if (token.type === 'heading_close') {
      inHeading = false
    } else if (inHeading) {
      continue
    } else if (token.type === 'inline') {
      const parts = (token.children || []).map(child => {
        if (child.type === 'text' || child.type === 'code_inline') return child.content
        if (child.type === 'softbreak' || child.type === 'hardbreak') return ' '
        if (child.type === 'image') return child.content
        return ''
      })
      sections[sections.length - 1].text.push(parts.join(''))
    } else if (token.type === 'fence' || token.type === 'code_block') {
      sections[sections.length - 1].text.push(token.content)
    }
  }
  return sections
    .filter((section, i) => i > 0 || section.text.some(text => text.trim()))
    .map(section => ({ ...section, text: section.text.join(' ').replace(/\s+/g, ' ').trim() }))
}

/**
 * Builds the search index.
 * @param {ManualIndexPage[]} pages - The pages in manual order
 * @param {(page: ManualIndexPage) => MarkdownIt} getRenderer - The renderer of a page
 * @returns {ManualIndex}
 */
export function buildIndex(pages, getRenderer) {
  /** @type {ManualSection[]} */
  const sections = []
  /** @type {ManualIndex['pages']} */
  const indexPages = []
  pages.forEach((page, pageIndex) => {
    const pageSections = splitSections(getRenderer(page), page.markdown)
    const titleSection = pageSections.find(s => s.level === 1)
    const pageTitle = page.title || titleSection?.heading || page.path.split('/').pop()?.replace(/\.md$/i, '') || page.path
    indexPages.push({ path: page.path, title: pageTitle, source: page.source })
    const titleWords = words(pageTitle)
    const descriptionWords = page.description ? words(page.description) : []
    pageSections.forEach((section, i) => {
      const isTitle = section === titleSection || (!titleSection && i === 0)
      const headingWords = words(section.heading)
      const bodyWords = words(section.text)
      sections.push({
        page: pageIndex,
        path: page.path,
        pageTitle,
        source: page.source,
        heading: section.heading,
        level: isTitle ? 1 : section.level,
        anchor: isTitle && section.level <= 1 ? '' : section.anchor,
        occurrence: section.occurrence,
        text: section.text,
        description: isTitle ? page.description : undefined,
        headingWords,
        bodyWords,
        titleWords,
        descriptionWords: isTitle ? descriptionWords : [],
        headingFolded: headingWords.join(' '),
        bodyFolded: bodyWords.join(' '),
        isTitle
      })
    })
  })
  return { pages: indexPages, sections }
}

/**
 * How a query word occurs in a list of words.
 * @param {string[]} list
 * @param {string} word
 * @returns {0 | 1 | 2} 0: not at all, 1: as the start of a word, 2: as a whole word
 */
function occurrence(list, word) {
  let found = /** @type {0 | 1 | 2} */ (0)
  for (const candidate of list) {
    if (candidate === word) return 2
    if (candidate.startsWith(word)) found = 1
  }
  return found
}

/**
 * Whether a folded text contains a folded phrase at word boundaries.
 * @param {string} text
 * @param {string} phrase
 * @returns {boolean}
 */
function containsPhrase(text, phrase) {
  return phrase !== '' && ` ${text} `.includes(` ${phrase}`)
}

/**
 * The score of a section for a query.
 * @param {ManualSection} section
 * @param {ManualQuery} query
 * @returns {number} The score, 0 if the section does not match
 */
export function scoreSection(section, query) {
  if (query.words.length === 0) return 0
  const titleWeight = section.isTitle ? FIELD_WEIGHTS.title : FIELD_WEIGHTS.pageTitle
  /** @type {[string[], number][]} */
  const fields = [
    [section.isTitle ? section.titleWords : [], titleWeight],
    [section.isTitle ? [] : section.headingWords, FIELD_WEIGHTS.heading],
    [section.descriptionWords, FIELD_WEIGHTS.description],
    [section.bodyWords, FIELD_WEIGHTS.body],
    [section.isTitle ? [] : section.titleWords, FIELD_WEIGHTS.pageTitle]
  ]
  let score = 0
  for (const word of query.words) {
    let best = 0
    let exact = false
    for (const [list, weight] of fields) {
      const found = occurrence(list, word)
      if (found && weight > best) {
        best = weight
        exact = found === 2
      } else if (found === 2 && weight === best) {
        exact = true
      }
    }
    if (best === 0) return 0
    score += best + (exact ? 1 : 0)
  }
  const headingText = section.isTitle ? section.titleWords.join(' ') : section.headingFolded
  for (const phrase of query.phrases) {
    if (!containsPhrase(headingText, phrase) && !containsPhrase(section.bodyFolded, phrase) && !(section.isTitle && containsPhrase(section.descriptionWords.join(' '), phrase))) return 0
  }
  if (query.words.length > 1) {
    if (containsPhrase(headingText, query.folded)) score += 5
    else if (containsPhrase(section.bodyFolded, query.folded)) score += 2
  }
  return score
}

/**
 * A regular expression that finds the query words at the start of words, case-insensitively.
 * @param {string[]} queryWords - Folded query words
 * @returns {RegExp | null}
 */
function wordStartPattern(queryWords) {
  if (queryWords.length === 0) return null
  const escaped = [...queryWords].sort((a, b) => b.length - a.length).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})`, 'giu')
}

/**
 * Splits a text into parts that match the query words (at the start of words) and parts that do not, for
 * highlighting. Matching ignores case; diacritics must be typed.
 * @param {string} text
 * @param {string[]} queryWords - Folded query words
 * @returns {{text: string, match: boolean}[]}
 */
export function highlightParts(text, queryWords) {
  const pattern = wordStartPattern(queryWords)
  if (!pattern) return [{ text, match: false }]
  /** @type {{text: string, match: boolean}[]} */
  const parts = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = /** @type {number} */ (match.index)
    if (index > last) parts.push({ text: text.slice(last, index), match: false })
    parts.push({ text: match[0], match: true })
    last = index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false })
  return parts
}

/**
 * About `length` characters of a text around the first match of the query words, cut at word boundaries.
 * @param {string} text
 * @param {string[]} queryWords - Folded query words
 * @param {number} [length]
 * @returns {string} The snippet with "…" where it was cut, or the start of the text if nothing matches
 */
export function snippet(text, queryWords, length = 100) {
  const pattern = wordStartPattern(queryWords)
  const match = pattern ? pattern.exec(text) : null
  const index = match?.index ?? 0
  let start = Math.max(0, index - Math.floor(length / 3))
  let end = Math.min(text.length, start + length)
  if (start > 0) {
    const space = text.indexOf(' ', start)
    start = space !== -1 && space < index ? space + 1 : start
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    end = space > index ? space : end
  }
  return `${start > 0 ? '… ' : ''}${text.slice(start, end)}${end < text.length ? ' …' : ''}`
}

/**
 * Searches the index.
 * @param {ManualIndex} index
 * @param {string} query
 * @param {{maxPages?: number, sectionsPerPage?: number}} [options]
 * @returns {ManualPageHit[]} Pages with matching sections, best first; for an empty query all pages without
 *   sections, in manual order
 */
export function search(index, query, { maxPages = 10, sectionsPerPage = 3 } = {}) {
  const parsed = parseQuery(query)
  if (parsed.words.length === 0) {
    return index.pages.map(page => ({ ...page, score: 0, sections: [] }))
  }
  /** @type {Map<number, {page: number, hits: {section: ManualSection, score: number, order: number}[]}>} */
  const byPage = new Map()
  index.sections.forEach((section, order) => {
    const score = scoreSection(section, parsed)
    if (score === 0) return
    const entry = byPage.get(section.page) ?? { page: section.page, hits: [] }
    entry.hits.push({ section, score, order })
    byPage.set(section.page, entry)
  })
  const levelRank = (/** @type {ManualSection} */ s) => s.level || 7
  const pages = [...byPage.values()].map(entry => {
    entry.hits.sort((a, b) => b.score - a.score || levelRank(a.section) - levelRank(b.section) || a.order - b.order)
    return entry
  })
  pages.sort((a, b) => b.hits[0].score - a.hits[0].score || levelRank(a.hits[0].section) - levelRank(b.hits[0].section) || a.page - b.page)
  return pages.slice(0, maxPages).map(entry => {
    const page = index.pages[entry.page]
    return {
      path: page.path,
      title: page.title,
      source: page.source,
      score: entry.hits[0].score,
      sections: entry.hits.slice(0, sectionsPerPage).map(({ section, score }) => {
        const headingWords = section.isTitle ? section.titleWords : section.headingWords
        const inHeading = parsed.words.every(word => occurrence(headingWords, word) > 0)
        return {
          heading: section.heading || page.title,
          anchor: section.anchor,
          occurrence: section.occurrence,
          level: section.level,
          score,
          snippet: inHeading || !section.text ? '' : snippet(section.text, parsed.words)
        }
      })
    }
  })
}

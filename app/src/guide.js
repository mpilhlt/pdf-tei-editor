/**
 * Entry point of the standalone annotation guide window (app/web/guide.html), served by the backend for every path
 * below `/guide/`. The URL names the guide and section, e.g. `/guide/fossil-guidelines#citation-model`, and
 * `?ref=<commit>` a commit of the guide file (documents pin their guide refs to commits; see
 * modules/guide-links.js). `/guide/` lists the guides. The window does not start the application: it needs no login
 * and shows only the guide files that the extractors declare (`GET /api/v1/annotation-guides`), without the
 * personal versions of reviewers, which the guide drawer in the application shows.
 *
 * Guides are rendered by modules/guide-viewer.js, like in the guide drawer (plugins/annotation-guide.js). The
 * address bar always holds the link to the section clicked last.
 */

/**
 * @import { SlInput, SlIconButton } from './ui.js'
 * @import { AnnotationGuideItem, AnnotationGuidesResponse } from './modules/api-client-v1.js'
 * @import { MarkdownHeading } from './modules/markdown-utils.js'
 * @import { ManualSearchTarget } from './modules/manual-search-box.js'
 */

import '@shoelace-style/shoelace/dist/components/icon/icon.js'
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js'
import '@shoelace-style/shoelace/dist/components/input/input.js'
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js'
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js'
import { GuideViewer } from './modules/guide-viewer.js'
import { buildIndex } from './modules/manual-search.js'
import { ManualSearchBox, markSectionMatches } from './modules/manual-search-box.js'
import { guideUrlAtRef, guideWindowUrl, isCommitRef, parseGuideWindowUrl } from './modules/guide-links.js'
import { addHeadingLinkButtons } from './modules/markdown-toc.js'
import { notify } from './modules/sl-utils.js'

/**
 * The named elements of the window
 * @typedef {object} GuideWindowUi
 * @property {HTMLAnchorElement} homeLink
 * @property {HTMLSpanElement} titleText
 * @property {SlInput} searchInput
 * @property {HTMLDivElement} searchResults
 * @property {HTMLSpanElement} versionInfo
 * @property {SlIconButton} sourceBtn
 * @property {HTMLElement} toc
 * @property {HTMLDivElement} content
 * @property {HTMLParagraphElement} note
 */

const WINDOW_TITLE = 'Annotation Guide - PDF-TEI Editor'

const devMode = new URLSearchParams(window.location.search).has('dev')
if (!devMode) {
  // the bundle is served from the root, but the page from /guide/...: icons must not resolve against the page URL
  setBasePath('/')
}

/** @type {GuideWindowUi} */
const ui = /** @type {any} */ (Object.fromEntries(
  [...document.querySelectorAll('[data-name]')].map(el => [/** @type {HTMLElement} */ (el).dataset.name, el])
))

const viewer = new GuideViewer(ui.content)

/** @type {Promise<AnnotationGuideItem[]> | null} */
let guides = null

/** The guide shown: its entry, the commit ("" for the configured branch) and the Markdown @type {{guide: AnnotationGuideItem, ref: string, markdown: string, title: string} | null} */
let current = null

/**
 * The guide files the extractors declare.
 * @returns {Promise<AnnotationGuideItem[]>}
 */
function getGuides() {
  if (!guides) {
    guides = fetch('/api/v1/annotation-guides')
      .then(response => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        return response.json()
      })
      .then(data => /** @type {AnnotationGuidesResponse} */ (data).guides)
      .catch(error => {
        guides = null
        throw error
      })
  }
  return guides
}

/**
 * The window URL of a guide section, as a path for the address bar.
 * @param {string} id - Guide id, "" for the list
 * @param {string} [anchor]
 * @param {string} [ref]
 * @returns {string}
 */
function windowHref(id, anchor = '', ref = '') {
  const url = guideWindowUrl(id, anchor, { ref })
  if (!devMode) return url
  const [base, hash] = url.split('#')
  return `${base}${base.includes('?') ? '&' : '?'}dev${hash ? `#${hash}` : ''}`
}

/**
 * Renders the guide the URL names and scrolls to its section.
 * @param {string[]} [highlightWords] - Query words to highlight in the section
 * @param {number} [occurrence] - Index of the heading among those with the same anchor
 */
async function show(highlightWords = [], occurrence = 0) {
  const target = parseGuideWindowUrl(window.location.href) ?? { id: '', anchor: '', ref: '' }
  const ref = isCommitRef(target.ref) ? target.ref : ''
  if (current && current.guide.id === target.id && current.ref === ref && highlightWords.length === 0) {
    scrollTo(target.anchor, occurrence)
    return
  }
  let list
  try {
    list = await getGuides()
  } catch (error) {
    showMessage('The annotation guides could not be loaded', error instanceof Error ? error.message : String(error))
    return
  }
  if (!target.id) {
    showList(list)
    return
  }
  const guide = list.find(g => g.id === target.id)
  if (!guide) {
    showMessage('Guide not found', `There is no annotation guide "${target.id}".`, list)
    return
  }
  const url = guideUrlAtRef(guide, ref)
  let markdown
  try {
    markdown = await viewer.fetch(url)
  } catch (error) {
    showMessage('The guide could not be loaded', error instanceof Error ? error.message : String(error), list)
    return
  }
  const rendered = viewer.render(markdown, url)
  current = { guide, ref, markdown, title: rendered.title }
  searchBox.invalidate()
  document.title = `${rendered.title} - ${WINDOW_TITLE}`
  ui.titleText.textContent = rendered.title
  ui.homeLink.href = windowHref(guide.id, '', ref)
  ui.versionInfo.textContent = ref ? `Version ${ref.slice(0, 7)}` : ''
  ui.versionInfo.title = ref ? `The guide at commit ${ref}, which the document refers to` : ''
  ui.sourceBtn.hidden = false
  ui.searchInput.disabled = false
  ui.note.hidden = false
  addHeadingLinkButtons(ui.content, anchor => copyLink(anchor))
  renderToc(rendered.headings)
  if (highlightWords.length > 0) {
    const heading = target.anchor ? ui.content.querySelectorAll(`[id="${CSS.escape(target.anchor)}"]`)[occurrence] ?? null : null
    markSectionMatches(ui.content, heading, highlightWords)
  }
  if (target.anchor) {
    // images above the heading must take up their space first
    await imagesLoaded(ui.content, 3000)
    scrollTo(target.anchor, occurrence, 'auto')
  } else {
    window.scrollTo({ top: 0 })
  }
}

/**
 * Shows no guide: clears the guide controls.
 * @param {string} title - Heading of the page
 */
function resetPage(title) {
  current = null
  searchBox.invalidate()
  document.title = `${title} - ${WINDOW_TITLE}`
  ui.titleText.textContent = 'Annotation Guide'
  ui.homeLink.href = windowHref('')
  ui.versionInfo.textContent = ''
  ui.sourceBtn.hidden = true
  ui.searchInput.disabled = true
  ui.note.hidden = true
  ui.toc.replaceChildren()
}

/**
 * Lists the guides with links to the sections the extractors point to.
 * @param {AnnotationGuideItem[]} list
 * @returns {HTMLUListElement}
 */
function guideList(list) {
  const ul = document.createElement('ul')
  ul.className = 'guide-window-list'
  for (const guide of list) {
    const li = document.createElement('li')
    li.append(guideLink(guide.id, '', guide.url.split('/').pop() || guide.id))
    if (guide.sections.length > 0) {
      const sections = document.createElement('ul')
      for (const section of guide.sections) {
        const item = document.createElement('li')
        item.append(guideLink(guide.id, section.anchor, section.label))
        sections.append(item)
      }
      li.append(sections)
    }
    ul.append(li)
  }
  return ul
}

/**
 * A link to a guide section that stays in the window.
 * @param {string} id
 * @param {string} anchor
 * @param {string} text
 * @returns {HTMLAnchorElement}
 */
function guideLink(id, anchor, text) {
  const link = document.createElement('a')
  link.href = windowHref(id, anchor)
  link.textContent = text
  link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    window.history.pushState({}, '', link.href)
    show()
  })
  return link
}

/**
 * Shows the list of guides.
 * @param {AnnotationGuideItem[]} list
 */
function showList(list) {
  resetPage('Annotation Guides')
  const heading = document.createElement('h1')
  heading.textContent = 'Annotation Guides'
  if (list.length === 0) {
    const text = document.createElement('p')
    text.className = 'manual-window-message'
    text.textContent = 'No extractor provides an annotation guide.'
    ui.content.replaceChildren(heading, text)
    return
  }
  ui.content.replaceChildren(heading, guideList(list))
}

/**
 * Shows a message instead of a guide, and the list of guides if given.
 * @param {string} title
 * @param {string} message
 * @param {AnnotationGuideItem[]} [list]
 */
function showMessage(title, message, list) {
  resetPage(title)
  const heading = document.createElement('h1')
  heading.textContent = title
  const text = document.createElement('p')
  text.className = 'manual-window-message'
  text.textContent = message
  ui.content.replaceChildren(heading, text)
  if (list && list.length > 0) {
    const intro = document.createElement('p')
    intro.textContent = 'The annotation guides:'
    ui.content.append(intro, guideList(list))
  }
}

/**
 * Scrolls to a heading of the guide shown.
 * @param {string} anchor
 * @param {number} [occurrence]
 * @param {ScrollBehavior} [behavior]
 */
function scrollTo(anchor, occurrence = 0, behavior = 'smooth') {
  if (!anchor) {
    window.scrollTo({ top: 0, behavior })
    return
  }
  viewer.scrollToAnchor(anchor, behavior, occurrence)
}

/**
 * Waits until the images in an element are loaded (or failed), at most `timeout` milliseconds.
 * @param {HTMLElement} element
 * @param {number} timeout
 * @returns {Promise<void>}
 */
async function imagesLoaded(element, timeout) {
  const pending = [...element.querySelectorAll('img')].filter(img => !img.complete)
    .map(img => new Promise(resolve => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    }))
  await Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, timeout))])
}

/**
 * Lists the headings of the guide in the sidebar.
 * @param {MarkdownHeading[]} headings
 */
function renderToc(headings) {
  if (!current) return
  const { guide, ref } = current
  ui.toc.replaceChildren(...headings.filter(h => h.level > 1 && h.level <= 4).map(heading => {
    const link = document.createElement('a')
    link.href = windowHref(guide.id, heading.anchor, ref)
    link.dataset.level = String(heading.level)
    link.textContent = heading.text
    link.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      window.history.pushState({}, '', link.href)
      scrollTo(heading.anchor, heading.occurrence)
    })
    return link
  }))
}

/**
 * Copies the link of a section of the guide shown.
 * @param {string} anchor
 */
async function copyLink(anchor) {
  if (!current) return
  const url = guideWindowUrl(current.guide.id, anchor, { ref: current.ref, origin: window.location.origin })
  try {
    await navigator.clipboard.writeText(url)
    notify('Link copied to the clipboard', 'success', 'check-circle')
  } catch {
    notify(`Could not copy the link: ${url}`, 'warning', 'exclamation-triangle', 10000)
  }
}

const searchBox = new ManualSearchBox({
  input: ui.searchInput,
  panel: ui.searchResults,
  subject: 'the guide',
  groupByPage: false,
  loadIndex: async () => {
    if (!current) throw new Error('No guide is shown')
    return buildIndex([{ path: current.guide.id, title: current.title, markdown: current.markdown }], () => viewer.md)
  },
  onOpen: (/** @type {ManualSearchTarget} */ target) => {
    if (!current) return
    ui.searchInput.blur()
    window.history.pushState({}, '', windowHref(current.guide.id, target.anchor, current.ref))
    const heading = target.anchor ? ui.content.querySelectorAll(`[id="${CSS.escape(target.anchor)}"]`)[target.occurrence] ?? null : null
    markSectionMatches(ui.content, heading, target.words)
    scrollTo(target.anchor, target.occurrence)
  }
})

ui.homeLink.addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey) return
  event.preventDefault()
  window.history.pushState({}, '', ui.homeLink.href)
  show()
})
ui.sourceBtn.addEventListener('click', () => {
  if (current) window.open(guideUrlAtRef(current.guide, current.ref), '_blank', 'noopener')
})
document.addEventListener('keydown', event => {
  const typing = event.composedPath().some(el => el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
  if ((event.key === '/' && !typing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
    event.preventDefault()
    ui.searchInput.focus()
  }
})
window.addEventListener('popstate', () => show())

show()

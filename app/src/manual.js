/**
 * Entry point of the standalone user manual window (app/web/manual.html), served by the backend for every path below
 * `/manual/`. The URL names the page and section, e.g. `/manual/user-manual/review-workflow#unit-review`, and
 * `?lang=de` the language of plugin pages (see `manualWindowUrl()` in modules/manual-links.js). The window does not
 * start the application: it needs no login and shows the pages of all active plugins, since roles only keep the
 * manual in the app free of pages that do not concern the user.
 *
 * Pages are rendered by modules/manual-viewer.js, like in the manual drawer (plugins/info.js). Navigation uses the
 * browser history, so the address bar always holds the link to share.
 */

/**
 * @import { SlInput, SlIconButton } from './ui.js'
 * @import { ManualContributionItem, ManualPagesResponse, ManualContributionsResponse } from './modules/api-client-v1.js'
 * @import { MarkdownHeading } from './modules/markdown-utils.js'
 * @import { ManualSearchTarget } from './modules/manual-search-box.js'
 */

import '@shoelace-style/shoelace/dist/components/icon/icon.js'
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js'
import '@shoelace-style/shoelace/dist/components/input/input.js'
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js'
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js'
import { ManualViewer, resolveManualPath } from './modules/manual-viewer.js'
import { ManualSearchBox, loadManualIndex, markSectionMatches } from './modules/manual-search-box.js'
import { manualWindowUrl, parseManualWindowUrl } from './modules/manual-links.js'
import { addHeadingLinkButtons } from './modules/markdown-toc.js'
import { notify } from './modules/sl-utils.js'

/**
 * The named elements of the window
 * @typedef {object} ManualWindowUi
 * @property {HTMLAnchorElement} homeLink
 * @property {SlInput} searchInput
 * @property {HTMLDivElement} searchResults
 * @property {HTMLSpanElement} versionInfo
 * @property {SlIconButton} editGitHubBtn
 * @property {HTMLElement} toc
 * @property {HTMLDivElement} content
 */

const GITHUB_EDIT_BASE = 'https://github.com/mpilhlt/pdf-tei-editor/edit/devel/docs'
const DOCS_BASE = '/docs'

const devMode = new URLSearchParams(window.location.search).has('dev')
if (!devMode) {
  // the bundle is served from the root, but the page from /manual/...: icons must not resolve against the page URL
  setBasePath('/')
}

/** @type {ManualWindowUi} */
const ui = /** @type {any} */ (Object.fromEntries(
  [...document.querySelectorAll('[data-name]')].map(el => [/** @type {HTMLElement} */ (el).dataset.name, el])
))

/** Language requested in the URL, kept while navigating */
let lang = new URLSearchParams(window.location.search).get('lang') || ''

/** @type {Promise<ManualContributionItem[]> | null} */
let contributions = null

/**
 * The pages of all active plugins.
 * @returns {Promise<ManualContributionItem[]>}
 */
function getContributions() {
  if (!contributions) {
    contributions = fetch('/api/v1/manual/contributions?all_roles=true')
      .then(response => response.ok ? response.json() : { contributions: [] })
      .then(data => /** @type {ManualContributionsResponse} */ (data).contributions)
      .catch(() => [])
  }
  return contributions
}

const viewer = new ManualViewer({
  container: ui.content,
  getDocsBases: async () => [DOCS_BASE],
  getContributions,
  onNavigate: target => navigate(target)
})

/**
 * The window URL of a page, as a path for the address bar.
 * @param {string} path - Page path
 * @param {string} [anchor]
 * @returns {string}
 */
function windowHref(path, anchor = '') {
  const url = manualWindowUrl(path, anchor, { lang })
  if (!devMode) return url
  const [base, hash] = url.split('#')
  return `${base}${base.includes('?') ? '&' : '?'}dev${hash ? `#${hash}` : ''}`
}

/**
 * Goes to a manual page, adding it to the browser history.
 * @param {string} target - "path#anchor", relative to the current page or with a leading "/" relative to `docs/`
 * @param {string[]} [highlightWords] - Query words to highlight in the section
 * @param {number} [occurrence] - Index of the heading among those with the same anchor
 */
async function navigate(target, highlightWords = [], occurrence = 0) {
  const { path, anchor } = resolveManualPath(viewer.currentPage || 'index.md', target)
  window.history.pushState({}, '', windowHref(path, anchor))
  await show(highlightWords, occurrence)
}

/**
 * Renders the page the URL names and scrolls to its section.
 * @param {string[]} [highlightWords] - Query words to highlight in the section
 * @param {number} [occurrence] - Index of the heading among those with the same anchor
 */
async function show(highlightWords = [], occurrence = 0) {
  const target = parseManualWindowUrl(window.location.href) ?? { path: 'index.md', anchor: '', lang: '' }
  if (target.path === viewer.currentPage && ui.content.childElementCount > 0 && highlightWords.length === 0) {
    scrollTo(target.anchor, occurrence)
    return
  }
  let rendered
  try {
    rendered = await viewer.render(target.path, { lang })
  } catch {
    showNotFound(target.path)
    return
  }
  document.title = `${rendered.title} - PDF-TEI Editor User Manual`
  ui.editGitHubBtn.hidden = Boolean(rendered.pluginPage)
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
 * Scrolls to a heading of the page shown.
 * @param {string} anchor
 * @param {number} [occurrence]
 * @param {ScrollBehavior} [behavior]
 */
function scrollTo(anchor, occurrence = 0, behavior = 'smooth') {
  if (!anchor) {
    window.scrollTo({ top: 0, behavior })
    return
  }
  const heading = ui.content.querySelectorAll(`[id="${CSS.escape(anchor)}"]`)[occurrence]
  heading?.scrollIntoView({ behavior, block: 'start' })
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
 * @param {string} path
 */
function showNotFound(path) {
  document.title = 'Page not found - PDF-TEI Editor User Manual'
  ui.editGitHubBtn.hidden = true
  ui.toc.replaceChildren()
  const heading = document.createElement('h1')
  heading.textContent = 'Page not found'
  const text = document.createElement('p')
  text.className = 'manual-window-message'
  text.textContent = `The manual has no page "${path}". Search the manual above, or go to the `
  const link = document.createElement('a')
  link.href = windowHref('index.md')
  link.textContent = 'start page'
  link.addEventListener('click', event => {
    event.preventDefault()
    navigate('/index.md')
  })
  text.append(link, '.')
  ui.content.replaceChildren(heading, text)
}

/**
 * Lists the headings of the page in the sidebar.
 * @param {MarkdownHeading[]} headings
 */
function renderToc(headings) {
  ui.toc.replaceChildren(...headings.filter(h => h.level > 1 && h.level <= 4).map(heading => {
    const link = document.createElement('a')
    link.href = windowHref(viewer.currentPage, heading.anchor)
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
 * Copies the link of a section of the page shown.
 * @param {string} anchor
 */
async function copyLink(anchor) {
  const url = manualWindowUrl(viewer.currentPage, anchor, { lang, origin: window.location.origin })
  try {
    await navigator.clipboard.writeText(url)
    notify('Link copied to the clipboard', 'success', 'check-circle')
  } catch {
    notify(`Could not copy the link: ${url}`, 'warning', 'exclamation-triangle', 10000)
  }
}

/**
 * Shows the version of the application next to the search field.
 */
async function showVersion() {
  try {
    const response = await fetch('/version.js')
    if (!response.ok) return
    const match = (await response.text()).match(/export\s+const\s+version\s*=\s*['"]([^'"]+)['"]/)
    if (match) ui.versionInfo.textContent = `v${match[1]}`
  } catch {
    // no version in development mode
  }
}

const searchBox = new ManualSearchBox({
  input: ui.searchInput,
  panel: ui.searchResults,
  loadIndex: async () => {
    const response = await fetch('/api/v1/manual/pages')
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const { pages } = /** @type {ManualPagesResponse} */ (await response.json())
    return loadManualIndex(viewer, pages, await getContributions(), lang ? [lang, ...navigator.languages] : navigator.languages)
  },
  onOpen: (/** @type {ManualSearchTarget} */ target) => {
    ui.searchInput.blur()
    navigate(`/${target.path}${target.anchor ? `#${target.anchor}` : ''}`, target.words, target.occurrence)
  }
})
void searchBox

ui.homeLink.href = windowHref('index.md')
ui.homeLink.addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey) return
  event.preventDefault()
  navigate('/index.md')
})
ui.editGitHubBtn.addEventListener('click', () => window.open(`${GITHUB_EDIT_BASE}/${viewer.currentPage}`, '_blank', 'noopener'))
document.addEventListener('keydown', event => {
  const typing = event.composedPath().some(el => el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
  if ((event.key === '/' && !typing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) {
    event.preventDefault()
    ui.searchInput.focus()
  }
})
window.addEventListener('popstate', () => {
  lang = new URLSearchParams(window.location.search).get('lang') || ''
  show()
})

// links to a ".md" file show the page under its clean URL
const initial = parseManualWindowUrl(window.location.href)
if (initial && /\.md\/?$/i.test(window.location.pathname)) {
  window.history.replaceState({}, '', windowHref(initial.path, initial.anchor))
}
showVersion()
show()

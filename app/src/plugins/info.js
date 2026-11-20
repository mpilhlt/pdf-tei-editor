/**
 * This implements a drawer with the end-user documentation taken from the "docs" folder
 * in the app root. The pages are rendered by app/src/modules/manual-viewer.js, which is shared with the standalone
 * manual window (app/src/manual.js, URL `/manual/<page>#<heading>`). Links to local documentation are loaded into
 * the drawer, links to external resources open in a new browser tab.
 *
 * Clicks on manual links anywhere in the app (GitHub blob URLs of files in `docs/` and manual window URLs, see
 * app/src/modules/manual-links.js) are intercepted and open the linked section in the drawer.
 * The footer has a table of contents drop-up, and each heading a button that copies the manual window URL of its
 * section. The search button in the header replaces the title with a full-text search field
 * (app/src/modules/manual-search-box.js); the "Open in new window" button shows the current section in the manual
 * window.
 *
 * Slots in the manual pages (`<!-- plugin-docs: <slot> -->`) list the pages that plugins contribute
 * (see app/src/modules/manual-slots.js). These pages are shown under the virtual path
 * `plugins/<plugin id>/<file>` and rendered without raw HTML.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDrawer, SlMenuItem } from '../ui.js'
 * @import { MarkdownHeading } from '../modules/markdown-utils.js'
 * @import { infoDrawerPart } from '../templates/info-drawer.types.js'
 * @import { ManualContributionItem } from '../modules/api-client-v1.js'
 * @import { ManualSearchTarget } from '../modules/manual-search-box.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { addHeadingLinkButtons, fitTocMenu, populateTocMenu, scrollToHeading, visibleHeadingAnchor } from '../modules/markdown-toc.js'
import { manualWindowUrl, parseManualUrl, parseManualWindowUrl } from '../modules/manual-links.js'
import { notify } from '../modules/sl-utils.js'
import { ManualViewer, resolveManualPath } from '../modules/manual-viewer.js'
import { ManualSearchBox, attachDrawerSearch, loadManualIndex, markSectionMatches } from '../modules/manual-search-box.js'

// Register templates
await registerTemplate('info-dialog', 'info-drawer.html');
await registerTemplate('about-button', 'about-button.html');
await registerTemplate('info-menu-item', 'info-menu-item.html');

/** Name of the browser window the manual opens in, so that it is reused */
export const MANUAL_WINDOW_NAME = 'pte-manual'

class InfoPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'info', deps: ['authentication', 'client', 'toolbar', 'help', 'logger', 'config', 'dialog'] })
  }

  /** @type {SlDrawer & infoDrawerPart} */
  #ui = null

  /** @type {ManualViewer | null} */
  #viewer = null

  /** @type {ManualSearchBox | null} */
  #searchBox = null

  /** Shows or hides the search field in place of the title @type {(show: boolean) => void} */
  #toggleSearch = () => {}

  /**
   * Pages contributed by plugins, for the user they were loaded for
   * @type {{username: string, contributions: ManualContributionItem[]} | null}
   */
  #contributions = null

  #localDocsBasePath = "../../docs"

  #remoteDocsBasePath = "https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/refs/heads/main/docs"

  /**
   * GitHub's web editor only works on branches, not on tags, so edits always
   * target the development branch, where documentation changes are merged.
   */
  #githubEditBasePath = "https://github.com/mpilhlt/pdf-tei-editor/edit/devel/docs"

  #enableCache = true

  /** @type {string[]} */
  #navigationHistory = []

  /** @type {string[]} */
  #forwardHistory = []

  #currentPage = 'index.md'

  /** @type {MarkdownHeading[]} */
  #headings = []

  /**
   * @param {ApplicationState} _state
   */
  async install(_state) {
    await super.install(_state)
    const logger = this.getDependency('logger')
    logger.debug(`Installing plugin "info"`)

    this.#ui = this.createUi(createSingleFromTemplate('info-dialog', document.body))

    this.#viewer = new ManualViewer({
      container: this.#ui.content,
      getDocsBases: () => this.#getDocsBases(),
      getContributions: () => this.#getContributions(),
      onNavigate: target => this.load(target),
      isCacheEnabled: () => this.#enableCache
    })

    this.#ui.closeBtn.addEventListener('click', () => this.#ui.hide())
    this.#ui.backBtn.addEventListener('click', () => this.goBack())
    this.#ui.homeBtn.addEventListener('click', () => this.goHome())
    this.#ui.forwardBtn.addEventListener('click', () => this.goForward())
    this.#ui.tocDropdown.addEventListener('sl-show', () => fitTocMenu(this.#ui, this.#ui.tocDropdown.tocMenu))
    this.#ui.tocDropdown.tocMenu.addEventListener('sl-select', event => {
      const item = /** @type {SlMenuItem} */ (/** @type {CustomEvent} */ (event).detail.item)
      const heading = this.#headings[Number(item.value)]
      if (heading && !scrollToHeading(this.#ui.content, heading)) {
        logger.warn(`Heading #${heading.anchor} not found in the user manual`)
      }
    })
    document.addEventListener('click', event => this.#interceptManualLink(event), true)
    this.#ui.editGitHubBtn.addEventListener('click', () => {
      const githubUrl = `${this.#githubEditBasePath}/${this.#currentPage}`
      window.open(githubUrl, '_blank')
    })
    this.#ui.openWindowBtn.addEventListener('click', () => this.openInWindow())

    this.#searchBox = new ManualSearchBox({
      input: this.#ui.searchInput,
      panel: this.#ui.searchResults,
      loadIndex: async () => {
        const viewer = /** @type {ManualViewer} */ (this.#viewer)
        const { pages } = await this.getDependency('client').apiClient.manualPages()
        return loadManualIndex(viewer, pages, await this.#getContributions())
      },
      onOpen: target => this.#openSearchResult(target),
      onClose: () => this.#toggleSearch(false)
    })
    this.#toggleSearch = attachDrawerSearch(
      { drawer: this.#ui, button: this.#ui.searchBtn, input: this.#ui.searchInput, title: this.#ui.titleText },
      () => this.#searchBox
    )

    const aboutButton = createSingleFromTemplate('about-button')
    aboutButton.addEventListener('click', () => this.#showHelpFromLoginDialog())
    this.getDependency('authentication').appendToLoginDialog(aboutButton)

    this.#loadVersion().then(version => {
      if (version) {
        this.#ui.versionInfo.textContent = `v${version}`
        const versionTag = `v${version}`
        this.#remoteDocsBasePath = `https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/refs/tags/${versionTag}/docs`
        logger.debug(`Remote docs path: ${this.#remoteDocsBasePath}`)
      }
    }).catch(error => {
      logger.debug('Failed to load version:', error)
    })

    this.getDependency('help').registerTopic(
      'User Manual',
      'book',
      () => this.open()
    )

    // @ts-ignore
    window.appInfo = this
  }

  /**
   * Opens the user manual drawer, at the given page if one is given, otherwise at the page
   * shown last (the index page the first time).
   * @param {string} [page] - Path relative to the "docs" dir, optionally with a "#anchor"; a leading
   *   "/" is optional
   */
  async open(page) {
    this.#updateNavigationButtons()
    this.#ui.show()
    if (page) {
      await this.load(page.startsWith('/') ? page : `/${page}`)
    } else if (this.#navigationHistory.length === 0) {
      await this.load('index.md')
    }
  }

  /**
   * Opens the user manual at the section a manual link points to.
   * @param {string} url - A manual link: a GitHub blob URL or a manual window URL (see app/src/modules/manual-links.js)
   * @returns {Promise<boolean>} Whether `url` is a manual link
   */
  async openUrl(url) {
    const target = parseManualUrl(url) ?? parseManualWindowUrl(url, window.location.origin)
    if (!target) return false
    await this.open(target.anchor ? `${target.path}#${target.anchor}` : target.path)
    return true
  }

  /**
   * The manual window URL of a section of the current page.
   * @param {string} [anchor] - Heading anchor without "#"
   * @returns {string}
   */
  linkTo(anchor) {
    return manualWindowUrl(this.#currentPage, anchor, { origin: window.location.origin })
  }

  /**
   * Shows the current page, at the heading nearest the top of the drawer, in the manual window.
   */
  openInWindow() {
    let url = this.linkTo(visibleHeadingAnchor(this.#ui, this.#ui.content))
    // in development mode, the window loads the sources as well
    if (new URLSearchParams(window.location.search).has('dev')) {
      const [base, hash] = url.split('#')
      url = `${base}${base.includes('?') ? '&' : '?'}dev${hash ? `#${hash}` : ''}`
    }
    window.open(url, MANUAL_WINDOW_NAME, 'popup,width=1100,height=900')
  }

  /**
   * Where the core manual pages are fetched from: GitHub at the tag of the running version if configured and
   * reachable, then the local docs.
   * @returns {Promise<string[]>}
   */
  async #getDocsBases() {
    const useGitHubDocs = await this.getDependency('config').get("docs.from-github", false)
    if (useGitHubDocs && await this.#checkOnlineConnectivity()) {
      return [this.#remoteDocsBasePath, this.#localDocsBasePath]
    }
    return [this.#localDocsBasePath]
  }

  /**
   * The pages plugins contribute to the manual that the current user can see; none if nobody is logged in.
   * Loaded once per user.
   * @returns {Promise<ManualContributionItem[]>}
   */
  async #getContributions() {
    const username = this.state?.user?.username
    if (!username) return []
    if (this.#contributions?.username !== username) {
      try {
        const { contributions } = await this.getDependency('client').apiClient.manualContributions()
        this.#contributions = { username, contributions }
        this.#searchBox?.invalidate()
      } catch (error) {
        this.getDependency('logger').warn(`Could not load the manual pages of plugins: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }
    return this.#contributions.contributions
  }

  /**
   * Opens a search result and highlights the query words in its section.
   * @param {ManualSearchTarget} target
   */
  async #openSearchResult(target) {
    this.#toggleSearch(false)
    await this.load(`/${target.path}`)
    const heading = target.anchor
      ? this.#ui.content.querySelectorAll(`[id="${CSS.escape(target.anchor)}"]`)[target.occurrence] ?? null
      : null
    markSectionMatches(this.#ui.content, heading, target.words)
    if (heading) {
      setTimeout(() => heading.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    }
  }

  /**
   * Loads a manual page into the drawer.
   * @param {string} mdPath The path to the md file: relative to the current page, or relative to the "docs" dir
   *   with a leading "/"; optionally with "#anchor"
   * @param {boolean} addToHistory Whether to add this page to navigation history (default: true)
   */
  async load(mdPath, addToHistory = true) {
    const { path, anchor } = resolveManualPath(this.#currentPage, mdPath)
    if (mdPath.startsWith('#')) {
      // a link to a section of the current page
      this.#scrollToAnchor(anchor)
      return
    }
    const historyEntry = anchor ? `${path}#${anchor}` : path

    if (addToHistory && (this.#navigationHistory.length === 0 || this.#navigationHistory[this.#navigationHistory.length - 1] !== historyEntry)) {
      this.#navigationHistory.push(historyEntry)
      this.#forwardHistory = []
      this.#updateNavigationButtons()
    }

    this.#currentPage = path
    this.#updateToc([])

    const viewer = /** @type {ManualViewer} */ (this.#viewer)
    let rendered
    try {
      rendered = await viewer.render(path)
    } catch (error) {
      this.getDependency('dialog').error(`Failed to load documentation: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.#currentPage = rendered.path
    this.#ui.editGitHubBtn.style.display = rendered.pluginPage ? 'none' : ''
    this.#updateToc(rendered.headings)
    addHeadingLinkButtons(this.#ui.content, anchor => this.#copyLink(anchor))
    this.#scrollAfterLoad(anchor)
  }

  /**
   * Scrolls to a heading of the page just loaded, or to the top
   * @param {string} anchor - Heading anchor, or "" for the top
   */
  #scrollAfterLoad(anchor) {
    if (anchor) {
      setTimeout(() => this.#scrollToAnchor(anchor), 100)
    } else {
      const body = this.#ui.shadowRoot?.querySelector('[part="body"]')
      if (body) body.scrollTop = 0
    }
  }

  /**
   * Rebuilds the table of contents drop-up from the headings of the current page
   * @param {MarkdownHeading[]} headings
   */
  #updateToc(headings) {
    this.#headings = headings
    populateTocMenu(this.#ui.tocDropdown, this.#ui.tocDropdown.tocMenu, headings)
  }

  /**
   * Scrolls the drawer to the heading with the given id on the current page
   * @param {string} anchor - Heading anchor without "#"
   */
  #scrollToAnchor(anchor) {
    if (!anchor) return
    if (!this.#viewer?.scrollToAnchor(anchor)) {
      this.getDependency('logger').warn(`Anchor #${anchor} not found in ${this.#currentPage}`)
    }
  }

  /**
   * Copies the manual window URL of a heading of the current page to the clipboard
   * @param {string} anchor - Heading anchor without "#"
   */
  async #copyLink(anchor) {
    const url = this.linkTo(anchor)
    try {
      await navigator.clipboard.writeText(url)
      notify('Link copied to the clipboard', 'success', 'check-circle')
    } catch (error) {
      this.getDependency('logger').warn(`Could not copy ${url}: ${error instanceof Error ? error.message : String(error)}`)
      notify(`Could not copy the link: ${url}`, 'warning', 'exclamation-triangle', 10000)
    }
  }

  /**
   * Capturing click handler on the document: opens manual links (see
   * app/src/modules/manual-links.js) in the drawer instead of a new tab. Clicks with a
   * modifier key keep the browser's behaviour. A link in an open dialog closes the
   * dialog, which is shown again when the drawer closes.
   * @param {MouseEvent} event
   */
  #interceptManualLink(event) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const path = event.composedPath()
    const link = /** @type {HTMLAnchorElement | undefined} */ (path.find(el => el instanceof HTMLAnchorElement && el.href))
    if (!link || !(parseManualUrl(link.href) || parseManualWindowUrl(link.href, window.location.origin))) return
    event.preventDefault()
    event.stopPropagation()
    const dialog = /** @type {(HTMLElement & {open: boolean, show: () => Promise<void>, hide: () => Promise<void>}) | undefined} */ (
      path.find(el => el instanceof HTMLElement && el.tagName === 'SL-DIALOG' && /** @type {any} */ (el).open))
    if (dialog) {
      dialog.hide()
      this.#onNextClose(() => dialog.show())
    }
    this.openUrl(link.href)
  }

  /**
   * Calls `callback` once when the drawer closes next (ignoring the `sl-hide` events of
   * components inside the drawer, such as the TOC drop-up).
   * @param {() => void} callback
   */
  #onNextClose(callback) {
    /** @param {Event} event */
    const listener = event => {
      if (event.target !== this.#ui) return
      this.#ui.removeEventListener('sl-hide', listener)
      callback()
    }
    this.#ui.addEventListener('sl-hide', listener)
  }

  /**
   * Goes back to the previous page in navigation history
   */
  goBack() {
    if (this.#navigationHistory.length > 1) {
      const currentPage = this.#navigationHistory.pop()
      if (currentPage) {
        this.#forwardHistory.push(currentPage)
      }
      const previousPage = this.#navigationHistory[this.#navigationHistory.length - 1]
      this.load(`/${previousPage}`, false)
      this.#updateNavigationButtons()
    }
  }

  /**
   * Goes to the home page (index.md)
   */
  goHome() {
    this.load('/index.md')
  }

  /**
   * Goes forward to the next page in forward history
   */
  goForward() {
    if (this.#forwardHistory.length > 0) {
      const nextPage = this.#forwardHistory.pop()
      if (nextPage) {
        // history entries are resolved paths, so they must not be resolved again; loading
        // with addToHistory would also clear the remaining forward history
        this.#navigationHistory.push(nextPage)
        this.load(`/${nextPage}`, false)
        this.#updateNavigationButtons()
      }
    }
  }

  /**
   * Closes the info drawer
   */
  close() {
    this.#ui.hide()
  }

  /**
   * Sets whether to enable browser caching for documentation
   * @param {boolean} value
   */
  setEnableCache(value) {
    this.#enableCache = value
    this.getDependency('logger').debug(`Documentation caching ${value ? 'enabled' : 'disabled'}`)
  }

  /**
   * Updates the navigation button states based on history
   */
  #updateNavigationButtons() {
    this.#ui.backBtn.disabled = this.#navigationHistory.length <= 1
    this.#ui.forwardBtn.disabled = this.#forwardHistory.length === 0
  }

  #showHelpFromLoginDialog() {
    const auth = this.getDependency('authentication')
    auth.hideLoginDialog()
    this.#onNextClose(() => auth.showLoginDialog())
    this.open()
  }

  /**
   * Loads the application version from version.js
   * @returns {Promise<string|null>}
   */
  async #loadVersion() {
    try {
      const response = await fetch('version.js')
      if (!response.ok) return null
      const text = await response.text()
      const match = text.match(/export\s+const\s+version\s*=\s*['"]([^'"]+)['"]/)
      return match ? match[1] : null
    } catch (error) {
      this.getDependency('logger').debug('Could not load version.js:', error)
      return null
    }
  }

  /**
   * Checks if online connectivity is available with a short timeout
   * @param {number} timeout
   * @returns {Promise<boolean>}
   */
  async #checkOnlineConnectivity(timeout = 3000) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)
      const response = await fetch(`${this.#remoteDocsBasePath}/index.md`, {
        method: 'HEAD',
        signal: controller.signal,
        cache: 'no-cache'
      })
      clearTimeout(timeoutId)
      return response.ok
    } catch (error) {
      return false
    }
  }
}

export default InfoPlugin


export const plugin = InfoPlugin

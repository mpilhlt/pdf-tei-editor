/**
 * This implements a modal window with the end-user documentation taken from the "docs" folder
 * in the app root. The documentation is written in markdown and converted to HTML using
 * the markdown-it library. Links to local documentation are intercepted and loaded into the dialog.
 * Links to external resources are opened in a new browser tab.
 *
 * Clicks on manual links anywhere in the app (GitHub blob URLs of files in `docs/`, see
 * app/src/modules/manual-links.js) are intercepted and open the linked section in the drawer.
 * The footer has a table of contents drop-up, and each heading a button that copies its manual link.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import MarkdownIt from 'markdown-it'
 * @import { SlDrawer, SlMenuItem } from '../ui.js'
 * @import { MarkdownHeading } from '../modules/markdown-utils.js'
 * @import { infoDrawerPart } from '../templates/info-drawer.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { createMarkdownRenderer, extractHeadings } from '../modules/markdown-utils.js'
import { addHeadingLinkButtons, fitTocMenu, populateTocMenu, scrollToHeading } from '../modules/markdown-toc.js'
import { manualUrl, parseManualUrl } from '../modules/manual-links.js'
import { notify } from '../modules/sl-utils.js'

// Register templates
await registerTemplate('info-dialog', 'info-drawer.html');
await registerTemplate('about-button', 'about-button.html');
await registerTemplate('info-menu-item', 'info-menu-item.html');

class InfoPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'info', deps: ['authentication', 'toolbar', 'help', 'logger', 'config', 'dialog'] })
  }

  /** @type {SlDrawer & infoDrawerPart} */
  #ui = null

  /** @type {MarkdownIt | null} */
  #md = null

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

  /**
   * Git ref of the manual links copied from headings: the tag of the running version if known
   * @type {string}
   */
  #docsRef = 'main'

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
    this.#ui.content.addEventListener('click', event => this.#handleContentClick(event))
    document.addEventListener('click', event => this.#interceptManualLink(event), true)
    this.#ui.editGitHubBtn.addEventListener('click', () => {
      const githubUrl = `${this.#githubEditBasePath}/${this.#currentPage}`
      window.open(githubUrl, '_blank')
    })

    const aboutButton = createSingleFromTemplate('about-button')
    aboutButton.addEventListener('click', () => this.#showHelpFromLoginDialog())
    this.getDependency('authentication').appendToLoginDialog(aboutButton)

    this.#loadVersion().then(version => {
      if (version) {
        this.#ui.versionInfo.textContent = `v${version}`
        const versionTag = `v${version}`
        this.#docsRef = versionTag
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

    this.#md = createMarkdownRenderer()

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
   * @param {string} url - A manual link (see app/src/modules/manual-links.js)
   * @returns {Promise<boolean>} Whether `url` is a manual link
   */
  async openUrl(url) {
    const target = parseManualUrl(url)
    if (!target) return false
    await this.open(target.anchor ? `${target.path}#${target.anchor}` : target.path)
    return true
  }

  /**
   * The manual link of a section of the current page.
   * @param {string} [anchor] - Heading anchor without "#"
   * @returns {string}
   */
  linkTo(anchor) {
    return manualUrl(this.#currentPage, anchor, this.#docsRef)
  }

  /**
   * Loads markdown and converts it to HTML, replacing links to local content
   * @param {string} mdPath The local path to the md file, relative to the "docs" dir
   * @param {boolean} addToHistory Whether to add this page to navigation history (default: true)
   */
  async load(mdPath, addToHistory = true) {
    const hashIndex = mdPath.indexOf('#')
    const anchor = hashIndex === -1 ? '' : mdPath.slice(hashIndex + 1)
    if (hashIndex !== -1) mdPath = mdPath.slice(0, hashIndex)
    if (!mdPath) {
      // a link to a section of the current page
      this.#scrollToAnchor(anchor)
      return
    }
    let resolvedPath = mdPath
    if (addToHistory && !mdPath.startsWith('/') && !mdPath.startsWith('http') && this.#currentPage && this.#currentPage !== mdPath) {
      const currentDir = this.#currentPage.substring(0, this.#currentPage.lastIndexOf('/'))
      if (currentDir) {
        const parts = currentDir.split('/').filter(p => p)
        const pathParts = mdPath.split('/')
        for (const part of pathParts) {
          if (part === '..') {
            parts.pop()
          } else if (part !== '.') {
            parts.push(part)
          }
        }
        resolvedPath = parts.join('/')
      }
    }
    resolvedPath = resolvedPath.replace(/^\/+/, '')
    const historyEntry = anchor ? `${resolvedPath}#${anchor}` : resolvedPath

    if (addToHistory && (this.#navigationHistory.length === 0 || this.#navigationHistory[this.#navigationHistory.length - 1] !== historyEntry)) {
      this.#navigationHistory.push(historyEntry)
      this.#forwardHistory = []
      this.#updateNavigationButtons()
    }

    this.#currentPage = resolvedPath
    mdPath = resolvedPath

    this.#ui.content.innerHTML = ""
    this.#updateToc([])

    let markdown
    let isOnline = false
    const fetchOptions = this.#enableCache ? {} : { cache: 'no-cache' }
    const useGitHubDocs = await this.getDependency('config').get("docs.from-github", false)

    if (!useGitHubDocs) {
      try {
        this.getDependency('logger').debug(`Loading documentation from local: ${mdPath}`)
        markdown = await (await fetch(`${this.#localDocsBasePath}/${mdPath}`, fetchOptions)).text()
      } catch(error) {
        this.getDependency('dialog').error(`Failed to load local documentation: ${error.message}`)
        return
      }
    } else {
      try {
        isOnline = await this.#checkOnlineConnectivity()
        if (isOnline) {
          this.getDependency('logger').debug(`Loading documentation from GitHub: ${mdPath}`)
          markdown = await (await fetch(`${this.#remoteDocsBasePath}/${mdPath}`, fetchOptions)).text()
        } else {
          throw new Error("No online connectivity")
        }
      } catch(error) {
        try {
          this.getDependency('logger').debug(`Falling back to local documentation: ${mdPath}`)
          markdown = await (await fetch(`${this.#localDocsBasePath}/${mdPath}`, fetchOptions)).text()
        } catch(localError) {
          this.getDependency('dialog').error(`Failed to load documentation: ${localError.message}`)
          return
        }
      }
    }

    const html = /** @type {MarkdownIt} */(this.#md).render(markdown)
      .replaceAll(
        /(<a\s+.*?)href=(["'])((?!https?:\/\/|\/\/|#).*?)\2(.*?>)/g,
        `$1href="#" onclick="appInfo.load('$3'); return false"$4`
      )
      .replaceAll(/src="(\.\/)?images\//g, isOnline ?
        `src="${this.#remoteDocsBasePath}/images/` :
        'src="docs/images/')
      .replaceAll(/(href="http)/g, `target="_blank" $1`)
      .replaceAll(/<!--|-->/gs, '')

    this.#ui.content.innerHTML = html
    this.#updateToc(extractHeadings(/** @type {MarkdownIt} */(this.#md), markdown))
    addHeadingLinkButtons(this.#ui.content, anchor => this.#copyLink(anchor))
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
    const target = this.#ui.content.querySelector(`[id="${CSS.escape(anchor)}"]`)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      this.getDependency('logger').warn(`Anchor #${anchor} not found in ${this.#currentPage}`)
    }
  }

  /**
   * Copies the manual link of a heading of the current page to the clipboard
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
   * Keeps links to sections of the current page ("#anchor") inside the drawer
   * instead of changing the location of the app.
   * @param {MouseEvent} event
   */
  #handleContentClick(event) {
    const link = /** @type {HTMLElement} */ (event.target).closest?.('a[href^="#"]')
    if (!link) return
    const anchor = decodeURIComponent((link.getAttribute('href') || '').slice(1))
    if (!anchor) return
    event.preventDefault()
    this.#scrollToAnchor(anchor)
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
    if (!link || !parseManualUrl(link.href)) return
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
    this.#currentPage = ''
    this.load('index.md')
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

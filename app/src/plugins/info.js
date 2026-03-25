/**
 * This implements a modal window with the end-user documentation taken from the "docs" folder
 * in the app root. The documentation is written in markdown and converted to HTML using
 * the markdown-it library. Links to local documentation are intercepted and loaded into the dialog.
 * Links to external resources are opened in a new browser tab.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import MarkdownIt from 'markdown-it'
 * @import { SlDrawer } from '../ui.js'
 * @import { infoDrawerPart } from '../templates/info-drawer.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { createMarkdownRenderer } from '../modules/markdown-utils.js'

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

  #githubEditBasePath = "https://github.com/mpilhlt/pdf-tei-editor/edit/main/docs"

  #enableCache = true

  /** @type {string[]} */
  #navigationHistory = []

  /** @type {string[]} */
  #forwardHistory = []

  #currentPage = 'index.md'

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
        this.#remoteDocsBasePath = `https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/refs/tags/${versionTag}/docs`
        this.#githubEditBasePath = `https://github.com/mpilhlt/pdf-tei-editor/edit/${versionTag}/docs`
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
   * Opens the info dialog
   */
  async open() {
    this.#updateNavigationButtons()
    this.#ui.show()
    if (this.#navigationHistory.length === 0) {
      await this.load('index.md')
    }
  }

  /**
   * Loads markdown and converts it to HTML, replacing links to local content
   * @param {string} mdPath The local path to the md file, relative to the "docs" dir
   * @param {boolean} addToHistory Whether to add this page to navigation history (default: true)
   */
  async load(mdPath, addToHistory = true) {
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

    if (addToHistory && (this.#navigationHistory.length === 0 || this.#navigationHistory[this.#navigationHistory.length - 1] !== resolvedPath)) {
      this.#navigationHistory.push(resolvedPath)
      this.#forwardHistory = []
      this.#updateNavigationButtons()
    }

    this.#currentPage = resolvedPath
    mdPath = resolvedPath

    this.#ui.content.innerHTML = ""

    let markdown
    let isOnline = false
    const fetchOptions = this.#enableCache ? {} : { cache: 'no-cache' }
    const useGitHubDocs = await this.getDependency('config').get("docs.from-github")

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
      this.load(previousPage, false)
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
        this.load(nextPage, true)
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
    this.#ui.addEventListener("sl-hide", () => {
      auth.showLoginDialog()
    }, { once: true })
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

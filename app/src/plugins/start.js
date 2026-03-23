/**
 * Plugin which hosts the start function, which is responsible for loading the documents at startup
 * and configures the general behavior of the application. General rule: behavior that depends solely
 * on a particular plugin should be configured in the plugin, behavior that depends on the interplay
 * of several plugins should be configured here.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import ui, { Spinner, updateUi } from '../ui.js'
import { testLog } from '../modules/test-log.js'
import { HeartbeatPlugin } from '../plugin-registry.js'
import { UrlHash } from '../modules/browser-utils.js'
import { notify } from '../modules/sl-utils.js'

class StartPlugin extends Plugin {
  /** @type {import('./logger.js').default} */
  #logger
  /** @type {ReturnType<import('./config.js').default['getApi']>} */
  #config
  /** @type {import('./dialog.js').default} */
  #dialog
  /** @type {import('./services.js').default} */
  #services
  /** @type {import('./tei-validation.js').default} */
  #validation
  /** @type {import('./xmleditor.js').default} */
  #xmlEditor
  /** @type {import('./authentication.js').default} */
  #authentication

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'start',
      deps: ['logger', 'config', 'dialog', 'services', 'tei-validation', 'xmleditor', 'authentication', 'heartbeat']
    })
  }

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state)
    this.#logger = this.getDependency('logger')
    this.#config = this.getDependency('config')
    this.#dialog = this.getDependency('dialog')
    this.#services = this.getDependency('services')
    this.#validation = this.getDependency('tei-validation')
    this.#xmlEditor = this.getDependency('xmleditor')
    this.#authentication = this.getDependency('authentication')

    // spinner/blocker
    const spinner = new Spinner
    // @ts-ignore
    spinner.setAttribute('name', "spinner")
    document.body.appendChild(spinner)
    updateUi()

    // Note: validation status widget creation moved to xmleditor plugin's start() function
  }

  /**
  * Starts the application, configures plugins and the UI
  */
  async start() {

    // async operations
    try {

      testLog('APP_START_INITIATED', { timestamp: new Date().toISOString() })

      // Authenticate user, otherwise we don't proceed further
      const userData = await this.#authentication.ensureAuthenticated()
      const name = userData.fullname || userData.username
      this.#logger.info(`${name} has logged in.`)
      notify(`Welcome back, ${name}!`)

      testLog('USER_AUTHENTICATED', {
        username: userData.username,
        fullname: userData.fullname
      })

      // load config data
      await this.#config.load()

      ui.spinner.show('Loading documents, please wait...')

      // update the file data (use cache on startup, only refresh on explicit user action)
      await this.context.invokePluginEndpoint(ep.filedata.reload, { refresh: false })

      // disable regular validation so that we have more control over it
      this.#validation.configure({ mode: "off" })

      // get document paths from URL hash
      // @ts-ignore
      const pdf = this.state.pdf || null
      const xml = this.state.xml || null
      const diff = this.state.diff

      if (pdf !== null || xml !== null) {
        // load the documents (PDF-XML pairs or XML-only files)
        try {
          const filesToLoad = {}
          if (pdf) filesToLoad.pdf = pdf
          if (xml) filesToLoad.xml = xml
          await this.#services.load(filesToLoad)
        } catch (error) {
          this.#dialog.error(String(error))
          this.#logger.critical(String(error))
        }
      }

      // two alternative initial states:
      // a) if the diff param was given and is different from the xml param, show a diff/merge view
      // b) if no diff, try to validate the document and select first match of xpath expression
      if (diff && diff !== xml) {
        // a) load the diff view
        try {
          await this.#services.showMergeView(diff)
        } catch (error) {
          this.#logger.warn("Error loading diff view: " + String(error))
        }
      } else {
        // b) validation & xpath selection

        // measure how long it takes to validate the document
        const startTime = new Date().getTime()
        this.#services.validateXml().then(() => {
          const endTime = new Date().getTime()
          const seconds = Math.round((endTime - startTime) / 1000)
          // disable validation if it took longer than 3 seconds on slow servers
          this.#logger.info(`Validation took ${seconds} seconds${seconds > 3 ? ", disabling it." : "."}`)
          this.#validation.configure({ mode: seconds > 3 ? "off" : "auto" })
        })

        // the xpath of the (to be) selected node in the xml editor, setting the state triggers the selection
        const xpath = UrlHash.get("xpath") || ''

        // update the UI
        await this.dispatchStateChange({ xpath })

        // synchronize in the background
        this.context.invokePluginEndpoint(ep.sync.syncFiles, this.state).then(async (summary) => {
          if (summary && !summary.skipped) {
            await this.context.invokePluginEndpoint(ep.filedata.reload, { refresh: true })
          }
        })
      }

      // configure the xml editor events
      this.#configureFindNodeInPdf()

      // Heartbeat mechanism for file locking and offline detection
      HeartbeatPlugin.getInstance().start(await this.#config.get('heartbeat.interval', 10))

      // finish initialization
      ui.spinner.hide()
      this.#xmlEditor.setLineWrapping(true)
      this.#logger.info("Application ready.")

      testLog('APP_START_COMPLETED', {
        pdf: this.state.pdf,
        xml: this.state.xml,
        diff: this.state.diff
      })

      // Notify all plugins that app startup is complete
      await this.context.invokePluginEndpoint(ep.ready)

    } catch (error) {
      ui.spinner.hide()
      this.#dialog.error(String(error))
      throw error
    }
  }

  /**
   * Add behavior that looks up the content of the current node in the PDF
   */
  #configureFindNodeInPdf() {
    /** @type {Node | null} */
    let lastNode = null

    // Cross-plugin coordination: Find the currently selected node's contents in the PDF
    this.#xmlEditor.on("selectionChanged", async () => {
      // workaround for the node selection not being updated immediately
      await new Promise(resolve => setTimeout(resolve, 100)) // wait for the next tick
      // trigger auto-search if enabled and if a new node has been selected
      const autoSearchSwitch = /** @type {any} */ (ui.pdfViewer.statusbar.searchSwitch)
      const node = this.#xmlEditor.selectedNode

      if (autoSearchSwitch && autoSearchSwitch.checked && node && node !== lastNode) {
        await this.#services.searchNodeContentsInPdf(node)
        lastNode = node
      }
    })
  }
}

export default StartPlugin

/** @deprecated Use StartPlugin class directly */
export const plugin = StartPlugin

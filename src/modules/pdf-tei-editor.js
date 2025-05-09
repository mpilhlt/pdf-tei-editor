import { UrlHash } from '../modules/browser-utils.js'

// custom elements
import { Spinner } from '../modules/spinner.js'

// Base class
import { App } from '../modules/app-template.js'

// plugins 
import { plugin as loggerPlugin, api as loggerApi, logLevel } from '../plugins/logger.js'
import { plugin as dialogPlugin, api as dialogApi } from '../plugins/dialog.js'
import { plugin as pdfViewerPlugin, api as pdfViewerApi } from '../plugins/pdfviewer.js'
import { plugin as xmlEditorPlugin, api as xmlEditorApi } from '../plugins/xmleditor.js'
import { plugin as clientPlugin, api as clientApi } from '../plugins/client.js'
import { plugin as commandBarPlugin, api as commandBarApi } from '../plugins/command-bar.js'
import { plugin as fileselectionPlugin, api as fileselectionApi } from '../plugins/file-selection.js'
import { plugin as extractionPlugin, api as extractionApi } from '../plugins/extraction.js'
import { plugin as servicesPlugin, api as servicesApi } from '../plugins/services.js'
import { plugin as floatingPanelPlugin, api as floatingPanelApi } from '../plugins/floating-panel.js'
import { plugin as promptEditorPlugin, api as promptEditorApi } from '../plugins/prompt-editor.js'
import { plugin as teiWizardPlugin } from '../plugins/tei-wizard.js'

//import { plugin as dummyLoggerPlugin } from '../components/logger-dummy.js'

/**
 * Main application class
 * 
 * @todo: The current architecture is too tightly coupled. Instead of relying on application
 * properties and events where we do not know when all the side effects have completed,
 * instead we could only rely on emitting events via "plugin.invoke()" and awaiting the returned promises.
 * This would allow for a much cleaner and more predictable behavior.
 * So instead of `app.xmlPath="foo"` emitting "change:xmlPath", `app.plugin.invoke("change.xmlPath")` could let
 * the plugins react and as they can return a promise, the main thread can then know when all the plugins
 * have reacted. Then the plugin could have an "event" property exposing all the events it emits. The main
 * application should then be rewritten as a plugin.
 *  
 */
class PdfTeiEditor extends App {

  /**
   * Extension points to be invoked with the registered plugins
   */
  ext = {
    /** invoked with {value:any, old:any} */
    state: {
      pdfPath: "state.pdfPath",
      xmlPath: "state.xmlPath",
      diffXmlPath: "state.diffXmlPath",
      xpath: "state.xpath"
    },
    /** invoked with {message:str}, execpt setLogLevel, which emits {level:number} */
    log: {
      setLogLevel: "log.setLogLevel",
      debug: "log.debug",
      info: "log.info",
      warn: "log.warn",
      fatal: "log.fatal"
    },
    ui: {
      /** 
       * Invoked with an empty object. Plugins populate the object by adding each UI element
       * defined by with a key "plugin-name.element-name", "element-name" being the value of
       * the "name" attribute
       */
      elements: "ui.elements"
    },
    tei: {
      enhancement: "tei.enhancement"
    }
  }

  /**
   * The logger for the application
   * @type {loggerApi}
   */
  logger = loggerApi

  /**
   * The log level
   */
  logLevel = logLevel.DEBUG

  /**
   * A dialog widget for user interaction
   * @type {dialogApi}
   */
  dialog;

  /**
   * The commandbar at the top of the application
   * @type {commandBarApi}
   */
  commandbar;

  /**
   * The PDFViewer component
   * @type {pdfViewerApi}
   */
  pdfviewer;

  /**
   * The XML editor component
   * @type {xmlEditorApi}
   */
  xmleditor;

  /**
   * The http client for the app's API server
   * @type {clientApi}
   */
  client;

  /**
   * UI and services for displaying and loading PDF and XML files on the server
   * @type {fileselectionApi}
   */
  fileselection;

  /**
   * The core services (commands) of the app
   * @type {servicesApi}
   */
  services;

  /**
   * Provides the extraction services
   * @type {extractionApi}
   */
  extraction;

  /**
   * The floating panel containing navigation controls
   * @type {floatingPanelApi}
   */
  floatingPanel;

  /**
   * A pop-up dialog which lets the user enter and edit additional instructions
   * sent to the LLM 
   * @type {promptEditorApi}
   */
  promptEditor;

  /**
   * The spinner which is shown with a message and blocking the UI while 
   * awaiting the result of a long-lasting server-side process
   * @type {Spinner}
   */
  spinner;

  /**
   * The path to the current PDF document (app state)
   * @type {string}
   * @emits "change:pdfPath"
   */
  pdfPath;

  /**
   * The path to the current XML document (app state)
   * @type {string}
   * @emits "change:xmlPath"
   */
  xmlPath;

  /**
   * The path to the current XML document used for diffing (app state)
   * @type {string}
   * @emits "change:diffXmlPath"
   */
  diffXmlPath;

  /**
   * The xpath expression used to navigate in the xmleditor. It is updated
   * when the selection changes and will update the selection when changed
   * @type {string}
   * @emits "change:xpath"
   */
  xpath;

  /**
   * Constructor (in case you couldn't tell)
   * @param {Array?} Array of additional plugins to register
   */
  constructor(plugins = []) {
    super();

    // register plugins
    console.info(`Installing plugins...`);
    plugins = this.getPlugins().concat(plugins)
    plugins.forEach(plugin => this.plugin.register(plugin))

    // spinner/blocker
    this.spinner = document.createElement('custom-spinner')
    document.body.appendChild(this.spinner)

    // application states, to be replaced with plugin event invokation
    this.registerState('pdfPath', null, 'pdfPath', 'pdf')
    this.registerState('xmlPath', null, 'xmlPath', 'xml')
    this.registerState('diffXmlPath', null, 'diffXmlPath', 'diff')
    this.registerState('xpath', null, 'xpath', 'xpath')
  }

  /**
   * Returns an array of plugin objects. Override to modify.
   * @returns {Array<Object>}
   */
  getPlugins() {
    return [
      loggerPlugin, dialogPlugin, clientPlugin, pdfViewerPlugin, xmlEditorPlugin,
      commandBarPlugin, fileselectionPlugin, servicesPlugin,
      floatingPanelPlugin, promptEditorPlugin, extractionPlugin, teiWizardPlugin //, dummyLoggerPlugin
    ]
  }

  /**
   * Retrieves all UI elements registered by the installed plugins.
   *
   * This function iterates through the plugins that provide UI elements,
   * and collects them into a structured object. The resulting object
   * has plugin names as keys, and a collection of each plugin's UI elements as values,
   * in the form of an object with element names as keys and the element DOM objects as values.
   *
   * @returns {Object<string, Object<string, any>>} An object containing all UI elements,
   *   organized by plugin name and element name. 
   */
  getUiElements() {
    const elements = {}
    for (const plugin of this.plugin.getPlugins(this.ext.ui.elements)) {
      elements[plugin.name] = {}
      Object.entries(plugin.ui.elements).forEach(([name, element]) => {
        elements[plugin.name][name] = element
      })
    }
    return elements
  }

  /**
   * Retrieves a specific UI element by its slug.
   *
   * The slug is a string in the format "pluginName.elementName", which uniquely
   * identifies a UI element registered by a plugin.
   *
   * @param {string} slug The slug of the UI element to retrieve.  Must be in the format "pluginName.elementName".
   * @returns {Element | null} The UI element definition if found, otherwise null.
   *   Returns null if the plugin or element is not found, or if the slug is invalid.
   */
  getUiElementByName(slug) {
    const elements = this.getUiElements()
    const [pluginName, elementName] = slug.split(".")
    try {
      return elements[pluginName][elementName]
    } catch (e) {
      return null
    }
  }

  /**
   * Starts the application, configures plugins and the UI
   */
  async start() {

    // set log level
    this.logger.setLogLevel(this.logLevel) // uncomment this to see more debug messages

    this.logger.info(`Starting Application...`);

    this.spinner.show('Loading documents, please wait...')

    // async operations
    try {

      // install components in parallel and wait for all returned promises to resolve
      const promises = this.plugin.invoke('install', this)
      await Promise.all(promises)

      this.logger.info("Configuring application state from URL")
      this.updateStateFromUrlHash()

      // disable regular validation so that we have more control over it
      this.xmleditor.disableValidation(true)

      // get document paths from URL hash or from the first entry of the selectboxes
      const defaultFile = this.commandbar.getByName('pdf').firstChild.dataset
      const pdf = this.pdfPath || defaultFile.pdf
      const xml = this.xmlPath || defaultFile.xml
      const diff = this.diffXmlPath

      // lod the documents
      await this.services.load({ pdf, xml, diff })

      // two alternative initial states:
      // a) if the diff param was given and is different from the xml param, show a diff/merge view 
      // b) if no diff, try to validate the document and select first match of xpath expression
      if (diff && diff !== xml) {
        // a) load the diff view
        try {
          await this.services.showMergeView(diff)
        } catch (error) {
          console.error("Error loading diff view:", error)
        }
      } else {
        // b) validation & xpath selection

        // measure how long it takes to validate the document
        const startTime = new Date().getTime();
        this.services.validateXml().then(() => {
          const endTime = new Date().getTime();
          const seconds = Math.round((endTime - startTime) / 1000);
          // disable validation if it took longer than 3 seconds on slow servers
          this.logger.info(`Validation took ${seconds} seconds${seconds > 3 ? ", disabling it." : "."}`)
          this.xmleditor.disableValidation(seconds > 3)
        })

        // the xpath of the (to be) selected node in the xml editor, setting the state triggers the selection
        const xpath = UrlHash.get("xpath")
        if (xpath) {
          this.xpath = xpath
        } else {
          this.xpath = this.floatingPanel.getByName('xpath').value
        }
      }

      // finish initialization
      this.spinner.hide()
      this.floatingPanel.show()
      this.logger.info("Application ready.")

    } catch (error) {
      this.spinner.hide();
      if (this.dialog) {
        this.dialog.error(error.message)
      }
      throw error
    }
  }
}

export { PdfTeiEditor, App }
export default PdfTeiEditor

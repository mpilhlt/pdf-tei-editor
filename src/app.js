import { UrlHash } from './modules/browser-utils.js'

// custom elements
import {Spinner} from './modules/spinner.js'
import './modules/switch.js'

// New application architecture
import { App } from './modules/app.js'

// plugins (the components are only needed for IDE autocompletion)
import { loggerPlugin, loggerComponent } from './components/logger.js'
import { dialogPlugin, dialogComponent } from './components/dialog.js'
import { pdfViewerPlugin, pdfViewerComponent  } from './components/pdfviewer.js'
import { xmlEditorPlugin, xmlEditorComponent } from './components/xmleditor.js'
import { clientPlugin, clientComponent } from './components/client.js'
import { commandBarPlugin, commandBarComponent } from './components/command-bar.js'
import { fileselectionPlugin, fileselectionComponent } from './components/file-selection.js'
import { extractionPlugin, extractionComponent } from './components/extraction.js'
import { servicesPlugin, servicesComponent } from './components/services.js'
import { floatingPanelPlugin, floatingPanelComponent  } from './components/floating-panel.js'
import { promptEditorPlugin, promptEditorComponent } from './components/prompt-editor.js'

/**
 * Main application class
 */
export class PdfTeiEditor extends App {

  /**
   * The logger for the application
   * @type {loggerComponent}
   */
  logger;

  /**
   * A dialog widget for user interaction
   * @type {dialogComponent}
   */
  dialog;

  /**
   * The commandbar at the top of the application
   * @type {commandBarComponent}
   */
  commandbar;

  /**
   * The PDFViewer component
   * @type {pdfViewerComponent}
   */
  pdfviewer;

  /**
   * The XML editor component
   * @type {xmlEditorComponent}
   */
  xmleditor;

  /**
   * The http client for the app's API server
   * @type {clientComponent}
   */
  client;

  /**
   * UI and services for displaying and loading PDF and XML files on the server
   * @type {fileselectionComponent}
   */
  fileselection;

  /**
   * The core services (commands) of the app
   * @type {servicesComponent}
   */
  services;  
  
  /**
   * Provides the extraction services
   * @type {extractionComponent}
   */
  extraction;

  /**
   * The floating panel containing navigation controls
   * @type {floatingPanelComponent}
   */
  floatingPanel;

  /**
   * A pop-up dialog which lets the user enter and edit additional instructions
   * sent to the LLM 
   * @type {promptEditorComponent}
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
   */
  constructor() {
    super();

    // plugins
    loggerComponent.info(`Installing plugins...`);
    loggerComponent.setDebugLevel(1) // uncomment this to see more debug messages
    const plugins = [
      loggerPlugin, dialogPlugin, clientPlugin, pdfViewerPlugin, xmlEditorPlugin, 
      commandBarPlugin, fileselectionPlugin, servicesPlugin, 
      floatingPanelPlugin, promptEditorPlugin, extractionPlugin,
    ]
    plugins.forEach(plugin => this.plugin.register(plugin))

    // spinner/blocker
    this.spinner = document.createElement('custom-spinner')
    document.body.appendChild(this.spinner)

    // application states
    this.registerState('pdfPath', null, 'pdfPath', 'pdf')
    this.registerState('xmlPath', null, 'xmlPath', 'xml')
    this.registerState('diffXmlPath', null, 'diffXmlPath', 'diff')
    this.registerState('xpath', null, 'xpath', 'xpath')
  }

  /**
   * Starts the application, configures plugins and the UI
   */
  async start() {
    
    loggerComponent.info(`Starting Application...`);

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
      const pdf = this.pdfPath || this.commandbar.selectedOption("pdf").value
      const xml = this.xmlPath || this.commandbar.selectedOption("xml").value
      const diff = this.diffXmlPath || this.commandbar.getByName("diff").value
    
      // lod the documents
      await this.services.load({pdf, xml, diff})

      // two alternative initial states:
      // a) if the diff param was given and is different from the xml param, show a diff/merge view 
      // b) if no diff, try to validate the document and select first match of xpath expression
      if (diff !== xml) {
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
      this.dialog.error(error.message)
      throw error
    }
  }
}

/**
 * The application instance
 * @type {PdfTeiEditor}
 */
let app;

// instantiate and run app 
(async () => {
  try {
    // store app in global variable for debugging
    app = window.app = new PdfTeiEditor()
    await app.start()
  } catch (error) {
    console.error(error)
  }
})()

export {app, App}
export default app

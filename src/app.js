import { UrlHash } from './modules/browser-utils.js'

// custom elements
import {Spinner} from './modules/spinner.js'
import './modules/switch.js'
import './modules/list-editor.js'

// New application architecture
import { App } from './modules/app.js'

// plugins (the components are only needed for IDE autocompletion)
import { dialogPlugin, dialogComponent } from './components/dialog.js'
import { commandBarPlugin, commandBarComponent } from './components/command-bar.js'
import { pdfViewerPlugin, pdfViewerComponent  } from './components/pdfviewer.js'
import { xmlEditorPlugin, xmlEditorComponent, XMLEditor } from './components/xmleditor.js'
import { clientPlugin, clientComponent } from './components/client.js'
import { floatingPanelPlugin, floatingPanelComponent  } from './components/floating-panel.js'
import { servicesPlugin, servicesComponent } from './components/services.js'
import { promptEditorPlugin, promptEditorComponent } from './components/prompt-editor.js'
import { PDFJSViewer } from './modules/pdfviewer.js'

/**
 * Main application class
 */
export class PdfTeiEditor extends App {
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
   * The floating panel containing navigation controls
   * @type {floatingPanelComponent}
   */
  floatingPanel;

  /**
   * The core services (commands) of the app
   * @type {servicesComponent}
   */
  services;

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
   * The xpath expression used to navigate in the xmleditor
   * @type {string}
   * @emits "change:xpath"
   */  
  xpath;  

  /**
   * Constructor (in case you couldn't tell)
   */
  constructor() {
    super();

    // regitster plugins
    const plugins = [
      dialogPlugin, commandBarPlugin, pdfViewerPlugin, xmlEditorPlugin, clientPlugin, 
      floatingPanelPlugin, servicesPlugin, promptEditorPlugin
    ]
    plugins.forEach(plugin => this.plugin.register(plugin))

    // spinner/blocker
    this.spinner = document.querySelector('#spinner')

    // application states
    this.registerState('pdfPath', null, 'pdfPath', 'pdf')
    this.registerState('xmlPath', null, 'xmlPath', 'xml')
    this.registerState('diffXmlPath', null, 'diffXmlPath', 'xml')
  }

  /**
   * Starts the application, configures plugins and the UI
   */
  async start() {
    // this takes care of plugin initialization 
    super.start()

    // disable regular validation so that we have more control over it
    this.xmleditor.disableValidation(true)

    this.spinner.show('Loading documents, please wait...')
    console.log(`Starting Application\nPDF: ${pdfPath}\nXML: ${xmlPath}`);

    // load files
    try {

      // Fetch file data from api
      await this.commandbar.update()

      if (!fileData || fileData.length === 0) {
        throw new Error("No files found")
      }

      // get document paths from URL hash or from the first entry of the selectboxes
      let pdf = UrlHash.get('pdf') || this.commandbar.getByName("pdf").value
      let xml = UrlHash.get('xml') || this.commandbar.getByName("xml").value

      // lod the documents, this also sets the application state
      await this.services.load({pdf, xml})

    } catch (error) {
      this.spinner.hide();
      this.dialog.error(error.message)
      throw error
    }

    console.log("All Editors/Viewers loaded.")

    // load diff
    let diffXmlPath = UrlHash.get('diff') || this.commandbar.getByName("diff").value
    if (diffXmlPath !== xmlPath) {
      // load the diff view, this also sets the application state
      // no validation since this would overload the UI
      try {
        await this.services.showMergeView(diffXmlPath)
      } catch (error) {
        console.error("Error loading diff view:", error)
      }
    } else {
      // measure how long it takes to validate the document
      const startTime = new Date().getTime();
      this.services.validateXml().then(() => {
        const endTime = new Date().getTime();
        const seconds = Math.round((endTime - startTime) / 1000);
        // disable validation if it took longer than 3 seconds
        console.log(`Validation took ${seconds} seconds${seconds > 3 ? ", disabling it." : "."}`)
        this.xmleditor.disableValidation(seconds > 3)
      })
    }

    // finish initialization
    this.spinner.hide()
    this.floatingPanel.show()
    console.log("Application ready.")
  }
}

/**
 * The application instance
 * @type {PdfTeiEditor}
 */
export let app;

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


/**
 * Called when the URL hash changes
 * @param {Event} evt The hashchange event
 * @returns {void}
 */
function onHashChange(evt) {
  const xpath = UrlHash.get("xpath");
  if (xpath && xpath !== getSelectionXpath()) {
    setSelectionXpath(xpath)
  } else {
    setSelectionXpath(getSelectionXpath())
  }
}
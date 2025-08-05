/**
 * Plugin which hosts the start function, which is responsible for loading the documents at startup
 * and configures the general behavior of the application. General rule: behavior that depends solely 
 * on a particular plugin should be configured in the plugin, behavior that depends on the interplay
 * of several plugins should be configured here.
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { Diagnostic } from '@codemirror/lint'
 */
import ui from '../ui.js'
import {
  updateState, logger, services, dialog, validation, floatingPanel, xmlEditor, fileselection, client,
  config, statusbar, authentication, state
} from '../app.js'
import { Spinner, updateUi } from '../ui.js'
import { UrlHash } from '../modules/browser-utils.js'
import { XMLEditor } from './xmleditor.js'
import { setDiagnostics } from '@codemirror/lint'
import { notify } from '../modules/sl-utils.js'


/**
 * Plugin object
 * dependencies are automatically set to all other plugins, so that it is the last one to be installed
 */
const plugin = {
  name: "start",
  install,
  start
}

export { plugin }
export default plugin


//
// Implementation
//

let spinner

/**
 * Invoked for plugin installation
 * @param {ApplicationState} state 
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  // spinner/blocker
  spinner = new Spinner
  // @ts-ignore
  spinner.setAttribute('name', "spinner")
  document.body.appendChild(spinner)
  updateUi()
}

/**
* Starts the application, configures plugins and the UI
* @param {ApplicationState} state
*/
async function start(state) {

  // async operations
  try {

    // Authenticate user, otherwise we don't proceed further
    const userData = await authentication.ensureAuthenticated()
    logger.info(`${userData.fullname} has logged in.`)
    notify(`Welcome back, ${userData.fullname}!`)
    
    // load config data
    await config.load()

    ui.spinner.show('Loading documents, please wait...')

    // update the file lists
    await fileselection.reload(state)

    // disable regular validation so that we have more control over it
    validation.configure({ mode: "off" })

    // get document paths from URL hash 
    // @ts-ignore
    const pdf = state.pdfPath || null
    const xml = state.xmlPath || null
    const diff = state.diffXmlPath

    if (pdf !== null) {
      // lod the documents
      await services.load(state, { pdf, xml, diff })
    } else {
      dialog.info("Load a PDF from the dropdown on the top left.")
    }
    
    // two alternative initial states:
    // a) if the diff param was given and is different from the xml param, show a diff/merge view 
    // b) if no diff, try to validate the document and select first match of xpath expression
    if (diff && diff !== xml) {
      // a) load the diff view
      try {
        await services.showMergeView(state, diff)
      } catch (error) {
        logger.warn("Error loading diff view: " + error.message)
      }
    } else {
      // b) validation & xpath selection

      // measure how long it takes to validate the document
      const startTime = new Date().getTime();
      services.validateXml().then(() => {
        const endTime = new Date().getTime();
        const seconds = Math.round((endTime - startTime) / 1000);
        // disable validation if it took longer than 3 seconds on slow servers
        logger.info(`Validation took ${seconds} seconds${seconds > 3 ? ", disabling it." : "."}`)
        validation.configure({ mode: seconds > 3 ? "off" : "auto" })
      })

      // the xpath of the (to be) selected node in the xml editor, setting the state triggers the selection
      const xpath = UrlHash.get("xpath")
      if (xpath) {
        state.xpath = xpath
      } else {
        state.xpath = ui.floatingPanel.xpath.value
      }
      // update the UI
      updateState(state)
    }

    // configure the xml editor events
    configureXmlEditor()

    // Heartbeat mechanism for file locking and offline detection
    configureHeartbeat(state, await config.get('heartbeat.interval', 10));

    // finish initialization
    ui.spinner.hide()
    floatingPanel.show()
    xmlEditor.setLineWrapping(true)
    logger.info("Application ready.")

  } catch (error) {
    ui.spinner.hide();
    dialog.error(error.message)
    throw error
  }
}


/**
 * Save the current XML file if the editor is "dirty"
 */
async function saveIfDirty() {
  const filePath = String(ui.toolbar.xml.value)

  if (filePath && xmlEditor.getXmlTree() && xmlEditor.isDirty()) {
    const result = await services.saveXml(filePath)
    if (result.status == "unchanged") {
      logger.debug(`File has not changed`)
    } else if (result.status == "saved_with_migration") {
      logger.debug(`Saved file to ${result.path} with migration of old version files`)
      // Migration occurred, reload file data to show updated version structure
      await fileselection.reload(state)
    } else {
      logger.debug(`Saved file to ${result.path}`)
    }
  }
}

function configureXmlEditor() {
  // Find the currently selected node's contents in the PDF
  xmlEditor.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, searchNodeContents)

  // manually show diagnostics if validation is disabled
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_XML_NOT_WELL_FORMED, /** @type CustomEvent */ evt => {
    if (validation.isDisabled()) {
      let view = xmlEditor.getView()
      // @ts-ignore
      let diagnostic = evt.detail
      try {
        view.dispatch(setDiagnostics(view.state, [diagnostic]))
      } catch (error) {
        logger.warn("Error setting diagnostics: " + error.message)
      }
    }
  })

  // save dirty editor content after an update
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_DELAYED_UPDATE, () => saveIfDirty())

  // xml vaidation events
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_XML_NOT_WELL_FORMED, evt => {
    const diagnostics =/** @type {CustomEvent<Diagnostic[]>} */ (evt).detail;
    console.warn("XML is not well-formed", diagnostics)
    xmlEditor.getView().dispatch(setDiagnostics(xmlEditor.getView().state, diagnostics))
    statusbar.addMessage("Invalid XML", "xml", "xml-status")
    // @ts-ignore
    ui.xmlEditor.querySelector(".cm-content").classList.add("invalid-xml")
  })
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_XML_WELL_FORMED, evt => {
    // @ts-ignore
    ui.xmlEditor.querySelector(".cm-content").classList.remove("invalid-xml")
    xmlEditor.getView().dispatch(setDiagnostics(xmlEditor.getView().state, []))
    statusbar.removeMessage("xml", "xml-status")
  })
}

/**
 * Configures the heartbeat mechanism for file locking and offline detection.
 * @param {ApplicationState} state 
 * @param {number} [lockTimeoutSeconds=60]
 */
function configureHeartbeat(state, lockTimeoutSeconds = 60) {
  if (!Number.isInteger(lockTimeoutSeconds)) {
    throw new Error(`Invalid timeout value: ${lockTimeoutSeconds}`)
  }
  logger.debug(`Configuring a heartbeat of ${lockTimeoutSeconds} seconds`)
  let heartbeatInterval = null;
  const heartbeatFrequency = lockTimeoutSeconds * 1000;

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      logger.debug("Heartbeat stopped.");
    }
    const filePath = ui.toolbar.xml.value;
    client.releaseLock(filePath);
  }

  const startHeartbeat = () => {

    let editorReadOnlyState;

    heartbeatInterval = setInterval(async () => {

      const filePath = String(ui.toolbar.xml.value);
      const reasonsToSkip = {
        "No user is logged in": state.user === null,
        "No file path specified": !filePath
      };

      for (const reason in reasonsToSkip) {
        if (reasonsToSkip[reason]) {
          logger.debug(`Skipping heartbeat: ${reason}.`);
          return;
        }
      }

      try {

        if (!state.editorReadOnly) {
          logger.debug(`Sending heartbeat to server to keep file lock alive for ${filePath}`);
          await client.sendHeartbeat(filePath);
        }

        // reload file list to see updates
        await fileselection.reload(state)

        // If we are here, the request was successful. Check if we were offline before.
        if (state.offline) {
          logger.info("Connection restored.");
          notify("Connection restored.");
          updateState(state, { offline: false, editorReadOnly: editorReadOnlyState });
        }
      } catch (error) {
        console.warn("Error during heartbeat:", error.name, error.message, error.statusCode);
        // Handle different types of errors
        if (error instanceof TypeError) {
          // This is likely a network error (client is offline)
          if (state.offline) {
            // we are still offline
            const message = `Still offline, will try again in ${lockTimeoutSeconds} seconds ...`
            logger.warn(message)
            notify(message)
            return
          }
          logger.warn("Connection lost.");
          notify(`Connection to the server was lost. Will retry in ${lockTimeoutSeconds} seconds.`, "warning");
          editorReadOnlyState = state.editorReadOnly
          updateState(state, { offline: true, editorReadOnly: true });
        } else if (error.statusCode === 409 || error.statusCode === 423) {
          // Lock was lost or taken by another user
          logger.critical("Lock lost for file: " + filePath);
          dialog.error("Your file lock has expired or was taken by another user. To prevent data loss, please save your work to a new file. Further saving to the original file is disabled.");
          updateState(state, { editorReadOnly: true });
        } else if (error.statusCode === 504) {
          logger.warn("Temporary connection failure, will try again...")
        } else if (error.statusCode === 403) {
          notify("You have been logged out") 
          authentication.logout()
        } else {
          // Another server-side error occurred
          if (state.webdavEnabled) {
            logger.error("An unexpected server error occurred during heartbeat. Disabling WebDAV features.", error);
            dialog.error("An unexpected server error occurred. File synchronization has been disabled for safety.");
            updateState(state, { webdavEnabled: false });
          }
        }
      }
    }, heartbeatFrequency);
    logger.info("Heartbeat started.");
  };
  startHeartbeat();
  window.addEventListener('beforeunload', stopHeartbeat);
}

let lastNode = null;
async function searchNodeContents() {
  // workaround for the node selection not being updated immediately
  await new Promise(resolve => setTimeout(resolve, 100)) // wait for the next tick
  // trigger auto-search if enabled and if a new node has been selected
  const autoSearchSwitch = ui.floatingPanel.switchAutoSearch
  const node = xmlEditor.selectedNode

  if (autoSearchSwitch.checked && node && node !== lastNode) {
    await services.searchNodeContentsInPdf(node)
    lastNode = node
  }
}
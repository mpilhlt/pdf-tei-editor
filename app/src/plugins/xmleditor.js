/**
 * The XML Editor plugin
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { Diagnostic } from '@codemirror/lint'
 */

import ui from '../ui.js'
import { updateState, validation, services, client } from '../app.js'
import { NavXmlEditor, XMLEditor } from '../modules/navigatable-xmleditor.js'
import { parseXPath } from '../modules/utils.js'
import { api as logger } from './logger.js'
import { setDiagnostics } from '@codemirror/lint'

// the path to the autocompletion data
const tagDataPath = '/config/tei.json'

/**
 * component is an instance of NavXmlEditor
 * @type {NavXmlEditor}
 */
const xmlEditor = new NavXmlEditor('codemirror-container')

/**
 * component plugin
 */
const plugin = {
  name: "xmleditor",
  install,
  state: {
    update,
    validation: {
      result: onValidationResult
    }
  }
}

export { xmlEditor as api, plugin, XMLEditor }
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  // load autocomplete data
  try {
    const res = await fetch(tagDataPath);
    const tagData = await res.json();
    xmlEditor.startAutocomplete(tagData)
    logger.info("Loaded autocompletion data...");
  } catch (error) {
    console.error('Error fetching from', tagDataPath, ":", error);
  }

  // selection => xpath state
  xmlEditor.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, evt => {
    xmlEditor.whenReady().then(() => onSelectionChange(state))
  });

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


  // xml validation events
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_XML_NOT_WELL_FORMED, evt => {
    /** @type Diagnostic[] */

    const diagnostics = evt.detail
    console.warn("XML is not well-formed", diagnostics)
    xmlEditor.getView().dispatch(setDiagnostics(xmlEditor.getView().state, diagnostics))

    ui.statusBar.statusMessageXml.textContent = "Invalid XML"
    // @ts-ignore
    ui.xmlEditor.querySelector(".cm-content").classList.add("invalid-xml")
  })
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_XML_WELL_FORMED, evt => {
    // @ts-ignore
    ui.xmlEditor.querySelector(".cm-content").classList.remove("invalid-xml")
    xmlEditor.getView().dispatch(setDiagnostics(xmlEditor.getView().state, []))
    ui.statusBar.statusMessageXml.textContent = ""
  })
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  //console.warn("update", plugin.name, state)

  if (state.editorReadOnly !== xmlEditor.isReadOnly()) {
    // update the editor read-only state
    xmlEditor.setReadOnly(state.editorReadOnly)
    logger.debug(`Setting editor read-only state to ${state.editorReadOnly}`)
    if (state.editorReadOnly) {
      ui.xmlEditor.classList.add("editor-readonly")
      console.warn(ui.statusBar.statusMessageXml)
      ui.statusBar.statusMessageXml.textContent = "🔒 File is read-only"
    } else {
      ui.xmlEditor.classList.remove("editor-readonly")
      ui.statusBar.statusMessageXml.textContent = ""
    }
  }

  // xpath state => selection
  if (!state.xpath || !state.xmlPath) {
    return
  }
  await xmlEditor.whenReady()
  const { index, pathBeforePredicates } = parseXPath(state.xpath)
  // select the node by index
  try {
    const size = xmlEditor.countDomNodesByXpath(state.xpath)
    if (size > 0 && (index !== xmlEditor.currentIndex)) {
      xmlEditor.parentPath = pathBeforePredicates
      xmlEditor.selectByIndex(index || 1)
    }
  } catch (e) {
    console.error(e)
  }
}


/**
 * Called when the selection in the editor changes to update the cursor xpath
 * @param {ApplicationState} state
 */
async function onSelectionChange(state) {
  if (!(xmlEditor.selectedXpath && state.xpath)) {
    // this usually means that the editor is not ready yet
    //console.warn("Could not determine xpath of last selected node")
    return
  }
  // update state from the xpath of the nearest selection node

  const cursorXpath = xmlEditor.selectedXpath
  const cursorParts = parseXPath(cursorXpath)
  const stateParts = parseXPath(state.xpath)

  const normativeXpath = ui.floatingPanel.xpath.value
  const index = cursorParts.index

  // todo: use isXPathsubset()
  if (index !== null && cursorParts.tagName === stateParts.tagName && index !== xmlEditor.currentIndex + 1) {
    const xpath = `${normativeXpath}[${index}]`
    //logger.debug(xpath)
    //updateState(state, {xpath})
  }
}


/**
 * Called when a validation has been done. 
 * Used to save the document after successful validation
 * @param {Diagnostic[]} diagnostics 
 */
async function onValidationResult(diagnostics) {
  if (diagnostics.length === 0) {
    saveIfDirty()
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
    } else {
      logger.debug(`Saved file to ${result.path}`)
    }
  }
}


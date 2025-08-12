/**
 * The XML Editor plugin
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { StatusText } from '../modules/statusbar/widgets/status-text.js'
 * @import { UIElement } from '../ui.js'
 * @import { StatusBar } from '../modules/statusbar/status-bar.js'
 */

import ui, { updateUi } from '../ui.js'
import { validation, services } from '../app.js'
import { StatusBarUtils } from '../modules/statusbar/index.js'
import { NavXmlEditor, XMLEditor } from '../modules/navigatable-xmleditor.js'
import { parseXPath } from '../modules/utils.js'
import { api as logger } from './logger.js'
import { setDiagnostics } from '@codemirror/lint'

//
// UI Components
//

/**
 * XML editor statusbar navigation properties
 * @typedef {object} xmlEditorStatusbarComponent
 * @property {HTMLElement} cursorPosition - The cursor position widget
 */

/**
 * XML editor navigation properties
 * @typedef {object} xmlEditorComponent
 * @property {UIElement<StatusBar, xmlEditorStatusbarComponent>} statusbar - The XML editor statusbar
 */

// the path to the autocompletion data
// Note: tagDataPath removed - autocomplete data now loaded dynamically per document

/**
 * component is an instance of NavXmlEditor
 * @type {NavXmlEditor}
 */
const xmlEditor = new NavXmlEditor('codemirror-container')

// Status widgets for XML editor statusbar
let readOnlyStatusWidget = null
let savingStatusWidget = null
let cursorPositionWidget = null

/**
 * component plugin
 */
const plugin = {
  name: "xmleditor",
  install,
  state: {
    update
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
  // Note: Autocomplete data is now loaded dynamically per document in services.js
  // The static tagData loading has been removed in favor of schema-specific autocomplete data

  // Create status widgets for XML editor statusbar

  /** @type {StatusText} */
  readOnlyStatusWidget = StatusBarUtils.createText({
    text: '🔒 File is read-only',
    variant: 'warning'
  })

  /** @type {StatusText} */
  savingStatusWidget = StatusBarUtils.createText({
    text: 'Saving XML...',
    variant: 'info'
  })

  /** @type {StatusText} */
  cursorPositionWidget =  StatusBarUtils.createText({
    text: 'Ln 1, Col 1',
    variant: 'neutral'
  })
  
  // Add cursor position widget to right side of statusbar
  ui.xmlEditor.statusbar.addWidget(cursorPositionWidget, 'right', 1)

  // selection => xpath state
  xmlEditor.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, evt => {
    xmlEditor.whenReady().then(() => onSelectionChange(state))
    updateCursorPosition()
  });

  // manually show diagnostics if validation is disabled
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_XML_NOT_WELL_FORMED, evt => {
    const customEvent = /** @type CustomEvent */ (evt)
    if (validation.isDisabled()) {
      let view = xmlEditor.getView()
      let diagnostic = customEvent.detail
      try {
        view.dispatch(setDiagnostics(view.state, [diagnostic]))
      } catch (error) {
        logger.warn("Error setting diagnostics: " + error.message)
      }
    }
  })
  
  // Update cursor position when editor is ready
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_READY, updateCursorPosition)
  
  // Update cursor position on editor updates (typing, etc.)
  xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_UPDATE, updateCursorPosition)
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  //console.warn("update", plugin.name, state)

  if (state.xml === null) {
    xmlEditor.clear()
    return 
  }

  if (state.editorReadOnly !== xmlEditor.isReadOnly()) {
    // update the editor read-only state
    xmlEditor.setReadOnly(state.editorReadOnly)
    logger.debug(`Setting editor read-only state to ${state.editorReadOnly}`)
    if (state.editorReadOnly) {
      ui.xmlEditor.classList.add("editor-readonly")
      if (readOnlyStatusWidget && !readOnlyStatusWidget.isConnected) {
        ui.xmlEditor.statusbar.addWidget(readOnlyStatusWidget, 'left', 5)
      }
    } else {
      ui.xmlEditor.classList.remove("editor-readonly")
      if (readOnlyStatusWidget && readOnlyStatusWidget.isConnected) {
        ui.xmlEditor.statusbar.removeWidget(readOnlyStatusWidget)
      }
    }
  }

  // xpath state => selection
  if (xmlEditor.isReady() && state.xpath && state.xml) {
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
  //console.warn(plugin.name,"done")
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

/**
 * Updates the cursor position widget with current line and column
 */
function updateCursorPosition() {
  if (!xmlEditor.isReady() || !cursorPositionWidget) return
  
  const view = xmlEditor.getView()
  const selection = view.state.selection.main
  const line = view.state.doc.lineAt(selection.head)
  const lineNumber = line.number
  const columnNumber = selection.head - line.from + 1
  
  cursorPositionWidget.text = `Ln ${lineNumber}, Col ${columnNumber}`
}


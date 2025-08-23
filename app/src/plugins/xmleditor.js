/**
 * The XML Editor plugin
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { UIPart } from '../ui.js'
 * @import { StatusBar } from '../modules/panels/status-bar.js'
 */

import ui, { updateUi } from '../ui.js'
import { validation, services } from '../app.js'
import { PanelUtils } from '../modules/panels/index.js'
import { NavXmlEditor, XMLEditor } from '../modules/navigatable-xmleditor.js'
import { parseXPath } from '../modules/utils.js'
import { api as logger } from './logger.js'
import { setDiagnostics } from '@codemirror/lint'
import { detectXmlIndentation } from '../modules/codemirror_utils.js'

//
// UI
//

/**
 * XML editor statusbar navigation properties
 * @typedef {object} xmlEditorStatusbarPart
 * @property {StatusText} readOnlyStatus - The read-only status widget
 * @property {StatusText} cursorPosition - The cursor position widget
 * @property {StatusText} indentationStatus - The indentation status widget
 */

/**
 * XML editor navigation properties
 * @typedef {object} xmlEditorPart
 * @property {UIPart<StatusBar, xmlEditorStatusbarPart>} statusbar - The XML editor statusbar
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
let cursorPositionWidget = null
let indentationStatusWidget = null
let statusSeparator = null
let teiHeaderToggleWidget = null

// State to track teiHeader visibility (starts folded)
let teiHeaderVisible = false

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
  readOnlyStatusWidget = PanelUtils.createText({
    text: 'Read-only',
    icon: 'lock-fill',
    variant: 'warning',
    name: 'readOnlyStatus'
  })

  /** @type {StatusText} */
  cursorPositionWidget =  PanelUtils.createText({
    text: 'Ln 1, Col 1',
    variant: 'neutral',
    name: 'cursorPosition'
  })

  /** @type {StatusText} */
  indentationStatusWidget = PanelUtils.createText({
    text: 'Indent: 2 spaces',
    variant: 'neutral',
    name: 'indentationStatus'
  })

  /** @type {StatusText} */
  // <sl-icon name="person-gear"></sl-icon>
  // <sl-icon name="person-fill-gear"></sl-icon>
  teiHeaderToggleWidget = PanelUtils.createText({
    text: '',
    icon: 'person-gear',
    variant: 'neutral',
    name: 'teiHeaderToggle'
  })

  // Create separator between indentation and cursor position
  statusSeparator = PanelUtils.createSeparator({
    variant: 'dotted'
  })
  
  // Add widgets to right side of statusbar (higher priority = more to the right)
  ui.xmlEditor.statusbar.add(indentationStatusWidget, 'right', 1)  // leftmost - indent to left of position  
  ui.xmlEditor.statusbar.add(statusSeparator, 'right', 2)          // separator in middle
  ui.xmlEditor.statusbar.add(cursorPositionWidget, 'right', 3)     // rightmost - position always on far right
  
  // Add teiHeader toggle widget to left side of statusbar
  ui.xmlEditor.statusbar.add(teiHeaderToggleWidget, 'left', 1)

  // selection => xpath state
  xmlEditor.on("selectionChanged", data => {
    xmlEditor.whenReady().then(() => onSelectionChange(state))
    updateCursorPosition()
  });

  // manually show diagnostics if validation is disabled
  xmlEditor.on("editorXmlNotWellFormed", diagnostics => {
    if (validation.isDisabled()) {
      let view = xmlEditor.getView()
      try {
        view.dispatch(setDiagnostics(view.state, diagnostics))
      } catch (error) {
        logger.warn("Error setting diagnostics: " + error.message)
      }
    }
  })
  
  // Update cursor position when editor is ready
  xmlEditor.on("editorReady", updateCursorPosition)
  
  // Update cursor position on editor updates (typing, etc.)
  xmlEditor.on("editorUpdate", updateCursorPosition)

  // Handle indentation detection before loading XML
  xmlEditor.on("editorBeforeLoad", (xml) => {
    const indentUnit = detectXmlIndentation(xml);
    logger.debug(`Detected indentation unit: ${JSON.stringify(indentUnit)}`)
    xmlEditor.configureIntenation(indentUnit, 4); // default tab size of 4 spaces
    updateIndentationStatus(indentUnit)
  })

  // Fold teiHeader after document is loaded
  xmlEditor.on("editorAfterLoad", () => {
    try {
      xmlEditor.foldByXpath('//tei:teiHeader')
      teiHeaderVisible = false // Reset state after document load
      updateTeiHeaderToggleWidget()
    } catch (error) {
      logger.debug(`Error folding teiHeader: ${error.message}`)
    }
  })

  // Add click handler for teiHeader toggle widget
  teiHeaderToggleWidget.addEventListener('click', () => {
    toggleTeiHeaderVisibility()
  })
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
        ui.xmlEditor.statusbar.add(readOnlyStatusWidget, 'left', 5)
      }
    } else {
      ui.xmlEditor.classList.remove("editor-readonly")
      if (readOnlyStatusWidget && readOnlyStatusWidget.isConnected) {
        ui.xmlEditor.statusbar.removeById(readOnlyStatusWidget.id)
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

/**
 * Updates the indentation status widget
 * @param {string} indentUnit - The detected indentation unit
 */
function updateIndentationStatus(indentUnit) {
  if (!indentationStatusWidget) return
  
  let displayText
  if (indentUnit === '\t') {
    displayText = 'Indent: Tabs'
  } else {
    const spaceCount = indentUnit.length
    displayText = `Indent: ${spaceCount} spaces`
  }
  
  indentationStatusWidget.text = displayText
}

/**
 * Toggles the visibility of the teiHeader node
 */
function toggleTeiHeaderVisibility() {
  if (!xmlEditor.isReady()) return
  
  try {
    if (teiHeaderVisible) {
      // Fold the teiHeader
      xmlEditor.foldByXpath('//tei:teiHeader')
      teiHeaderVisible = false
      logger.debug('Folded teiHeader')
    } else {
      // Unfold the teiHeader
      xmlEditor.unfoldByXpath('//tei:teiHeader')
      teiHeaderVisible = true
      logger.debug('Unfolded teiHeader')
    }
    updateTeiHeaderToggleWidget()
  } catch (error) {
    logger.warn(`Error toggling teiHeader visibility: ${error.message}`)
  }
}

/**
 * Updates the teiHeader toggle widget appearance based on visibility state
 */
function updateTeiHeaderToggleWidget() {
  if (!teiHeaderToggleWidget) return
  
  if (teiHeaderVisible) {
    // teiHeader is visible, show filled icon
    teiHeaderToggleWidget.icon = 'person-fill-gear'
    teiHeaderToggleWidget.tooltip = 'Hide teiHeader'
  } else {
    // teiHeader is hidden, show outline icon
    teiHeaderToggleWidget.icon = 'person-gear'
    teiHeaderToggleWidget.tooltip = 'Show teiHeader'
  }
}


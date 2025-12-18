/**
 * The XML Editor plugin
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { UIPart } from '../ui.js'
 * @import { StatusBar } from '../modules/panels/status-bar.js'
 * @import { ToolBar } from '../modules/panels/tool-bar.js'
 */

import ui from '../ui.js'
import { endpoints as ep, app, validation, logger, testLog, services } from '../app.js'
import { PanelUtils, StatusSeparator } from '../modules/panels/index.js'
import { NavXmlEditor, XMLEditor } from '../modules/navigatable-xmleditor.js'
import { parseXPath } from '../modules/utils.js'
import { setDiagnostics } from '@codemirror/lint'
import { detectXmlIndentation } from '../modules/codemirror_utils.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import FiledataPlugin from './filedata.js'
import { isGoldFile } from '../modules/acl-utils.js'

//
// UI
//

/**
 * XML editor headerbar navigation properties
 * @typedef {object} xmlEditorHeaderbarPart
 * @property {StatusText} titleWidget - The document title widget
 */

/**
 * XML editor toolbar navigation properties
 * @typedef {object} xmlEditorToolbarPart
 * @property {HTMLElement} prevDiffBtn - Previous diff button
 * @property {HTMLElement} nextDiffBtn - Next diff button
 * @property {HTMLElement} rejectAllBtn - Reject all changes button
 * @property {HTMLElement} acceptAllBtn - Accept all changes button
 */

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
 * @property {UIPart<StatusBar, xmlEditorHeaderbarPart>} headerbar - The XML editor headerbar
 * @property {UIPart<ToolBar, xmlEditorToolbarPart>} toolbar - The XML editor toolbar
 * @property {UIPart<StatusBar, xmlEditorStatusbarPart>} statusbar - The XML editor statusbar
 */

/**
 * component is an instance of NavXmlEditor
 * @type {NavXmlEditor}
 */
const xmlEditor = new NavXmlEditor('codemirror-container')

// Current state for use in event handlers
/** @type {ApplicationState} */
let currentState;

// Status widgets for XML editor headerbar and statusbar
/** @type {StatusText} */
let titleWidget;

/** @type {StatusText} */
let lastUpdatedWidget;

/** @type {StatusText} */
let readOnlyStatusWidget;

/** @type {StatusText} */
let cursorPositionWidget;

/** @type {StatusText} */
let indentationStatusWidget;

/** @type {StatusText} */
let teiHeaderToggleWidget;

/** @type {StatusSeparator} */
let statusSeparator;

// State to track teiHeader visibility (starts folded)
let teiHeaderVisible = false

/**
 * component plugin
 */
const plugin = {
  name: "xmleditor",
  install,
  start,
  state: {
    update
  }
}

export { xmlEditor as api, plugin, XMLEditor, saveIfDirty, openDocumentAtLine }
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Widgets for the headerbar
  titleWidget = PanelUtils.createText({
    text: '',
    // <sl-icon name="file-earmark-text"></sl-icon>
    icon: 'file-earmark-text',
    variant: 'neutral',
    name: 'titleWidget'
  })
  titleWidget.classList.add('title-widget')

  lastUpdatedWidget = PanelUtils.createText({
    text: '',
    variant: 'neutral',
    name: 'lastUpdatedWidget'
  })
  lastUpdatedWidget.classList.add('title-widget')

  ui.xmlEditor.headerbar.add(titleWidget, 'left', 1)
  ui.xmlEditor.headerbar.add(lastUpdatedWidget, 'right', 1)

  // Widgets for the statusbar
  readOnlyStatusWidget = PanelUtils.createText({
    text: 'Read-only',
    // <sl-icon name="lock-fill"></sl-icon>
    icon: 'lock-fill',
    variant: 'warning',
    name: 'readOnlyStatus'
  })

  cursorPositionWidget = PanelUtils.createText({
    text: 'Ln 1, Col 1',
    variant: 'neutral',
    name: 'cursorPosition'
  })

  indentationStatusWidget = PanelUtils.createText({
    text: 'Indent: 2 spaces',
    variant: 'neutral',
    name: 'indentationStatus'
  })

  // <sl-icon name="person-gear"></sl-icon>
  // <sl-icon name="person-fill-gear"></sl-icon>
  teiHeaderToggleWidget = PanelUtils.createText({
    text: '',
    icon: 'person-gear',
    variant: 'neutral',
    name: 'teiHeaderToggle',
  })
  teiHeaderToggleWidget.style.display = 'none'

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

  // Diff navigation buttons for the toolbar
  // <sl-icon name="chevron-bar-up"></sl-icon>
  const prevDiffBtn = PanelUtils.createButton({
    icon: 'chevron-bar-up',
    tooltip: 'Previous diff',
    action: 'xml-prev-diff',
    name: 'prevDiffBtn'
  })
  prevDiffBtn.addEventListener('widget-click', () => xmlEditor.goToPreviousDiff())

  // <sl-icon name="chevron-bar-down"></sl-icon>
  const nextDiffBtn = PanelUtils.createButton({
    icon: 'chevron-bar-down',
    tooltip: 'Next diff',
    action: 'xml-next-diff',
    name: 'nextDiffBtn'
  })
  nextDiffBtn.addEventListener('widget-click', () => xmlEditor.goToNextDiff())

  ui.xmlEditor.toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 104)
  ui.xmlEditor.toolbar.add(prevDiffBtn, 103)
  ui.xmlEditor.toolbar.add(nextDiffBtn, 102)

  // <sl-icon name="x-circle"></sl-icon>
  const rejectAllBtn = PanelUtils.createButton({
    icon: 'x-circle',
    tooltip: 'Reject all changes',
    action: 'xml-reject-all',
    name: 'rejectAllBtn'
  })
  rejectAllBtn.addEventListener('widget-click', () => {
    xmlEditor.rejectAllDiffs()
    services.removeMergeView()
  })

  // <sl-icon name="check-circle"></sl-icon>
  const acceptAllBtn = PanelUtils.createButton({
    icon: 'check-circle',
    tooltip: 'Accept all changes',
    action: 'xml-accept-all',
    name: 'acceptAllBtn'
  })
  acceptAllBtn.addEventListener('widget-click', () => {
    xmlEditor.acceptAllDiffs()
    services.removeMergeView()
  })

  ui.xmlEditor.toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 101)
  ui.xmlEditor.toolbar.add(rejectAllBtn, 100)
  ui.xmlEditor.toolbar.add(acceptAllBtn, 99)

  // selection => xpath state
  xmlEditor.on("selectionChanged", data => {
    xmlEditor.whenReady().then(() => {
      // Use currentState from the update method
      if (currentState) {
        onSelectionChange(currentState);
      }
    })
    updateCursorPosition()
  });

  // manually show diagnostics if validation is disabled
  xmlEditor.on("editorXmlNotWellFormed", diagnostics => {
    if (validation.isDisabled()) {
      let view = xmlEditor.getView()
      try {
        // Validate diagnostic positions before setting
        const validDiagnostics = diagnostics.filter(d => {
          return d.from >= 0 && d.to > d.from && d.to <= view.state.doc.length
        })
        view.dispatch(setDiagnostics(view.state, validDiagnostics))
      } catch (error) {
        logger.warn("Error setting diagnostics: " + String(error))
        // Clear diagnostics on error
        try {
          view.dispatch(setDiagnostics(view.state, []))
        } catch (clearError) {
          logger.warn("Error clearing diagnostics: " + String(clearError))
        }
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

  // Note: editorXmlWellFormed handler moved to start() function

  // Add widget to toggle <teiHeader> visibility
  xmlEditor.on("editorAfterLoad", () => {
    testLog('XML_EDITOR_DOCUMENT_LOADED', { isReady: true });

    xmlEditor.whenReady().then(() => {
      // Restore line wrapping after XML is loaded
      xmlEditor.setLineWrapping(true)

      // show only if there is a teiHeader in the document
      if (xmlEditor.getDomNodeByXpath("//tei:teiHeader")) {
        teiHeaderToggleWidget.style.display = 'inline-flex'
        try {
          xmlEditor.foldByXpath('//tei:teiHeader')
          teiHeaderVisible = false // Reset state after document load
          updateTeiHeaderToggleWidget()
        } catch (error) {
          logger.debug(`Error folding teiHeader: ${String(error)}`)
        }
      } else {
        teiHeaderToggleWidget.style.display = 'none'
      }
    })
  })

  // Add click handler for teiHeader toggle widget
  teiHeaderToggleWidget.addEventListener('click', () => {
    toggleTeiHeaderVisibility()
  })
}

/**
 * Runs after all plugins are installed to configure xmleditor event handlers
 * @param {ApplicationState} state
 */
async function start(state) {
  logger.debug(`Starting plugin "${plugin.name}" - configuring additional event handlers`)

  // Create validation status widget for showing XML validation errors
  const validationStatusWidget = PanelUtils.createText({
    text: 'XML not valid',
    icon: 'exclamation-triangle-fill',
    variant: 'danger',
    name: 'validationStatus'
  })

  // Additional xmleditor event handlers 

  // save dirty editor content after an update
  xmlEditor.on("editorUpdateDelayed", async () => await saveIfDirty())

  // xml validation events - consolidated from start.js
  xmlEditor.on("editorXmlNotWellFormed", diagnostics => {
    console.warn("XML is not well-formed", diagnostics)
    
    // Show diagnostics either from validation plugin or manually if validation is disabled
    let view = xmlEditor.getView()
    try {
      // Validate diagnostic positions before setting
      const validDiagnostics = diagnostics.filter(d => {
        return d.from >= 0 && d.to > d.from && d.to <= view.state.doc.length
      })
      view.dispatch(setDiagnostics(view.state, validDiagnostics))
    } catch (error) {
      logger.warn("Error setting XML not well-formed diagnostics: " + String(error))
      // Clear diagnostics on error
      try {
        view.dispatch(setDiagnostics(view.state, []))
      } catch (clearError) {
        logger.warn("Error clearing diagnostics: " + String(clearError))
      }
    }
    
    // Show validation error in statusbar
    if (validationStatusWidget && !validationStatusWidget.isConnected) {
      ui.xmlEditor.statusbar.add(validationStatusWidget, 'left', 5)
    }
    // @ts-ignore
    ui.xmlEditor.querySelector(".cm-content").classList.add("invalid-xml")
  })
  
  xmlEditor.on("editorXmlWellFormed", async () => {
    // @ts-ignore
    ui.xmlEditor.querySelector(".cm-content").classList.remove("invalid-xml")
    try {
      xmlEditor.getView().dispatch(setDiagnostics(xmlEditor.getView().state, []))
    } catch (error) {
      logger.warn("Error clearing diagnostics on well-formed XML: " + String(error))
    }
    // Remove validation error from statusbar
    if (validationStatusWidget && validationStatusWidget.isConnected) {
      ui.xmlEditor.statusbar.removeById(validationStatusWidget.id)
    }
  })

  // dis/enable diff buttons
  const enableDiffButtons = (value) => {
    ui.xmlEditor.toolbar.prevDiffBtn.disabled = !value;
    ui.xmlEditor.toolbar.nextDiffBtn.disabled = !value;
    ui.xmlEditor.toolbar.rejectAllBtn.disabled = !value;
    ui.xmlEditor.toolbar.acceptAllBtn.disabled = !value;
  }
  xmlEditor.on(XMLEditor.EVENT_EDITOR_SHOW_MERGE_VIEW, () => {
    enableDiffButtons(true)
  })
  xmlEditor.on(XMLEditor.EVENT_EDITOR_HIDE_MERGE_VIEW, () => {
    enableDiffButtons(false)
  })
  enableDiffButtons(false)
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  // Store current state for use in event handlers
  currentState = state;

  [readOnlyStatusWidget, cursorPositionWidget,
    indentationStatusWidget, teiHeaderToggleWidget]
    .forEach(widget => widget.style.display = state.xml ? 'inline-flex' : 'none')

  // Update title widget with document title
  const fileData = getFileDataById(state.xml)
  if (fileData?.item) {
    const versionType = isGoldFile(state.xml) ? "Gold" : "Version"
    const versionName = fileData.item.version_name || fileData.item.label || '';
    titleWidget.text = `${versionType}: ${versionName}`
  } else {
    titleWidget.text = '';
  }
  if (fileData?.item && fileData.item.last_update && fileData.item.last_updated_by) {
    const updateDate = new Date(fileData.item.last_update).toLocaleDateString()
    const updateTime = new Date(fileData.item.last_update).toLocaleTimeString()
    const lastUpdatedBy = fileData.item.last_updated_by?.replace("#", '')
    lastUpdatedWidget.text = `Last revision: ${updateDate}, ${updateTime} by ${lastUpdatedBy}` 
  } else {
    lastUpdatedWidget.text = ''
  }

  if (!state.xml) {
    xmlEditor.clear()
    xmlEditor.setReadOnly(true)
    return
  }

  // update the editor read-only state
  if (state.editorReadOnly !== xmlEditor.isReadOnly()) {
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
  }
}

/** @type {string|null} */
let hashBeingSaved = null;

/**
 * Save the current XML file if the editor is "dirty"
 */
async function saveIfDirty() {
  const fileHash = currentState.xml
  const isHashBeingSaved = fileHash === hashBeingSaved
  const hasXmlTree = !!xmlEditor.getXmlTree()
  const isDirty = xmlEditor.isDirty()

  if (isHashBeingSaved || !fileHash || !hasXmlTree || !isDirty) {
    let reason;
    if (isHashBeingSaved) reason = "Already saving document"
    if (!fileHash) reason = "No document"
    if (!hasXmlTree) reason = "No valid xml document"
    if (!isDirty) reason = "Document hasn't changed"
    logger.debug(`Not saving: ${reason}`)
    return
  }

  try {
    hashBeingSaved = fileHash
    const filedata = FiledataPlugin.getInstance()
    const result = await filedata.saveXml(fileHash)
    if (!result|| typeof result != "object" || !result.status)  {
      logger.warn("Invalid result from filedata.saveXml: " + result)
      return
    }
    hashBeingSaved = null
    if (result.status == "unchanged") {
      logger.debug(`File has not changed`)
    } else {
      logger.debug(`Saved file with file_id ${result.file_id}`)
      if (result.file_id && result.file_id !== fileHash) {
        // Update state to use new file_id
        await app.updateState({ xml: result.file_id })
      }
    }
    xmlEditor.markAsClean()
  } catch (error) {
    logger.warn(`Save failed: ${String(error)}`)
  }

}

/**
 * Open document and scroll to line
 * @param {string} stableId - Document stable ID
 * @param {number} lineNumber - Line number (1-based)
 * @param {number} [column=0] - Optional column position (0-based)
 */
async function openDocumentAtLine(stableId, lineNumber, column = 0) {
  
  await xmlEditor.hideMergeView()
  
  // Load document
  await services.load({xml:stableId})

  // Wait for editor to update (use requestAnimationFrame)
  await new Promise(resolve => requestAnimationFrame(resolve));

  // Scroll to line
  xmlEditor.scrollToLine(lineNumber, column);
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
    logger.warn(`Error toggling teiHeader visibility: ${String(error)}`)
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


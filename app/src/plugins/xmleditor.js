/**
 * The XML Editor plugin
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { StatusSwitch } from '../modules/panels/widgets/status-switch.js'
 * @import { StatusDropdown } from '../modules/panels/widgets/status-dropdown.js'
 * @import { UIPart, SlDropdown, SlMenu, SlIconButton } from '../ui.js'
 * @import { StatusBar } from '../modules/panels/status-bar.js'
 * @import { ToolBar } from '../modules/panels/tool-bar.js'
 * @import { xslViewerOverlayPart } from './xsl-viewer.js'
 * @import { UserData } from './authentication.js'
 */

import ui, {updateUi} from '../ui.js'
import { app, validation, logger, testLog, services } from '../app.js'
import { PanelUtils } from '../modules/panels/index.js'
import { NavXmlEditor, XMLEditor } from '../modules/navigatable-xmleditor.js'
import { parseXPath } from '../modules/utils.js'
import { setDiagnostics } from '@codemirror/lint'
import { detectXmlIndentation } from '../modules/codemirror_utils.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import FiledataPlugin from './filedata.js'
import { isGoldFile, userHasRole } from '../modules/acl-utils.js'
import { registerTemplate, createFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { client } from '../plugins.js'

// Register templates
await registerTemplate('xmleditor-headerbar', 'xmleditor-headerbar.html')
await registerTemplate('xmleditor-headerbar-right', 'xmleditor-headerbar-right.html')
await registerTemplate('xmleditor-toolbar', 'xmleditor-toolbar.html')
await registerTemplate('xmleditor-tei-buttons', 'xmleditor-tei-buttons.html')
await registerTemplate('xmleditor-import-export-buttons', 'xmleditor-import-export-buttons.html')
await registerTemplate('xmleditor-statusbar', 'xmleditor-statusbar.html')
await registerTemplate('xmleditor-statusbar-right', 'xmleditor-statusbar-right.html')

//
// UI
//

/**
 * XML editor headerbar navigation properties
 * @typedef {object} xmlEditorHeaderbarPart
 * @property {StatusText} titleWidget - The document title widget
 * @property {StatusText} lastUpdatedWidget - The last updated widget
 */

/**
 * XML editor toolbar navigation properties
 * @typedef {object} xmlEditorToolbarPart
 * @property {StatusButton} prevDiffBtn - Previous diff button
 * @property {StatusButton} nextDiffBtn - Next diff button
 * @property {StatusButton} rejectAllBtn - Reject all changes button
 * @property {StatusButton} acceptAllBtn - Accept all changes button
 * @property {StatusButton} validateBtn - Validate XML button
 * @property {StatusButton} teiWizardBtn - TEI Wizard button (added by tei-wizard plugin)
 * @property {SlDropdown} xslViewerDropdown - XSL viewer dropdown (added by xsl-viewer plugin)
 * @property {StatusButton} xslViewerBtn - XSL viewer button (added by xsl-viewer plugin)
 * @property {SlMenu} xslViewerMenu - XSL viewer menu (added by xsl-viewer plugin)
 * @property {StatusButton} uploadBtn - Upload document button
 * @property {StatusButton} downloadBtn - Download document button
 * @property {StatusButton} revisionHistoryBtn - Revision history button (added by tei-tools plugin)
 */

/**
 * XML editor statusbar navigation properties
 * @typedef {object} xmlEditorStatusbarPart
 * @property {StatusSwitch} lineWrappingSwitch - Line wrapping toggle switch
 * @property {StatusButton} prevNodeBtn - Previous node navigation button
 * @property {StatusDropdown} xpathDropdown - XPath selector dropdown
 * @property {StatusButton} nextNodeBtn - Next node navigation button
 * @property {StatusText} nodeCounterWidget - Node counter display (index/size)
 * @property {StatusText} indentationStatusWidget - The indentation status widget
 * @property {StatusText} cursorPositionWidget - The cursor position widget
 */

/**
 * XML editor navigation properties
 * @typedef {object} xmlEditorPart
 * @property {UIPart<StatusBar, xmlEditorHeaderbarPart>} headerbar - The XML editor headerbar
 * @property {UIPart<ToolBar, xmlEditorToolbarPart>} toolbar - The XML editor toolbar
 * @property {UIPart<StatusBar, xmlEditorStatusbarPart>} statusbar - The XML editor statusbar
 * @property {UIPart<HTMLDivElement, xslViewerOverlayPart>} xslViewerOverlay - XSL transformation overlay (added by xsl-viewer plugin)
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

// Node navigation widgets
/** @type {StatusButton} */
let prevNodeBtn;

/** @type {StatusDropdown} */
let xpathDropdown;

/** @type {StatusButton} */
let nextNodeBtn;

/** @type {StatusText} */
let nodeCounterWidget;

// State for node navigation
/** @type {string|null} */
let currentVariant = null;

/** @type {object[]|null} */
let cachedExtractors = null;

/** @type {UserData|null} */
let currentUser = null;

/**
 * Get line wrapping preference from localStorage
 * @returns {boolean} Line wrapping enabled state (defaults to true)
 */
function getLineWrappingPreference() {
  const stored = localStorage.getItem('xmleditor.lineWrapping')
  return stored === null ? true : stored === 'true'
}

/**
 * Set line wrapping preference in localStorage
 * @param {boolean} enabled - Line wrapping enabled state
 */
function setLineWrappingPreference(enabled) {
  localStorage.setItem('xmleditor.lineWrapping', String(enabled))
}

/**
 * Get saved xpath preference for a variant from localStorage
 * @param {string} variantId - The variant ID
 * @returns {string|null} Saved xpath or null
 */
function getXpathPreference(variantId) {
  return localStorage.getItem(`xmleditor.xpath.${variantId}`)
}

/**
 * Set xpath preference for a variant in localStorage
 * @param {string} variantId - The variant ID
 * @param {string} xpath - The xpath to save (base path without index)
 */
function setXpathPreference(variantId, xpath) {
  if (xpath) {
    localStorage.setItem(`xmleditor.xpath.${variantId}`, xpath)
  } else {
    localStorage.removeItem(`xmleditor.xpath.${variantId}`)
  }
}

/**
 * component plugin
 */
const plugin = {
  name: "xmleditor",
  install,
  start,
  state: {
    update
  },
  validation: {
    inProgress
  }
}

export { xmlEditor as api, plugin, XMLEditor, saveIfDirty, openDocumentAtLine, inProgress }
export default plugin

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create headerbar widgets from templates and add to headerbar
  const headerbarLeftWidgets = createFromTemplate('xmleditor-headerbar')
  headerbarLeftWidgets.forEach(widget => {
    if (widget instanceof HTMLElement) {
      ui.xmlEditor.headerbar.add(widget, 'left', 1)
    }
  })

  const headerbarRightWidgets = createFromTemplate('xmleditor-headerbar-right')
  headerbarRightWidgets.forEach(widget => {
    if (widget instanceof HTMLElement) {
      ui.xmlEditor.headerbar.add(widget, 'right', 1)
    }
  })

  // Create statusbar widgets from templates and add to statusbar
  const statusbarLeftWidgets = createFromTemplate('xmleditor-statusbar')
  statusbarLeftWidgets.forEach(widget => {
    if (widget instanceof HTMLElement) {
      ui.xmlEditor.statusbar.add(widget, 'left', 1)
    }
  })

  const statusbarRightWidgets = createFromTemplate('xmleditor-statusbar-right')
  statusbarRightWidgets.forEach((widget, index) => {
    if (widget instanceof HTMLElement) {
      // Add widgets to right side (higher priority = more to the right)
      // indentationStatusWidget (priority 1), separator (priority 2), cursorPositionWidget (priority 3)
      ui.xmlEditor.statusbar.add(widget, 'right', index + 1)
    }
  })

  // Create toolbar widgets from templates and add to toolbar
  const toolbarWidgets = createFromTemplate('xmleditor-toolbar')
  const toolbarPriorities = [104, 103, 102, 101, 100, 99] // separator, prevDiff, nextDiff, separator, reject, accept
  toolbarWidgets.forEach((widget, index) => {
    if (widget instanceof HTMLElement) {
      ui.xmlEditor.toolbar.add(widget, toolbarPriorities[index] || 1)
    }
  })

  // Create TEI action buttons and add to toolbar (to the left of upload/download)
  const teiButtons = createFromTemplate('xmleditor-tei-buttons')
  const teiButtonsPriorities = [52, 51] // separator, validateBtn
  teiButtons.forEach((widget, index) => {
    if (widget instanceof HTMLElement) {
      ui.xmlEditor.toolbar.add(widget, teiButtonsPriorities[index] || 1)
    }
  })

  // Create import/export buttons and add to toolbar (right side)
  const importExportButtons = createFromTemplate('xmleditor-import-export-buttons')
  const importExportPriorities = [50, 3, 2] // spacer, upload, download
  importExportButtons.forEach((widget, index) => {
    if (widget instanceof HTMLElement) {
      ui.xmlEditor.toolbar.add(widget, importExportPriorities[index] || 1)
    }
  })

  // Read-only status widget (added dynamically when needed)
  readOnlyStatusWidget = PanelUtils.createText({
    text: 'Read-only',
    icon: 'lock-fill',
    variant: 'warning',
    name: 'readOnlyStatus'
  })

  // Update UI to register named widgets
  updateUi()

  // Store references to widgets for later use
  titleWidget = ui.xmlEditor.headerbar.titleWidget
  lastUpdatedWidget = ui.xmlEditor.headerbar.lastUpdatedWidget
  indentationStatusWidget = ui.xmlEditor.statusbar.indentationStatusWidget
  cursorPositionWidget = ui.xmlEditor.statusbar.cursorPositionWidget

  // Initialize line wrapping switch from stored preference
  const lineWrappingEnabled = getLineWrappingPreference()
  ui.xmlEditor.statusbar.lineWrappingSwitch.checked = lineWrappingEnabled

  // Attach event listeners to toolbar buttons
  ui.xmlEditor.toolbar.prevDiffBtn.addEventListener('widget-click', () => xmlEditor.goToPreviousDiff())
  ui.xmlEditor.toolbar.nextDiffBtn.addEventListener('widget-click', () => xmlEditor.goToNextDiff())
  ui.xmlEditor.toolbar.rejectAllBtn.addEventListener('widget-click', () => {
    xmlEditor.rejectAllDiffs()
    services.removeMergeView()
  })
  ui.xmlEditor.toolbar.acceptAllBtn.addEventListener('widget-click', () => {
    xmlEditor.acceptAllDiffs()
    services.removeMergeView()
  })

  // Attach event listeners to import/export buttons
  ui.xmlEditor.toolbar.uploadBtn.addEventListener('widget-click', () => {
    if (currentState) services.uploadXml(currentState)
  })
  ui.xmlEditor.toolbar.downloadBtn.addEventListener('widget-click', () => {
    if (currentState) services.downloadXml(currentState)
  })

  // Attach event listener to validate button
  ui.xmlEditor.toolbar.validateBtn.addEventListener('widget-click', async () => {
    ui.xmlEditor.toolbar.validateBtn.disabled = true
    const diagnostics = await validation.validate()
    notify(`The document contains ${diagnostics.length} validation error${diagnostics.length === 1 ? '' : 's'}.`)
  })

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

  // Restore line wrapping and xpath after XML is loaded
  xmlEditor.on("editorAfterLoad", () => {
    testLog('XML_EDITOR_DOCUMENT_LOADED', { isReady: true });

    xmlEditor.whenReady().then(() => {
      // Apply user's line wrapping preference after XML is loaded
      xmlEditor.setLineWrapping(getLineWrappingPreference())

      // Restore xpath from localStorage if not already set
      // Use setTimeout to defer state update outside the state propagation cycle
      setTimeout(() => {
        if (!currentState?.xpath && currentState?.variant) {
          const savedXpath = getXpathPreference(currentState.variant)
          const items = xpathDropdown.items || []
          const savedXpathInItems = savedXpath && items.some(item => item.value === savedXpath)
          console.log('DEBUG editorAfterLoad restore:', { savedXpath, savedXpathInItems, stateXpath: currentState?.xpath })
          if (savedXpathInItems) {
            console.log('DEBUG editorAfterLoad: Restoring xpath:', `${savedXpath}[1]`)
            app.updateState({ xpath: `${savedXpath}[1]` })
          }
        }
      }, 0)
    })
  })

  // Add change handler for line wrapping toggle
  ui.xmlEditor.statusbar.lineWrappingSwitch.addEventListener('widget-change', (e) => {
    const enabled = e.detail.checked
    setLineWrappingPreference(enabled)
    xmlEditor.setLineWrapping(enabled)
    logger.debug(`Line wrapping ${enabled ? 'enabled' : 'disabled'}`)
  })

  // Capture Ctrl/Cmd+S to trigger XML download instead of browser save
  const xmlEditorContainer = document.getElementById('codemirror-container')
  if (xmlEditorContainer) {
    xmlEditorContainer.addEventListener('keydown', (evt) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === 's') {
        evt.preventDefault()
        evt.stopPropagation()
        if (currentState) {
          services.downloadXml(currentState)
        }
      }
    })
  }

  // Create node navigation widgets for statusbar center section
  prevNodeBtn = PanelUtils.createButton({
    icon: 'chevron-left',
    tooltip: 'Previous node',
    name: 'prevNodeBtn'
  })

  xpathDropdown = PanelUtils.createDropdown({
    placeholder: 'Select XPath...',
    name: 'xpathDropdown'
  })

  nextNodeBtn = PanelUtils.createButton({
    icon: 'chevron-right',
    tooltip: 'Next node',
    name: 'nextNodeBtn'
  })

  nodeCounterWidget = PanelUtils.createText({
    text: '(0/0)',
    name: 'nodeCounterWidget'
  })

  // Add navigation widgets to statusbar center section
  ui.xmlEditor.statusbar.add(prevNodeBtn, 'center', 0)
  ui.xmlEditor.statusbar.add(xpathDropdown, 'center', 0)
  ui.xmlEditor.statusbar.add(nextNodeBtn, 'center', 0)
  ui.xmlEditor.statusbar.add(nodeCounterWidget, 'center', 0)

  // Update UI to register navigation widgets
  updateUi()

  // Initially hide navigation widgets
  setNavigationWidgetsVisible(false)

  // XPath dropdown change handler - navigate to first node when selecting xpath
  xpathDropdown.addEventListener('widget-change', async (evt) => {
    // Ignore events during initial setup before app is ready
    if (!app.updateState) return
    const customEvt = /** @type {CustomEvent} */ (evt)
    const baseXpath = customEvt.detail.value
    // Save preference for current variant
    if (currentVariant) {
      console.log('DEBUG: Saving xpath preference:', { variant: currentVariant, xpath: baseXpath })
      setXpathPreference(currentVariant, baseXpath)
    }
    // Append [1] to navigate to the first node
    await app.updateState({ xpath: baseXpath ? `${baseXpath}[1]` : '' })
  })

  // Navigation button handlers
  prevNodeBtn.addEventListener('widget-click', () => changeNodeIndex(currentState, -1))
  nextNodeBtn.addEventListener('widget-click', () => changeNodeIndex(currentState, +1))

  // Counter click handler (allow direct index input)
  nodeCounterWidget.addEventListener('click', onClickSelectionIndex)
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

  // Cache extractor list when user changes
  let extractorsJustCached = false
  if (currentUser !== state.user && state.user !== null) {
    const previousUser = currentUser
    currentUser = state.user

    if (!cachedExtractors || (previousUser !== null && previousUser !== state.user)) {
      try {
        cachedExtractors = await client.getExtractorList()
        extractorsJustCached = true
        logger.debug('Cached extractor list for node navigation')
      } catch (error) {
        logger.warn('Failed to load extractor list: ' + String(error))
        cachedExtractors = []
      }
    }
  }

  // Check if variant has changed, repopulate xpath dropdown
  console.log('DEBUG update(): variant check', {
    currentVariant,
    stateVariant: state.variant,
    extractorsJustCached,
    willPopulate: currentVariant !== state.variant || extractorsJustCached
  })
  if (currentVariant !== state.variant || extractorsJustCached) {
    currentVariant = state.variant
    await populateXpathDropdown(state)
  }

  // Update navigation widget visibility based on dropdown content and document load state
  const hasNavigationPaths = xpathDropdown.items && xpathDropdown.items.length > 0
    && !xpathDropdown.items[0].disabled
  setNavigationWidgetsVisible(hasNavigationPaths && Boolean(state.xml))

  // Update xpath selection and counter
  if (state.xpath) {
    let { index, pathBeforePredicates, nonIndexPredicates } = parseXPath(state.xpath)
    const nonIndexedPath = pathBeforePredicates + nonIndexPredicates

    // Set dropdown selection
    const optionValues = xpathDropdown.items?.map(item => item.value) || []
    const foundAtIndex = optionValues.indexOf(nonIndexedPath)
    if (foundAtIndex >= 0) {
      xpathDropdown.selected = nonIndexedPath
    } else {
      xpathDropdown.selected = ''
    }

    // Update counter
    xmlEditor.whenReady().then(() => updateNodeCounter(nonIndexedPath, index))
  }
  // Note: xpath restoration from localStorage is handled in editorAfterLoad event

  // Keep line wrapping switch always visible but disable when no document
  ui.xmlEditor.statusbar.lineWrappingSwitch.disabled = !state.xml

  // Hide other statusbar widgets when no document
  ;[readOnlyStatusWidget, cursorPositionWidget, indentationStatusWidget]
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
    // Clear visual indicators when no document is loaded
    ui.xmlEditor.classList.remove("editor-readonly")
    if (readOnlyStatusWidget && readOnlyStatusWidget.isConnected) {
      ui.xmlEditor.statusbar.removeById(readOnlyStatusWidget.id)
    }
    return
  }

  // update the editor read-only state
  if (state.editorReadOnly !== xmlEditor.isReadOnly()) {
    xmlEditor.setReadOnly(state.editorReadOnly)
    logger.debug(`Setting editor read-only state to ${state.editorReadOnly}`)
  }

  // Update visual indicators based on state (always, to handle lock conflicts)
  if (state.editorReadOnly) {
    if (!ui.xmlEditor.classList.contains("editor-readonly")) {
      ui.xmlEditor.classList.add("editor-readonly")
    }
    if (readOnlyStatusWidget && !readOnlyStatusWidget.isConnected) {
      ui.xmlEditor.statusbar.add(readOnlyStatusWidget, 'left', 5)
    }
  } else {
    if (ui.xmlEditor.classList.contains("editor-readonly")) {
      ui.xmlEditor.classList.remove("editor-readonly")
    }
    if (readOnlyStatusWidget && readOnlyStatusWidget.isConnected) {
      ui.xmlEditor.statusbar.removeById(readOnlyStatusWidget.id)
    }
  }

  // Update import/export button states based on user role and state
  const isAnnotator = userHasRole(state.user, ['admin', 'reviewer', 'annotator'])
  if (isAnnotator) {
    ui.xmlEditor.toolbar.downloadBtn.disabled = !Boolean(state.xml)
    ui.xmlEditor.toolbar.uploadBtn.disabled = state.editorReadOnly || state.offline
  } else {
    ui.xmlEditor.toolbar.downloadBtn.disabled = true
    ui.xmlEditor.toolbar.uploadBtn.disabled = true
  }

  // xpath state => selection
  if (xmlEditor.isReady() && state.xpath && state.xml) {
    const { index, pathBeforePredicates } = parseXPath(state.xpath)
    // select the node by index
    try {
      // Count nodes matching the base xpath (without index)
      const size = xmlEditor.countDomNodesByXpath(pathBeforePredicates)
      // Navigate if: there are matching nodes AND (path changed OR index changed)
      const pathChanged = xmlEditor.parentPath !== pathBeforePredicates
      const indexChanged = index !== xmlEditor.currentIndex
      if (size > 0 && (pathChanged || indexChanged)) {
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

  const normativeXpath = xpathDropdown.selected
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
    logger.error(error)
    notify(`Save failed: ${String(error)}`, 'danger', 'exclamation-octagon');
  } finally {
    hashBeingSaved = null
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
 * Sets the visibility of navigation widgets
 * @param {boolean} visible - Whether to show the widgets
 */
function setNavigationWidgetsVisible(visible) {
  const display = visible ? 'inline-flex' : 'none'
  prevNodeBtn.style.display = display
  xpathDropdown.style.display = display
  nextNodeBtn.style.display = display
  nodeCounterWidget.style.display = display
}

/**
 * Given an xpath and an index, displays the index and the number of occurrences
 * @param {string} xpath The xpath that will be counted
 * @param {number|null} index The index or null if the result set is empty
 */
function updateNodeCounter(xpath, index) {
  let size
  try {
    size = xmlEditor.countDomNodesByXpath(xpath)
  } catch (e) {
    logger.warn('Cannot update counter: ' + String(e))
    size = 0
  }
  index = index || 1
  nodeCounterWidget.text = `(${size > 0 ? index : 0}/${size})`
  nextNodeBtn.disabled = prevNodeBtn.disabled = size < 2
}

/**
 * Navigate to previous/next node
 * @param {ApplicationState} state
 * @param {number} delta
 */
async function changeNodeIndex(state, delta) {
  if (isNaN(delta)) {
    throw new TypeError("Second argument must be a number")
  }
  console.log('DEBUG changeNodeIndex:', { stateXpath: state?.xpath, delta })
  if (!state?.xpath) {
    console.log('DEBUG changeNodeIndex: returning early - no state.xpath')
    return
  }

  let { pathBeforePredicates, nonIndexPredicates, index } = parseXPath(state.xpath)
  const normativeXpath = pathBeforePredicates + nonIndexPredicates
  const size = xmlEditor.countDomNodesByXpath(normativeXpath)
  console.log('DEBUG changeNodeIndex:', { normativeXpath, size, index })
  if (size < 2) {
    console.log('DEBUG changeNodeIndex: returning early - size < 2')
    return
  }
  if (index === null) index = 1
  index += delta
  if (index < 1) index = size
  if (index > size) index = 1
  const xpath = normativeXpath + `[${index}]`
  await app.updateState({ xpath })
}

/**
 * Called when the user clicks on the counter to enter the node index
 */
function onClickSelectionIndex() {
  const index = prompt('Enter node index')
  if (!index) return
  try {
    xmlEditor.selectByIndex(parseInt(index))
  } catch (error) {
    logger.warn('Failed to select by index: ' + String(error))
  }
}

/**
 * Populates the xpath dropdown based on the current variant
 * @param {ApplicationState} state
 */
async function populateXpathDropdown(state) {
  const variantId = state.variant

  if (!variantId) {
    xpathDropdown.setItems([{ value: '', text: 'No variant selected', disabled: true }])
    return
  }

  if (!cachedExtractors) {
    xpathDropdown.setItems([{ value: '', text: 'Error loading navigation paths', disabled: true }])
    return
  }

  // Find the extractor that contains this variant
  let navigationXpathList = null
  for (const extractor of cachedExtractors) {
    const navigationXpath = extractor.navigation_xpath?.[variantId]
    if (navigationXpath) {
      navigationXpathList = navigationXpath
      break
    }
  }

  if (!navigationXpathList) {
    xpathDropdown.setItems([{ value: '', text: `No navigation paths for variant: ${variantId}`, disabled: true }])
    return
  }

  // Populate dropdown with options (skip null values)
  const items = navigationXpathList
    .filter(item => item.value !== null)
    .map(item => ({
      value: item.value,
      text: item.label
    }))

  xpathDropdown.setItems(items)
  // Restoration of saved xpath preference is handled in update() when editor is ready
}

/**
 * Invoked when a plugin starts a validation to disable the validate button
 * @param {Promise<any>} validationPromise
 */
async function inProgress(validationPromise) {
  ui.xmlEditor.toolbar.validateBtn.disabled = true
  await validationPromise
  ui.xmlEditor.toolbar.validateBtn.disabled = false
}

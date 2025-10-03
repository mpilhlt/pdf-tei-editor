/**
 * PDF Viewer Plugin
 */

/** @import { ApplicationState } from '../state.js' */
/** @import { UIPart } from '../ui.js' */
/** @import { StatusBar } from '../modules/panels/status-bar.js' */
import { PDFJSViewer } from '../modules/pdfviewer.js'
import { PanelUtils, StatusText } from '../modules/panels/index.js'
import ui, { updateUi } from '../ui.js'
import { logger, services, xmlEditor, hasStateChanged } from '../app.js'
import { getDocumentTitle, getFileDataByHash } from '../modules/file-data-utils.js'

//
// UI Parts
//

/**
 * PDF viewer headerbar navigation properties
 * @typedef {object} pdfViewerHeaderbarPart
 * @property {HTMLElement} titleWidget - The document title widget
 * @property {HTMLElement} filenameWidget - The widget for displaying the filename
 */

/**
 * PDF viewer statusbar navigation properties
 * @typedef {object} pdfViewerStatusbarPart
 * @property {HTMLElement} searchSwitch - The autosearch toggle switch
 */

/**
 * PDF viewer navigation properties
 * @typedef {object} pdfViewerPart
 * @property {UIPart<StatusBar, pdfViewerHeaderbarPart>} headerbar - The PDF viewer headerbar
 * @property {UIPart<StatusBar, pdfViewerStatusbarPart>} statusbar - The PDF viewer statusbar
 */

/**
 * Expose the PDFViewer API
 * @type {PDFJSViewer}
 */
const pdfViewer = new PDFJSViewer('pdf-viewer')

// hide it until ready
pdfViewer.hide()

// Note: currentFile state tracking now handled via state.previousState instead of local variable
/** @type {StatusText} */
let titleWidget;

/** @type {StatusText} */
let filenameWidget;

/**
 * plugin object
 */
const plugin = {
  name: "pdfviewer",
  install,
  state: { update }
}

export { plugin, pdfViewer as api }
export default plugin

//
// Implementation
//

/**
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  await pdfViewer.isReady()
  logger.info("PDF Viewer ready.")
  pdfViewer.show()
  
  // Add title and filename widgets to PDF viewer headerbar
  const headerBar = ui.pdfViewer.headerbar
  titleWidget = PanelUtils.createText({
    text: '',
    // <sl-icon name="file-pdf"></sl-icon>
    icon: 'file-pdf',
    variant: 'neutral',
    name: 'titleWidget'
  })
  titleWidget.classList.add('title-widget')
  headerBar.add(titleWidget, 'left', 1)

  filenameWidget = PanelUtils.createText({
    text: '',
    variant: 'neutral',
    name: 'filenameWidget'
  })
  headerBar.add(filenameWidget, 'right', 1)
  
  // Add autosearch switch to PDF viewer statusbar
  const statusBar = ui.pdfViewer.statusbar
  const autoSearchSwitch = PanelUtils.createSwitch({
    text: 'Autosearch',
    helpText: 'off',
    checked: false,
    name: 'searchSwitch'
  })
  
  autoSearchSwitch.addEventListener('widget-change', onAutoSearchSwitchChange)
  statusBar.add(autoSearchSwitch, 'left', 10)
  
  // Update UI to register named elements
  updateUi()
}

/**
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function update(state) {
  if (hasStateChanged(state, 'pdf')) {
    // Clear PDF viewer when no PDF is loaded
    if (state.pdf === null) {
      try {
        await pdfViewer.clear();
      } catch (error) {
        logger.warn("Error clearing PDF viewer:" + String(error));
      }
    }
  }
  
  // Update title and fileame widgets
  if (state.pdf) {
    filenameWidget.text = getFileDataByHash(state.pdf)?.file?.fileref || ''
    try {
      const title = getDocumentTitle(state.pdf);
      titleWidget.text = title || 'PDF Document';
    } catch (error) {
      titleWidget.text = 'PDF Document';
    }
  } else if (titleWidget) {
    titleWidget.text = '';
    filenameWidget.text = '';
  }
}

/**
 * Called when the autosearch switch is toggled
 * @param {Event} evt 
 */
async function onAutoSearchSwitchChange(evt) {
  const customEvt = /** @type {CustomEvent} */ (evt)
  const checked = customEvt.detail.checked
  const autoSearchSwitch = customEvt.detail.widget
  
  // Update help text
  if (autoSearchSwitch) {
    const newHelpText = checked ? 'on' : 'off'
    autoSearchSwitch.setAttribute('help-text', newHelpText)
  }
  
  logger.info(`Auto search is: ${checked}`)
  if (checked && xmlEditor.selectedNode) {
    await services.searchNodeContentsInPdf(xmlEditor.selectedNode)
  }
}

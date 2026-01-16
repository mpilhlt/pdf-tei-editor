/**
 * PDF Viewer Plugin
 */

/** @import { ApplicationState } from '../state.js' */
/** @import { UIPart } from '../ui.js' */
/** @import { StatusBar } from '../modules/panels/status-bar.js' */
import { PDFJSViewer } from '../modules/pdfviewer.js'
import { PanelUtils, StatusText } from '../modules/panels/index.js'
import ui, { updateUi } from '../ui.js'
import { app, logger, services, xmlEditor, hasStateChanged } from '../app.js'
import { getDocumentTitle, getFileDataById } from '../modules/file-data-utils.js'
import { notify } from '../modules/sl-utils.js'

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
 * PDF viewer toolbar properties
 * @typedef {object} pdfViewerToolbarPart
 * @property {HTMLElement} sidebarToggleBtn - Sidebar toggle button
 * @property {HTMLElement} textSelectBtn - Text selection tool button
 * @property {HTMLElement} handToolBtn - Hand tool button
 * @property {HTMLElement} prevPageBtn - Previous page button
 * @property {HTMLElement} nextPageBtn - Next page button
 * @property {HTMLElement} pageInfoWidget - Page info display
 * @property {HTMLElement} zoomOutBtn - Zoom out button
 * @property {HTMLElement} zoomInBtn - Zoom in button
 * @property {HTMLElement} zoomInfoWidget - Zoom level display
 * @property {HTMLElement} fitPageBtn - Fit page button
 * @property {HTMLElement} downloadBtn - Download PDF button
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
 * @property {UIPart<ToolBar, pdfViewerToolbarPart>} toolbar - The PDF viewer toolbar
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

  // Make clickable to copy doc_id to clipboard if clipboard API is available
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    filenameWidget.clickable = true
    filenameWidget.tooltip = 'Click to copy document id'
    filenameWidget.addEventListener('widget-click', () => {
      const docId = filenameWidget.text
      if (docId) {
        navigator.clipboard.writeText(docId).then(() => {
          notify(`Document id '${docId}' copied to clipboard`, 'success', 'clipboard-check')
        }).catch(err => {
          console.error('Failed to copy to clipboard:', err)
          notify('Failed to copy to clipboard', 'danger', 'exclamation-triangle')
        })
      }
    })
  }

  headerBar.add(filenameWidget, 'right', 1)

  // Add PDF navigation controls to the toolbar
  const toolbar = ui.pdfViewer.toolbar

  // Sidebar toggle button
  // <sl-icon name="layout-sidebar"></sl-icon>
  const sidebarToggleBtn = PanelUtils.createButton({
    icon: 'layout-sidebar',
    tooltip: 'Toggle sidebar',
    action: 'pdf-toggle-sidebar',
    name: 'sidebarToggleBtn'
  })
  sidebarToggleBtn.addEventListener('widget-click', () => onToggleSidebar())
  toolbar.add(sidebarToggleBtn, 110)

  // Separator
  toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 107)

  // Cursor tool buttons (hand tool / text select)
  // <sl-icon name="cursor-text"></sl-icon> for text selection
  const textSelectBtn = PanelUtils.createButton({
    icon: 'cursor-text',
    tooltip: 'Text selection',
    action: 'pdf-text-select-tool',
    name: 'textSelectBtn',
    variant: 'primary' // Active by default
  })
  textSelectBtn.addEventListener('widget-click', () => onSelectTextTool())
  toolbar.add(textSelectBtn, 106)

  // <sl-icon name="hand-index"></sl-icon> for hand tool
  const handToolBtn = PanelUtils.createButton({
    icon: 'hand-index',
    tooltip: 'Hand tool (drag to pan)',
    action: 'pdf-hand-tool',
    name: 'handToolBtn'
  })
  handToolBtn.addEventListener('widget-click', () => onSelectHandTool())
  toolbar.add(handToolBtn, 105)

  // Separator
  toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 104)

  // Page navigation - left side
  // <sl-icon name="chevron-left"></sl-icon>
  const prevPageBtn = PanelUtils.createButton({
    icon: 'chevron-left',
    tooltip: 'Previous page',
    action: 'pdf-prev-page',
    name: 'prevPageBtn'
  })
  prevPageBtn.addEventListener('widget-click', () => onPageNav(-1))
  toolbar.add(prevPageBtn, 100)

  const pageInfoWidget = PanelUtils.createText({
    text: '',
    tooltip: 'Current page / Total pages',
    name: 'pageInfoWidget'
  })
  toolbar.add(pageInfoWidget, 99)

  // <sl-icon name="chevron-right"></sl-icon>
  const nextPageBtn = PanelUtils.createButton({
    icon: 'chevron-right',
    tooltip: 'Next page',
    action: 'pdf-next-page',
    name: 'nextPageBtn'
  })
  nextPageBtn.addEventListener('widget-click', () => onPageNav(1))
  toolbar.add(nextPageBtn, 98)

  // Separator
  toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 90)

  // Zoom controls
  // <sl-icon name="dash-lg"></sl-icon>
  const zoomOutBtn = PanelUtils.createButton({
    icon: 'dash-lg',
    tooltip: 'Zoom out',
    action: 'pdf-zoom-out',
    name: 'zoomOutBtn'
  })
  zoomOutBtn.addEventListener('widget-click', () => onZoom(-0.1))
  toolbar.add(zoomOutBtn, 80)

  const zoomInfoWidget = PanelUtils.createText({
    text: '100%',
    tooltip: 'Zoom level',
    name: 'zoomInfoWidget'
  })
  toolbar.add(zoomInfoWidget, 79)

  // <sl-icon name="plus-lg"></sl-icon>
  const zoomInBtn = PanelUtils.createButton({
    icon: 'plus-lg',
    tooltip: 'Zoom in',
    action: 'pdf-zoom-in',
    name: 'zoomInBtn'
  })
  zoomInBtn.addEventListener('widget-click', () => onZoom(0.1))
  toolbar.add(zoomInBtn, 78)

  // <sl-icon name="arrows-angle-contract"></sl-icon>
  const fitPageBtn = PanelUtils.createButton({
    icon: 'arrows-angle-contract',
    tooltip: 'Fit page to width',
    action: 'pdf-fit-page',
    name: 'fitPageBtn'
  })
  fitPageBtn.addEventListener('widget-click', () => onFitPage())
  toolbar.add(fitPageBtn, 77)

  // Separator
  toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 70)

  // Download PDF button
  // <sl-icon name="download"></sl-icon>
  const downloadBtn = PanelUtils.createButton({
    icon: 'download',
    tooltip: 'Download PDF',
    action: 'pdf-download',
    name: 'downloadBtn'
  })
  downloadBtn.addEventListener('widget-click', () => onDownloadPdf())
  toolbar.add(downloadBtn, 60)

  // Add autosearch switch to statusbar
  const statusBar = ui.pdfViewer.statusbar
  const autoSearchSwitchWidget = PanelUtils.createSwitch({
    text: 'Autosearch',
    helpText: 'off',
    checked: false,
    name: 'searchSwitch'
  })

  autoSearchSwitchWidget.addEventListener('widget-change', onAutoSearchSwitchChange)
  statusBar.add(autoSearchSwitchWidget, 'left', 10)
  // TODO: Autosearch is not working, hide until fixed
  autoSearchSwitchWidget.style.display = 'none'

  // Listen to PDF viewer events to update controls
  pdfViewer.eventBus.on('pagechanging', (evt) => {
    updatePageInfo(evt.pageNumber, pdfViewer.pdfDoc?.numPages || 0)
  })

  pdfViewer.eventBus.on('scalechanging', (evt) => {
    updateZoomInfo(evt.scale)
  })

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
  
  // Update title and filename widgets
  if (state.pdf) {
    filenameWidget.text = getFileDataById(state.pdf)?.file?.doc_id || ''
    try {
      const title = getDocumentTitle(state.pdf);
      titleWidget.text = title || 'PDF Document';
      titleWidget.tooltip = title || 'PDF Document';
    } catch (error) {
      titleWidget.text = 'PDF Document';
      titleWidget.tooltip = 'PDF Document';
    }
  } else if (titleWidget) {
    titleWidget.text = '';
    titleWidget.tooltip = '';
    filenameWidget.text = '';
  }
}

/**
 * Navigate to previous/next page
 * @param {number} delta - Page delta (-1 for previous, +1 for next)
 */
async function onPageNav(delta) {
  if (!pdfViewer.pdfViewer || !pdfViewer.pdfDoc) return;

  const currentPage = pdfViewer.pdfViewer.currentPageNumber;
  const newPage = currentPage + delta;

  if (newPage >= 1 && newPage <= pdfViewer.pdfDoc.numPages) {
    await pdfViewer.goToPage(newPage);
  }
}

/**
 * Zoom in/out
 * @param {number} delta - Zoom delta (-0.1 for zoom out, +0.1 for zoom in)
 */
async function onZoom(delta) {
  if (!pdfViewer.pdfViewer) return;

  const currentScale = pdfViewer.pdfViewer.currentScale;
  const newScale = Math.max(0.5, Math.min(3.0, currentScale + delta));

  await pdfViewer.setZoom(newScale);
}

/**
 * Fit page to width
 */
async function onFitPage() {
  await pdfViewer.setZoom('page-fit');
}

/**
 * Toggle sidebar visibility
 */
function onToggleSidebar() {
  pdfViewer.toggleSidebar();
}

/**
 * Activate text selection tool
 */
function onSelectTextTool() {
  if (!pdfViewer.isHandTool()) return; // Already in text selection mode

  pdfViewer.setTextSelectMode();

  // Update button variants
  const textSelectBtn = ui.pdfViewer.toolbar.textSelectBtn;
  const handToolBtn = ui.pdfViewer.toolbar.handToolBtn;

  textSelectBtn.setAttribute('variant', 'primary');
  handToolBtn.setAttribute('variant', 'default');
}

/**
 * Activate hand tool
 */
function onSelectHandTool() {
  if (pdfViewer.isHandTool()) return; // Already in hand tool mode

  pdfViewer.setHandToolMode();

  // Update button variants
  const textSelectBtn = ui.pdfViewer.toolbar.textSelectBtn;
  const handToolBtn = ui.pdfViewer.toolbar.handToolBtn;

  textSelectBtn.setAttribute('variant', 'default');
  handToolBtn.setAttribute('variant', 'primary');
}

/**
 * Download the current PDF
 */
async function onDownloadPdf() {
  if (!pdfViewer.pdfDoc) {
    notify('No PDF loaded', 'warning', 'exclamation-triangle');
    return;
  }

  try {
    const state = app.getCurrentState();
    const fileData = getFileDataById(state.pdf);

    if (!fileData || !fileData.item) {
      notify('Cannot find PDF file data', 'danger', 'exclamation-octagon');
      return;
    }

    // Create a download link using the stable ID from the item
    const url = `/api/v1/files/${fileData.item.id}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = fileData.item.filename || 'document.pdf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    notify('PDF download started', 'success', 'check-circle');
  } catch (error) {
    logger.error('Failed to download PDF:', error);
    notify('Failed to download PDF', 'danger', 'exclamation-octagon');
  }
}

/**
 * Update page info display
 * @param {number} pageNumber - Current page number
 * @param {number} totalPages - Total number of pages
 */
function updatePageInfo(pageNumber, totalPages) {
  const pageInfoWidget = ui.pdfViewer.toolbar.pageInfoWidget;
  if (pageInfoWidget) {
    pageInfoWidget.setAttribute('text', `${pageNumber} / ${totalPages}`);
  }
}

/**
 * Update zoom info display
 * @param {number} scale - Current zoom scale
 */
function updateZoomInfo(scale) {
  const zoomInfoWidget = ui.pdfViewer.toolbar.zoomInfoWidget;
  if (zoomInfoWidget) {
    const percentage = Math.round(scale * 100);
    zoomInfoWidget.setAttribute('text', `${percentage}%`);
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

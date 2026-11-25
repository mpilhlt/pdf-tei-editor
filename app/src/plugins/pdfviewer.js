/**
 * PDF Viewer Plugin
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { UIPart, SlDrawer } from '../ui.js'
 * @import { diagnosticsDrawerPart, diagnosticsButtonPart } from '../templates/diagnostics-drawer.types.js'
 */

import { PDFJSViewer } from '../modules/pdfviewer.js'
import { PanelUtils, StatusText } from '../modules/panels/index.js'
import ui from '../ui.js'
import { getDocumentTitle, getFileDataById } from '../modules/file-data-utils.js'
import { notify } from '../modules/sl-utils.js'
import { SessionStorage } from '../modules/session-storage.js'
import { userHasRole } from '../modules/acl-utils.js'
import { encodeFilename, decodeFilename } from '../modules/doi-utils.js'
import Plugin from '../modules/plugin-base.js'
import ep from '../extension-points.js'

/** Delay after the last page change before `pdfViewer.pageChanged` is invoked */
const PAGE_CHANGED_DELAY_MS = 300;

//
// UI Parts
//

/**
 * PDF viewer navigation properties
 * @typedef {object} pdfViewerPart
 * @property {import('../modules/panels/status-bar.js').StatusBar} headerbar
 * @property {import('../modules/panels/tool-bar.js').ToolBar} toolbar
 * @property {import('../modules/panels/status-bar.js').StatusBar} statusbar
 * @property {UIPart<SlDrawer, diagnosticsDrawerPart>} diagnosticsDrawer - Diagnostics drawer over the PDF pages (added by diagnostics-drawer plugin)
 * @property {UIPart<HTMLButtonElement, diagnosticsButtonPart>} diagnosticsButton - Floating button that shows the retracted diagnostics drawer (added by diagnostics-drawer plugin)
 */

class PdfViewerPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'pdfviewer',
      deps: ['logger', 'client']
    });
    this.#pdfViewer = new PDFJSViewer('pdf-viewer');
    this.#pdfViewer.hide();
  }

  get #logger() { return this.getDependency('logger') }
  get #client() { return this.getDependency('client') }

  /** @type {PDFJSViewer} */
  #pdfViewer;
  /** @type {SessionStorage} */
  #storage = new SessionStorage('pdfviewer');
  #isRestoringState = false;
  /** @type {StatusText} */
  #titleWidget;
  /** @type {StatusText} */
  #filenameWidget;
  /** @type {HTMLElement} */
  #textSelectBtn;
  /** @type {HTMLElement} */
  #handToolBtn;
  /** @type {HTMLElement} */
  #pageInfoWidget;
  /** @type {HTMLElement} */
  #zoomInfoWidget;
  /** @type {StatusText|null} */
  #statusMessageWidget = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  #statusMessageTimer = null;
  /** @type {StatusText|null} Shown while the viewer shows an archived original PDF */
  #archivedPdfWidget = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  #pageChangedTimer = null;

  /**
   * Returns a proxy that exposes plugin-level methods alongside the PDFJSViewer API.
   * Plugin methods take precedence; all other property accesses fall through to the inner viewer.
   * TODO: Add a dedciated accessor and refactor consuming plugins's calls accordingly
   * @returns {PDFJSViewer}
   */
  getApi() {
    const plugin = this;
    const inner = this.#pdfViewer;
    const pluginMethods = new Set(['showStatusMessage', 'clearStatusMessage', 'setArchivedPdfIndicator']);
    return /** @type {PDFJSViewer} */ (new Proxy(inner, {
      get(_target, prop) {
        if (pluginMethods.has(String(prop))) {
          return /** @type {any} */ (plugin)[prop].bind(plugin);
        }
        const val = inner[/** @type {keyof PDFJSViewer} */ (prop)];
        return typeof val === 'function' ? val.bind(inner) : val;
      }
    }));
  }

  /**
   * Shows a transient message on the left of the statusbar.
   * A new message replaces the current one and restarts the timeout.
   * @param {string} text - The message
   * @param {{variant?: 'default'|'warning'|'error'|'success', timeout?: number}} [options]
   *   `timeout` is the time in milliseconds after which the message is removed (default: 5000)
   */
  showStatusMessage(text, { variant = 'warning', timeout = 5000 } = {}) {
    const statusBar = ui.pdfViewer.statusbar;
    if (this.#statusMessageTimer) {
      clearTimeout(this.#statusMessageTimer);
    }
    if (!this.#statusMessageWidget) {
      this.#statusMessageWidget = PanelUtils.createText({ name: 'statusMessage' });
      statusBar.add(this.#statusMessageWidget, 'left', 9);
    }
    this.#statusMessageWidget.text = text;
    this.#statusMessageWidget.variant = variant;
    this.#statusMessageTimer = setTimeout(() => this.clearStatusMessage(), timeout);
  }

  /**
   * Removes the message shown with {@link showStatusMessage}, if any, before its timeout.
   */
  clearStatusMessage() {
    if (this.#statusMessageTimer) {
      clearTimeout(this.#statusMessageTimer);
      this.#statusMessageTimer = null;
    }
    if (this.#statusMessageWidget) {
      ui.pdfViewer.statusbar.removeById(this.#statusMessageWidget.id);
      this.#statusMessageWidget = null;
    }
  }

  /**
   * Shows or hides the statusbar notice that the viewer shows the original PDF of the document,
   * as it was before text recognition replaced it: the loaded version was made from it (#924).
   * @param {boolean} shown
   */
  setArchivedPdfIndicator(shown) {
    const statusBar = ui.pdfViewer.statusbar;
    if (shown && !this.#archivedPdfWidget) {
      this.#archivedPdfWidget = PanelUtils.createText({
        name: 'archivedPdfIndicator',
        text: 'Original PDF (before text recognition)',
        icon: 'clock-history',
        variant: 'warning'
      });
      this.#archivedPdfWidget.title = 'This version was made from the PDF as it was before text recognition. Newer versions use the current PDF.';
      statusBar.add(this.#archivedPdfWidget, 'left', 8);
    } else if (!shown && this.#archivedPdfWidget) {
      statusBar.removeById(this.#archivedPdfWidget.id);
      this.#archivedPdfWidget = null;
    }
  }

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState);
    this.#logger.debug(`Installing plugin "${this.name}"`);

    await this.#pdfViewer.isReady();
    this.#logger.info("PDF Viewer ready.");
    this.#pdfViewer.show();

    // Add title and filename widgets to PDF viewer headerbar
    const headerBar = ui.pdfViewer.headerbar;
    this.#titleWidget = PanelUtils.createText({
      text: '',
      icon: 'file-pdf',
      variant: 'neutral',
      name: 'titleWidget'
    });
    this.#titleWidget.classList.add('title-widget');

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      this.#titleWidget.clickable = true;
      this.#titleWidget.dblclickable = true;
      this.#titleWidget.tooltip = 'Click to copy, doubleclick to edit';
      this.#titleWidget.addEventListener('widget-click', () => {
        const title = this.#titleWidget.text;
        if (title) {
          navigator.clipboard.writeText(title).then(() => {
            notify(`Document title copied to clipboard`, 'success', 'clipboard-check');
          }).catch(err => {
            this.#logger.error('Failed to copy to clipboard: ' + String(err));
            notify('Failed to copy to clipboard', 'danger', 'exclamation-triangle');
          });
        }
      });
      this.#titleWidget.addEventListener('widget-dblclick', () => this.#editTitle());
    }

    headerBar.add(this.#titleWidget, 'left', 1);

    this.#filenameWidget = PanelUtils.createText({
      text: '',
      variant: 'neutral',
      name: 'filenameWidget'
    });

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      this.#filenameWidget.clickable = true;
      this.#filenameWidget.dblclickable = true;
      this.#filenameWidget.tooltip = 'Click to copy, doubleclick to edit';
      this.#filenameWidget.addEventListener('widget-click', () => {
        const docId = this.#filenameWidget.text;
        if (docId) {
          navigator.clipboard.writeText(docId).then(() => {
            notify(`Document id '${docId}' copied to clipboard`, 'success', 'clipboard-check');
          }).catch(err => {
            this.#logger.error('Failed to copy to clipboard: ' + String(err));
            notify('Failed to copy to clipboard', 'danger', 'exclamation-triangle');
          });
        }
      });
      this.#filenameWidget.addEventListener('widget-dblclick', () => this.#editDocId());
    }

    headerBar.add(this.#filenameWidget, 'right', 1);

    const toolbar = ui.pdfViewer.toolbar;

    const sidebarToggleBtn = PanelUtils.createButton({
      icon: 'layout-sidebar',
      tooltip: 'Toggle sidebar',
      action: 'pdf-toggle-sidebar',
      name: 'sidebarToggleBtn'
    });
    sidebarToggleBtn.addEventListener('widget-click', () => this.#onToggleSidebar());
    toolbar.add(sidebarToggleBtn, 110);

    toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 107);

    this.#textSelectBtn = PanelUtils.createButton({
      icon: 'cursor-text',
      tooltip: 'Text selection',
      action: 'pdf-text-select-tool',
      name: 'textSelectBtn',
      variant: 'primary'
    });
    this.#textSelectBtn.addEventListener('widget-click', () => this.#onSelectTextTool());
    toolbar.add(this.#textSelectBtn, 106);

    this.#handToolBtn = PanelUtils.createButton({
      icon: 'hand-index',
      tooltip: 'Hand tool (drag to pan)',
      action: 'pdf-hand-tool',
      name: 'handToolBtn'
    });
    this.#handToolBtn.addEventListener('widget-click', () => this.#onSelectHandTool());
    toolbar.add(this.#handToolBtn, 105);

    toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 104);

    const prevPageBtn = PanelUtils.createButton({
      icon: 'chevron-left',
      tooltip: 'Previous page',
      action: 'pdf-prev-page',
      name: 'prevPageBtn'
    });
    prevPageBtn.addEventListener('widget-click', () => this.#onPageNav(-1));
    toolbar.add(prevPageBtn, 100);

    this.#pageInfoWidget = PanelUtils.createText({
      text: '',
      tooltip: 'Current page / Total pages',
      name: 'pageInfoWidget'
    });
    toolbar.add(this.#pageInfoWidget, 99);

    const nextPageBtn = PanelUtils.createButton({
      icon: 'chevron-right',
      tooltip: 'Next page',
      action: 'pdf-next-page',
      name: 'nextPageBtn'
    });
    nextPageBtn.addEventListener('widget-click', () => this.#onPageNav(1));
    toolbar.add(nextPageBtn, 98);

    toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 90);

    const zoomOutBtn = PanelUtils.createButton({
      icon: 'dash-lg',
      tooltip: 'Zoom out',
      action: 'pdf-zoom-out',
      name: 'zoomOutBtn'
    });
    zoomOutBtn.addEventListener('widget-click', () => this.#onZoom(-0.1));
    toolbar.add(zoomOutBtn, 80);

    this.#zoomInfoWidget = PanelUtils.createText({
      text: '100%',
      tooltip: 'Zoom level',
      name: 'zoomInfoWidget'
    });
    toolbar.add(this.#zoomInfoWidget, 79);

    const zoomInBtn = PanelUtils.createButton({
      icon: 'plus-lg',
      tooltip: 'Zoom in',
      action: 'pdf-zoom-in',
      name: 'zoomInBtn'
    });
    zoomInBtn.addEventListener('widget-click', () => this.#onZoom(0.1));
    toolbar.add(zoomInBtn, 78);

    const fitPageBtn = PanelUtils.createButton({
      icon: 'arrows-angle-contract',
      tooltip: 'Fit page to width',
      action: 'pdf-fit-page',
      name: 'fitPageBtn'
    });
    fitPageBtn.addEventListener('widget-click', () => this.#onFitPage());
    toolbar.add(fitPageBtn, 77);

    toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 70);

    const downloadBtn = PanelUtils.createButton({
      icon: 'download',
      tooltip: 'Download PDF',
      action: 'pdf-download',
      name: 'downloadBtn'
    });
    downloadBtn.addEventListener('widget-click', () => this.#onDownloadPdf());
    toolbar.add(downloadBtn, 60);

    // Capture Ctrl/Cmd+S to trigger PDF download
    const pdfViewerContainer = document.getElementById('pdf-viewer');
    if (pdfViewerContainer) {
      pdfViewerContainer.addEventListener('keydown', (evt) => {
        if ((evt.ctrlKey || evt.metaKey) && evt.key === 's') {
          evt.preventDefault();
          evt.stopPropagation();
          this.#onDownloadPdf();
        }
      });
    }

    // Listen to PDF viewer events to update controls and persist state
    this.#pdfViewer.eventBus.on('pagechanging', (evt) => {
      this.#updatePageInfo(evt.pageNumber, this.#pdfViewer.pdfDoc?.numPages || 0);
      this.#schedulePageChanged(evt.pageNumber);
      if (!this.#isRestoringState) {
        const pdfId = this.state?.pdf;
        if (pdfId) {
          this.#storage.setValue(pdfId, 'page', evt.pageNumber);
        }
      }
    });

    this.#pdfViewer.eventBus.on('scalechanging', (evt) => {
      this.#updateZoomInfo(evt.scale);
      if (!this.#isRestoringState) {
        const pdfId = this.state?.pdf;
        if (pdfId) {
          this.#storage.setValue(pdfId, 'zoom', evt.scale);
        }
      }
    });

    // Listen to scroll events to persist scroll position
    const viewerContainer = this.#pdfViewer.pdfViewerContainer;
    if (viewerContainer) {
      let scrollTimeout = null;
      viewerContainer.addEventListener('scroll', () => {
        if (this.#isRestoringState) return;
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          const pdfId = this.state?.pdf;
          if (pdfId) {
            this.#storage.setState(pdfId, {
              scrollX: viewerContainer.scrollLeft,
              scrollY: viewerContainer.scrollTop
            });
          }
        }, 250);
      });
    }

    // Restore cursor tool mode
    if (this.uiStorage.get('handTool', false)) {
      this.#pdfViewer.setHandToolMode();
      this.#textSelectBtn.setAttribute('variant', 'default');
      this.#handToolBtn.setAttribute('variant', 'primary');
    }
  }

  /**
   * Adds the statusbar widgets that other plugins contribute via the
   * `pdfViewer.statusbarItems` extension point.
   * @returns {Promise<void>}
   */
  async start() {
    const results = await this.context.invokePluginEndpoint(
      ep.pdfViewer.statusbarItems, [], { result: 'values', throws: false }
    );
    const statusBar = ui.pdfViewer.statusbar;
    for (const items of results) {
      if (!Array.isArray(items)) continue;
      for (const { element, position = 'left', priority = 0 } of items) {
        if (element instanceof HTMLElement && !element.isConnected) {
          statusBar.add(element, position, priority);
        }
      }
    }
  }

  /**
   * Invokes the `pdfViewer.pageChanged` extension point once the page has stopped
   * changing for PAGE_CHANGED_DELAY_MS (a scroll over several pages counts as one change).
   * @param {number} page - 1-based page number
   * @returns {void}
   */
  #schedulePageChanged(page) {
    if (this.#pageChangedTimer) {
      clearTimeout(this.#pageChangedTimer);
    }
    this.#pageChangedTimer = setTimeout(() => {
      this.#pageChangedTimer = null;
      const userInitiated = this.#pdfViewer.isUserNavigation();
      this.context.invokePluginEndpoint(ep.pdfViewer.pageChanged, [page, { userInitiated }], { result: 'values', throws: false });
    }, PAGE_CHANGED_DELAY_MS);
  }

  /**
   * React to state changes
   * @param {string[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) {
    if (changedKeys.includes('pdf')) {
      if (state.pdf === null) {
        try {
          await this.#pdfViewer.clear();
        } catch (error) {
          this.#logger.warn("Error clearing PDF viewer:" + String(error));
        }
      } else {
        this.#waitForPagesLoaded().then(() => this.#restoreViewerState(state.pdf));
      }
    }

    if (state.pdf) {
      this.#filenameWidget.text = getFileDataById(state.pdf)?.file?.doc_id || '';
      try {
        const title = getDocumentTitle(state.pdf);
        this.#titleWidget.text = title || 'PDF Document';
      } catch (error) {
        this.#titleWidget.text = 'PDF Document';
      }
    } else if (this.#titleWidget) {
      this.#titleWidget.text = '';
      this.#filenameWidget.text = '';
    }
  }

  //
  // Private methods
  //

  /**
   * Prompt the reviewer to edit the document title
   */
  async #editTitle() {
    if (!this.state?.pdf) return;
    if (!userHasRole(this.state.user, ['admin', 'reviewer'])) {
      notify('You are not allowed to edit the document title', 'warning', 'exclamation-triangle');
      return;
    }
    const currentTitle = this.#titleWidget.text;
    const newTitle = prompt('Edit document label:', currentTitle);
    if (newTitle === null || newTitle.trim() === currentTitle) return;
    try {
      await this.#client.apiClient.filesPatchMetadata(this.state.pdf, { label: newTitle.trim() });
      notify('Document title updated', 'success', 'check-circle');
      await this.getDependency('file-selection').reload({ refresh: true });
    } catch (error) {
      this.#logger.error('Failed to update title: ' + String(error));
      notify('Failed to update title: ' + String(error), 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Prompt the reviewer to edit the document ID
   */
  async #editDocId() {
    if (!this.state?.pdf) return;
    if (!userHasRole(this.state.user, ['admin', 'reviewer'])) {
      notify('You are not allowed to edit the document ID', 'warning', 'exclamation-triangle');
      return;
    }
    const currentDocId = this.#filenameWidget.text;
    const newDocId = prompt('Edit document ID:', currentDocId);
    if (newDocId === null || newDocId.trim() === currentDocId) return;

    let finalDocId = newDocId.trim();
    const decoded = decodeFilename(finalDocId);
    const encoded = encodeFilename(decoded);
    if (encoded !== finalDocId) {
      const useEncoded = confirm(
        `The document ID contains characters that need encoding.\n\nEntered: ${finalDocId}\nEncoded: ${encoded}\n\nUse the encoded version?`
      );
      if (!useEncoded) return;
      finalDocId = encoded;
    }

    try {
      await this.#client.apiClient.filesDocId(this.state.pdf, { doc_id: finalDocId });
      notify(`Document ID updated to '${finalDocId}'`, 'success', 'check-circle');
      await this.getDependency('file-selection').reload({ refresh: true });
      await this.getDependency('services').load({ xml: this.state.xml });
    } catch (error) {
      this.#logger.error('Failed to update doc_id: ' + String(error));
      notify('Failed to update document ID: ' + String(error), 'danger', 'exclamation-octagon');
    }
  }

  /**
   * Waits for the PDF pages to be loaded
   * @returns {Promise<void>}
   */
  #waitForPagesLoaded() {
    // The pdf state changes after the load has started, so the promise
    // belongs to the document that is being shown. Fall back to a timeout
    // in case PDF.js never reports the pages as loaded.
    return Promise.race([
      this.#pdfViewer.pagesLoadedPromise ?? Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }

  /**
   * @param {number} delta
   */
  async #onPageNav(delta) {
    if (!this.#pdfViewer.pdfViewer || !this.#pdfViewer.pdfDoc) return;
    const currentPage = this.#pdfViewer.pdfViewer.currentPageNumber;
    const newPage = currentPage + delta;
    if (newPage >= 1 && newPage <= this.#pdfViewer.pdfDoc.numPages) {
      await this.#pdfViewer.goToPage(newPage);
      this.#pdfViewer.markUserNavigation();
    }
  }

  /**
   * @param {number} delta
   */
  async #onZoom(delta) {
    if (!this.#pdfViewer.pdfViewer) return;
    const currentScale = this.#pdfViewer.pdfViewer.currentScale;
    const newScale = Math.max(0.5, Math.min(3.0, currentScale + delta));
    await this.#pdfViewer.setZoom(newScale);
  }

  async #onFitPage() {
    await this.#pdfViewer.setZoom('page-fit');
  }

  #onToggleSidebar() {
    this.#pdfViewer.toggleSidebar();
  }

  #onSelectTextTool() {
    if (!this.#pdfViewer.isHandTool()) return;
    this.#pdfViewer.setTextSelectMode();
    this.uiStorage.set('handTool', false);
    this.#textSelectBtn.setAttribute('variant', 'primary');
    this.#handToolBtn.setAttribute('variant', 'default');
  }

  #onSelectHandTool() {
    if (this.#pdfViewer.isHandTool()) return;
    this.#pdfViewer.setHandToolMode();
    this.uiStorage.set('handTool', true);
    this.#textSelectBtn.setAttribute('variant', 'default');
    this.#handToolBtn.setAttribute('variant', 'primary');
  }

  async #onDownloadPdf() {
    if (!this.#pdfViewer.pdfDoc) {
      notify('No PDF loaded', 'warning', 'exclamation-triangle');
      return;
    }
    try {
      const fileData = getFileDataById(this.state?.pdf);
      if (!fileData || !fileData.item) {
        notify('Cannot find PDF file data', 'danger', 'exclamation-octagon');
        return;
      }
      const url = `/api/v1/files/${fileData.item.id}`;
      const link = document.createElement('a');
      link.href = url;
      link.download = fileData.item.filename || 'document.pdf';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      notify('PDF download started', 'success', 'check-circle');
    } catch (error) {
      this.#logger.error('Failed to download PDF:', error);
      notify('Failed to download PDF', 'danger', 'exclamation-octagon');
    }
  }

  /**
   * @param {number} pageNumber
   * @param {number} totalPages
   */
  #updatePageInfo(pageNumber, totalPages) {
    this.#pageInfoWidget.setAttribute('text', `${pageNumber} / ${totalPages}`);
  }

  /**
   * @param {number} scale
   */
  #updateZoomInfo(scale) {
    this.#zoomInfoWidget.setAttribute('text', `${Math.round(scale * 100)}%`);
  }

  /**
   * @param {string} pdfId
   */
  async #restoreViewerState(pdfId) {
    const state = this.#storage.getState(pdfId);
    if (!state || Object.keys(state).length === 0) return;

    this.#isRestoringState = true;

    try {
      if (state.zoom !== undefined) {
        await this.#pdfViewer.setZoom(state.zoom);
      }
      // A search (e.g. by the "Sync with editor" switch) may already have positioned the view
      // on a match in this document: don't jump away from it
      if (this.#pdfViewer._highlightMatch) {
        return;
      }
      if (state.page !== undefined) {
        await this.#pdfViewer.goToPage(state.page);
      }
      if (state.scrollX !== undefined || state.scrollY !== undefined) {
        await new Promise(resolve => setTimeout(resolve, 150));
        const container = this.#pdfViewer.pdfViewerContainer;
        if (container && !this.#pdfViewer._highlightMatch) {
          if (state.scrollX !== undefined) container.scrollLeft = state.scrollX;
          if (state.scrollY !== undefined) container.scrollTop = state.scrollY;
        }
      }
    } finally {
      setTimeout(() => {
        this.#isRestoringState = false;
      }, 300);
    }
  }
}

export default PdfViewerPlugin;

/** @deprecated Use PdfViewerPlugin class directly */
export const plugin = PdfViewerPlugin;


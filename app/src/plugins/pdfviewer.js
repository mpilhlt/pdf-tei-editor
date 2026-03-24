/**
 * PDF Viewer Plugin
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { UIPart } from '../ui.js'
 * @import { StatusBar } from '../modules/panels/status-bar.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { PDFJSViewer } from '../modules/pdfviewer.js'
import { PanelUtils, StatusText } from '../modules/panels/index.js'
import ui, { updateUi } from '../ui.js'
import { getDocumentTitle, getFileDataById } from '../modules/file-data-utils.js'
import { notify } from '../modules/sl-utils.js'
import { SessionStorage } from '../modules/session-storage.js'
import { userHasRole, isGoldFile } from '../modules/acl-utils.js'
import { encodeFilename, decodeFilename } from '../modules/doi-utils.js'
import Plugin from '../modules/plugin-base.js'

//
// UI Parts
//

/**
 * PDF viewer headerbar navigation properties
 * @typedef {object} pdfViewerHeaderbarPart
 * @property {StatusText} titleWidget - The document title widget
 * @property {StatusText} filenameWidget - The widget for displaying the filename (doc_id)
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

  // Cached dependencies
  #logger;
  #client;

  // Private state
  /** @type {PDFJSViewer} */
  #pdfViewer;
  /** @type {SessionStorage} */
  #storage = new SessionStorage('pdfviewer');
  #isRestoringState = false;
  /** @type {StatusText} */
  #titleWidget;
  /** @type {StatusText} */
  #filenameWidget;

  /**
   * Return the PDFJSViewer instance as the plugin API
   * @returns {PDFJSViewer}
   */
  getApi() {
    return this.#pdfViewer;
  }

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState);
    this.#logger = this.getDependency('logger');
    this.#client = this.getDependency('client');
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

    const textSelectBtn = PanelUtils.createButton({
      icon: 'cursor-text',
      tooltip: 'Text selection',
      action: 'pdf-text-select-tool',
      name: 'textSelectBtn',
      variant: 'primary'
    });
    textSelectBtn.addEventListener('widget-click', () => this.#onSelectTextTool());
    toolbar.add(textSelectBtn, 106);

    const handToolBtn = PanelUtils.createButton({
      icon: 'hand-index',
      tooltip: 'Hand tool (drag to pan)',
      action: 'pdf-hand-tool',
      name: 'handToolBtn'
    });
    handToolBtn.addEventListener('widget-click', () => this.#onSelectHandTool());
    toolbar.add(handToolBtn, 105);

    toolbar.add(PanelUtils.createSeparator({ variant: 'vertical' }), 104);

    const prevPageBtn = PanelUtils.createButton({
      icon: 'chevron-left',
      tooltip: 'Previous page',
      action: 'pdf-prev-page',
      name: 'prevPageBtn'
    });
    prevPageBtn.addEventListener('widget-click', () => this.#onPageNav(-1));
    toolbar.add(prevPageBtn, 100);

    const pageInfoWidget = PanelUtils.createText({
      text: '',
      tooltip: 'Current page / Total pages',
      name: 'pageInfoWidget'
    });
    toolbar.add(pageInfoWidget, 99);

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

    const zoomInfoWidget = PanelUtils.createText({
      text: '100%',
      tooltip: 'Zoom level',
      name: 'zoomInfoWidget'
    });
    toolbar.add(zoomInfoWidget, 79);

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

    // Add autosearch switch to statusbar
    const statusBar = ui.pdfViewer.statusbar;
    const savedAutoSearch = this.#storage.getGlobal('autosearch', false);
    const autoSearchSwitchWidget = PanelUtils.createSwitch({
      text: 'Autosearch',
      helpText: savedAutoSearch ? 'on' : 'off',
      checked: savedAutoSearch,
      name: 'searchSwitch'
    });

    autoSearchSwitchWidget.addEventListener('widget-change', (evt) => this.#onAutoSearchSwitchChange(evt));
    statusBar.add(autoSearchSwitchWidget, 'left', 10);

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

    this.#pdfViewer.eventBus.on('pagesloaded', () => {
      this.#pdfViewer._pagesLoaded = true;
    });

    updateUi();

    // Restore cursor tool mode
    if (this.#storage.getGlobal('handTool', false)) {
      this.#pdfViewer.setHandToolMode();
      ui.pdfViewer.toolbar.textSelectBtn.setAttribute('variant', 'default');
      ui.pdfViewer.toolbar.handToolBtn.setAttribute('variant', 'primary');
    }
  }

  /**
   * React to state changes
   * @param {string[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) {
    if (changedKeys.includes('pdf')) {
      this.#pdfViewer._pagesLoaded = false;

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
    if (!this.state.xml || !isGoldFile(this.state.xml)) {
      notify('Please load a gold TEI artifact to edit the document ID', 'warning', 'info-circle');
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
      await this.#client.apiClient.filesDocId(this.state.xml, { doc_id: finalDocId });
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
    return new Promise(resolve => {
      if (this.#pdfViewer._pagesLoaded) {
        resolve();
        return;
      }
      const checkInterval = setInterval(() => {
        if (this.#pdfViewer._pagesLoaded) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 5000);
    });
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
    this.#storage.setGlobal('handTool', false);
    ui.pdfViewer.toolbar.textSelectBtn.setAttribute('variant', 'primary');
    ui.pdfViewer.toolbar.handToolBtn.setAttribute('variant', 'default');
  }

  #onSelectHandTool() {
    if (this.#pdfViewer.isHandTool()) return;
    this.#pdfViewer.setHandToolMode();
    this.#storage.setGlobal('handTool', true);
    ui.pdfViewer.toolbar.textSelectBtn.setAttribute('variant', 'default');
    ui.pdfViewer.toolbar.handToolBtn.setAttribute('variant', 'primary');
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
    const pageInfoWidget = ui.pdfViewer.toolbar.pageInfoWidget;
    if (pageInfoWidget) {
      pageInfoWidget.setAttribute('text', `${pageNumber} / ${totalPages}`);
    }
  }

  /**
   * @param {number} scale
   */
  #updateZoomInfo(scale) {
    const zoomInfoWidget = ui.pdfViewer.toolbar.zoomInfoWidget;
    if (zoomInfoWidget) {
      const percentage = Math.round(scale * 100);
      zoomInfoWidget.setAttribute('text', `${percentage}%`);
    }
  }

  /**
   * @param {Event} evt
   */
  async #onAutoSearchSwitchChange(evt) {
    const customEvt = /** @type {CustomEvent} */ (evt);
    const checked = customEvt.detail.checked;
    const autoSearchSwitch = customEvt.detail.widget;

    if (autoSearchSwitch) {
      autoSearchSwitch.setAttribute('help-text', checked ? 'on' : 'off');
    }
    this.#storage.setGlobal('autosearch', checked);

    this.#logger.info(`Auto search is: ${checked}`);
    const xmlEditor = this.getDependency('xmleditor');
    if (checked && xmlEditor.selectedNode) {
      await this.getDependency('services').searchNodeContentsInPdf(xmlEditor.selectedNode);
    }
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
      if (state.page !== undefined) {
        await this.#pdfViewer.goToPage(state.page);
      }
      if (state.scrollX !== undefined || state.scrollY !== undefined) {
        await new Promise(resolve => setTimeout(resolve, 150));
        const container = this.#pdfViewer.pdfViewerContainer;
        if (container) {
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

/** Lazy-proxy API for backward compatibility — exposes PDFJSViewer instance */
export const api = new Proxy({}, {
  get(_, prop) {
    const instance = PdfViewerPlugin.getInstance().getApi();
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  },
  set(_, prop, value) {
    PdfViewerPlugin.getInstance().getApi()[prop] = value;
    return true;
  }
});

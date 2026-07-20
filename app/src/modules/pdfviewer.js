/**
 * A PDF.js viewer API using PDFViewer component
 *
 * Uses the official PDF.js PDFViewer component with built-in UI controls
 * for page navigation, zoom, and search functionality.
 */

import { buildPageModel, findBestMatch } from './pdf-text-matcher.js';

/**
 * @import { MatchResult, PageModel, TextItem } from './pdf-text-matcher.js'
 */

/**
 * PDFJSViewer Class
 *
 * Provides an API for rendering and interacting with PDFs using the PDF.js PDFViewer component,
 * without an iframe. Includes built-in controls and rendering capabilities.
 */
export class PDFJSViewer {

  /**
   * Constructor for the PDFJSViewer class.
   * @param {string} containerDivId - The ID of the container element for the PDF viewer.
   * @throws {Error} If the container element is not found.
   */
  constructor(containerDivId) {
    this.containerDiv = document.getElementById(containerDivId);
    if (!this.containerDiv) {
      throw new Error(`Cannot find element with id ${containerDivId}`);
    }

    // Find status bars (they're already in the HTML)
    this.headerBar = this.containerDiv.querySelector('#pdf-headerbar');
    this.statusBar = this.containerDiv.querySelector('#pdf-statusbar');
    this.toolbar = this.containerDiv.querySelector('#pdf-toolbar');

    // Create main viewer wrapper (contains sidebar + viewer)
    this.viewerWrapper = document.createElement('div');
    this.viewerWrapper.id = 'pdf-viewer-wrapper';
    this.viewerWrapper.className = 'pdf-viewer-wrapper';

    // Create sidebar structure (hidden by default)
    this.sidebarContainer = document.createElement('div');
    this.sidebarContainer.id = 'sidebarContainer';
    this.sidebarContainer.className = 'sidebarContainer';
    this.sidebarContainer.setAttribute('hidden', '');

    this.sidebarContent = document.createElement('div');
    this.sidebarContent.id = 'sidebarContent';
    this.sidebarContent.className = 'sidebarContent';

    this.thumbnailView = document.createElement('div');
    this.thumbnailView.id = 'thumbnailView';
    this.thumbnailView.className = 'thumbnailView';

    this.sidebarContent.appendChild(this.thumbnailView);
    this.sidebarContainer.appendChild(this.sidebarContent);

    // Create viewer structure (required by PDFViewer component)
    this.viewerContainer = document.createElement('div');
    this.viewerContainer.id = 'pdf-viewer-container';

    // Inner container with pdfViewerContainer class (required by PDFViewer)
    this.pdfViewerContainer = document.createElement('div');
    this.pdfViewerContainer.className = 'pdfViewerContainer';

    // Viewer element (required by PDFViewer)
    this.viewer = document.createElement('div');
    this.viewer.className = 'pdfViewer';

    this.pdfViewerContainer.appendChild(this.viewer);
    this.viewerContainer.appendChild(this.pdfViewerContainer);

    // Assemble the structure: sidebar + viewer in wrapper
    this.viewerWrapper.appendChild(this.sidebarContainer);
    this.viewerWrapper.appendChild(this.viewerContainer);

    // Insert wrapper between toolbar and status bar
    if (this.toolbar && this.statusBar) {
      this.containerDiv.insertBefore(this.viewerWrapper, this.statusBar);
    } else {
      this.containerDiv.appendChild(this.viewerWrapper);
    }

    // PDF.js component references
    /** @type {any} */ // pdfjsLib type
    this.pdfjsLib = null;
    /** @type {any} */ // pdfjsViewer namespace
    this.pdfjsViewer = null;
    /** @type {any} */ // PDFViewer component instance
    this.pdfViewer = null;
    /** @type {any} */ // EventBus
    this.eventBus = null;
    /** @type {any} */ // PDFLinkService
    this.linkService = null;
    /** @type {any} */ // PDFFindController
    this.findController = null;
    /** @type {any} */ // PDFSidebar component instance
    this.pdfSidebar = null;
    /** @type {any} */ // PDFThumbnailViewer component instance
    this.pdfThumbnailViewer = null;
    /** @type {any} */ // PDFDocumentProxy
    this.pdfDoc = null;

    // Promises for initialization
    this.initializePromise = null;
    this.isReadyFlag = false;
    this.loadPromise = null;
    this.isLoadedFlag = false;

    // Track active thumbnail render tasks for cancellation
    /** @type {Array<any>} */ // Array of RenderTask objects
    this.thumbnailRenderTasks = [];

    // Cursor tool mode: false = text selection (default), true = hand tool
    this._handToolMode = false;

    // Dragging state for hand tool
    this._isDragging = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._scrollStartX = 0;
    this._scrollStartY = 0;

    // Current match state for re-rendering highlights on zoom/navigation
    /** @type {MatchResult|null} */
    this._highlightMatch = null;

    // Cached page models for the loaded document (built on first search)
    /** @type {PageModel[]|null} */
    this._pageModels = null;
  }

  show() {
    this.containerDiv.style.display = '';
    return this;
  }

  hide() {
    this.containerDiv.style.display = 'none';
    return this;
  }

  /**
   * Checks if the viewer is ready and initializes it if necessary.
   *
   * This method ensures that the PDF.js library and viewer components are loaded.
   *
   * @returns {Promise<PDFJSViewer>} - A promise that resolves with the viewer instance when it is ready.
   */
  async isReady() {
    if (this.isReadyFlag) {
      return this;
    }

    if (!this.initializePromise) {
      this.initializePromise = new Promise(async (resolve, reject) => {
        try {
          console.log("Initializing PDF.js viewer components...");

          // Determine PDF.js path based on environment
          const isDev = document.querySelector('script[type="importmap"]') !== null;
          const pdfjsPath = isDev
            ? '/node_modules/pdfjs-dist/build/pdf.mjs'
            : '/pdfjs/build/pdf.mjs';
          const workerPath = isDev
            ? '/node_modules/pdfjs-dist/build/pdf.worker.mjs'
            : '/pdfjs/build/pdf.worker.mjs';
          const viewerPath = isDev
            ? '/node_modules/pdfjs-dist/web/pdf_viewer.mjs'
            : '/pdfjs/web/pdf_viewer.mjs';

          // Import PDF.js library first and expose it globally
          // (PDFViewer component expects globalThis.pdfjsLib to exist)
          const pdfjsLib = await import(pdfjsPath);
          this.pdfjsLib = pdfjsLib;

          // Expose pdfjsLib globally BEFORE importing viewer components
          if (!globalThis.pdfjsLib) {
            globalThis.pdfjsLib = pdfjsLib;
          }

          // Set worker source
          pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;

          // Now import viewer components (they require globalThis.pdfjsLib)
          const pdfjsViewer = await import(viewerPath);
          this.pdfjsViewer = pdfjsViewer;

          // Create event bus
          this.eventBus = new pdfjsViewer.EventBus();

          // Create link service
          this.linkService = new pdfjsViewer.PDFLinkService({
            eventBus: this.eventBus
          });

          // Create find controller
          this.findController = new pdfjsViewer.PDFFindController({
            eventBus: this.eventBus,
            linkService: this.linkService
          });

          // Create PDFViewer instance
          // Pass the pdfViewerContainer (with absolute positioning) as container
          this.pdfViewer = new pdfjsViewer.PDFViewer({
            container: this.pdfViewerContainer,
            viewer: this.viewer,
            eventBus: this.eventBus,
            linkService: this.linkService,
            findController: this.findController,
            textLayerMode: 1, // Enable text layer (0=disabled, 1=enabled, 2=enabled+respects PDF copy restrictions)
            annotationMode: 2, // Enable annotations (0=disabled, 1=enabled, 2=enabled+forms)
            removePageBorders: false
            // Use default zoom behavior (omit useOnlyCssZoom)
          });

          this.linkService.setViewer(this.pdfViewer);

          // Note: PDFThumbnailViewer and PDFSidebar are not exported from pdf_viewer.mjs
          // We'll implement custom thumbnail rendering instead

          // Listen for page changes
          this.eventBus.on('pagesinit', () => {
            // Use page-width instead of page-fit for better text layer alignment
            this.pdfViewer.currentScaleValue = 'page-width';
          });

          // Re-highlight when text layer is rendered (after zoom or page navigation)
          // The textlayerrendered event fires when PDF.js finishes rendering the text layer,
          // which is the right time to re-apply highlights
          this.eventBus.on('textlayerrendered', (evt) => {
            if (this._highlightMatch && this._highlightMatch.page === evt.pageNumber) {
              this._clearClusterHighlights();
              requestAnimationFrame(() => {
                if (this._highlightMatch) {
                  this._highlightMatchInTextLayer(this._highlightMatch, false);
                }
              });
            }
          });

          // Initialize cursor mode (text selection by default)
          this._updateCursorMode();

          this.isReadyFlag = true;
          console.log(`PDF.js viewer initialized (${isDev ? 'development' : 'production'} mode).`);
          resolve(this);
        } catch (error) {
          console.error("Failed to initialize PDF.js viewer:", error);
          this.isReadyFlag = false;
          reject(error);
        }
      });
    }
    return this.initializePromise;
  }

  /**
   * Asynchronously loads a PDF into the viewer.
   *
   * @param {string} pdfPath - The path to the PDF document.
   * @returns {Promise<void>} - A promise that resolves when the PDF is loaded.
   * @throws {Error} If there is an error loading the PDF.
   */
  async load(pdfPath) {
    if (!pdfPath) {
      throw new Error("No PDF path has been given.");
    }

    await this.isReady();

    if (this.loadPromise) {
      console.log("Already loading PDF, waiting for it to finish...");
      await this.loadPromise;
    }
    this.isLoadedFlag = false;

    // Invalidate per-document caches: a new document invalidates page models
    // and any highlighted match from the previous one
    this._pageModels = null;
    this._highlightMatch = null;

    this.loadPromise = new Promise(async (resolve, reject) => {
      try {
        // Load the PDF document
        const loadingTask = this.pdfjsLib.getDocument(pdfPath);
        this.pdfDoc = await loadingTask.promise;

        console.log(`PDF loaded successfully. Pages: ${this.pdfDoc.numPages}`);

        // Set document in viewer
        this.pdfViewer.setDocument(this.pdfDoc);
        this.linkService.setDocument(this.pdfDoc);

        // Render custom thumbnails in background (don't block load completion)
        this._renderThumbnails().catch(error => {
          console.warn("Failed to render thumbnails:", error);
        });

        this.isLoadedFlag = true;
        resolve(true);
      } catch (error) {
        console.error("Failed to load PDF:", error);
        reject(error);
      }
    });
    await this.loadPromise;
  }

  /**
   * Switches to a specific page in the PDF.
   *
   * @param {number} pageNumber - The page number to switch to (1-based).
   * @throws {Error} If the viewer hasn't been initialized.
   */
  async goToPage(pageNumber) {
    await this.isReady();
    if (!this.pdfDoc) {
      throw new Error("No PDF document loaded");
    }

    if (pageNumber < 1 || pageNumber > this.pdfDoc.numPages) {
      throw new Error(`Invalid page number: ${pageNumber}`);
    }

    this.pdfViewer.currentPageNumber = pageNumber;
  }

  /**
   * Sets the zooming factor of the PDF viewer.
   *
   * @param {number|string} zoomFactor - The desired zoom factor (e.g., 1.0 for 100%, 2.0 for 200%, or 'page-fit').
   * @throws {Error} If the viewer hasn't been initialized.
   */
  async setZoom(zoomFactor) {
    await this.isReady();

    if (typeof zoomFactor === 'string') {
      this.pdfViewer.currentScaleValue = zoomFactor;
    } else {
      this.pdfViewer.currentScale = zoomFactor;
    }
  }

  /**
   * Toggles the sidebar visibility
   */
  toggleSidebar() {
    if (this.sidebarContainer) {
      const isHidden = this.sidebarContainer.hasAttribute('hidden');
      if (isHidden) {
        this.sidebarContainer.removeAttribute('hidden');
      } else {
        this.sidebarContainer.setAttribute('hidden', '');
      }
    }
  }

  /**
   * Opens the sidebar
   */
  openSidebar() {
    if (this.sidebarContainer) {
      this.sidebarContainer.removeAttribute('hidden');
    }
  }

  /**
   * Closes the sidebar
   */
  closeSidebar() {
    if (this.sidebarContainer) {
      this.sidebarContainer.setAttribute('hidden', '');
    }
  }

  /**
   * Toggles the cursor tool mode between hand tool and text selection
   */
  toggleCursorTool() {
    this._handToolMode = !this._handToolMode;
    this._updateCursorMode();
  }

  /**
   * Sets text selection mode
   */
  setTextSelectMode() {
    if (!this._handToolMode) return; // Already in text selection mode
    this._handToolMode = false;
    this._updateCursorMode();
  }

  /**
   * Sets hand tool mode
   */
  setHandToolMode() {
    if (this._handToolMode) return; // Already in hand tool mode
    this._handToolMode = true;
    this._updateCursorMode();
  }

  /**
   * Returns true if hand tool mode is active
   * @returns {boolean}
   */
  isHandTool() {
    return this._handToolMode;
  }

  /**
   * Sets the vertical offset for highlight positioning.
   * Use this to compensate for text layer misalignment with the PDF canvas.
   * Positive values move highlights down, negative values move them up.
   * Use 'auto' to auto-calculate based on line height.
   * @param {number|'auto'} offset - Offset in pixels, or 'auto' for auto-calculation
   */
  setHighlightVerticalOffset(offset) {
    this.highlightVerticalOffset = offset;
  }

  /**
   * Gets the current vertical offset for highlight positioning.
   * @returns {number|'auto'} Current offset in pixels, or 'auto'
   */
  getHighlightVerticalOffset() {
    return this.highlightVerticalOffset;
  }

  /**
   * Updates the cursor mode CSS class on the viewer container
   * @private
   */
  _updateCursorMode() {
    if (this.pdfViewerContainer) {
      if (this._handToolMode) {
        this.pdfViewerContainer.classList.add('hand-tool-mode');
        this.pdfViewerContainer.classList.remove('text-select-mode');
        this._addDragListeners();
      } else {
        this.pdfViewerContainer.classList.add('text-select-mode');
        this.pdfViewerContainer.classList.remove('hand-tool-mode');
        this._removeDragListeners();
      }
    }
  }

  /**
   * Adds mouse event listeners for hand tool dragging
   * @private
   */
  _addDragListeners() {
    if (!this.pdfViewerContainer) return;

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);

    this.pdfViewerContainer.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
  }

  /**
   * Removes mouse event listeners for hand tool dragging
   * @private
   */
  _removeDragListeners() {
    if (!this.pdfViewerContainer) return;

    this.pdfViewerContainer.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
  }

  /**
   * Handle mouse down for drag start
   * @param {MouseEvent} e
   * @private
   */
  _onMouseDown(e) {
    if (!this._handToolMode) return;

    this._isDragging = true;
    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;
    this._scrollStartX = this.pdfViewerContainer.scrollLeft;
    this._scrollStartY = this.pdfViewerContainer.scrollTop;

    e.preventDefault();
  }

  /**
   * Handle mouse move for dragging
   * @param {MouseEvent} e
   * @private
   */
  _onMouseMove(e) {
    if (!this._isDragging || !this._handToolMode) return;

    const deltaX = e.clientX - this._dragStartX;
    const deltaY = e.clientY - this._dragStartY;

    this.pdfViewerContainer.scrollLeft = this._scrollStartX - deltaX;
    this.pdfViewerContainer.scrollTop = this._scrollStartY - deltaY;

    e.preventDefault();
  }

  /**
   * Handle mouse up for drag end
   * @param {MouseEvent} e
   * @private
   */
  _onMouseUp(e) {
    if (!this._handToolMode) return;

    this._isDragging = false;
    e.preventDefault();
  }

  /**
   * Properly closes the current PDF document
   * @returns {Promise<void>}
   */
  async close() {
    await this.isReady();

    // Cancel any active thumbnail render tasks
    this._cancelThumbnailRendering();

    if (this.pdfDoc) {
      await this.pdfDoc.destroy();
      this.pdfDoc = null;
      this._pageModels = null;
      this._highlightMatch = null;
      this.pdfViewer.setDocument(null);
      this.linkService.setDocument(null);
      this.isLoadedFlag = false;
      this.loadPromise = null;

      // Clear thumbnails
      this.thumbnailView.innerHTML = '';
    }
  }

  /**
   * Resets the viewer to empty state
   * @returns {Promise<void>}
   */
  async reset() {
    await this.close();
  }

  /**
   * Clears the viewer completely
   * @returns {Promise<void>}
   */
  async clear() {
    await this.close();
    this._highlightMatch = null;
    this._pageModels = null;
  }

  /**
   * Searches the loaded PDF for the region best matching the given text
   * and highlights it. Page models are built once per document and cached.
   *
   * @param {string} queryText - Ordered text of the selected TEI node
   * @param {Object} [options={}] - Search options
   * @param {number} [options.threshold=0.6] - Minimum similarity score in [0,1]
   * @returns {Promise<MatchResult|null>} The match, or null if none scored
   *   above the threshold
   */
  async search(queryText, options = {}) {
    const { threshold = 0.6 } = options;

    if (!queryText || !queryText.trim()) {
      console.warn("No search text provided.");
      return null;
    }

    if (!this.isLoadedFlag) {
      await this.isReady();
      if (!this.loadPromise) {
        throw new Error("PDF document not loaded. Call load() first.");
      }
      await this.loadPromise;
    }

    const pageModels = await this._getPageModels();
    const { match, candidates } = findBestMatch(pageModels, queryText, { threshold });
    console.log("PDF text match candidates:", candidates);

    if (!match) {
      this._highlightMatch = null;
      this._clearClusterHighlights();
      return null;
    }

    this._highlightMatch = match;
    await this.goToPage(match.page);

    // If the text layer already exists (cached page), highlight directly;
    // otherwise the textlayerrendered handler will do it
    const pageDiv = this.viewer.querySelector(`.page[data-page-number="${match.page}"]`);
    if (pageDiv?.querySelector('.textLayer')) {
      this._highlightMatchInTextLayer(match, true);
    }
    return match;
  }

  /**
   * Builds (and caches) matcher page models for the loaded document.
   * @returns {Promise<PageModel[]>}
   * @private
   */
  async _getPageModels() {
    if (this._pageModels) {
      return this._pageModels;
    }
    const models = [];
    for (let pageNum = 1; pageNum <= this.pdfDoc.numPages; pageNum++) {
      const page = await this.pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      models.push(buildPageModel(textContent.items, pageNum));
    }
    this._pageModels = models;
    return models;
  }

  /**
   * Highlights the spans of a match in the page's text layer.
   * @param {MatchResult} match - The match to highlight
   * @param {boolean} [scrollIntoView=true] - Whether to scroll to the highlight
   * @private
   */
  _highlightMatchInTextLayer(match, scrollIntoView = true) {
    this._clearClusterHighlights();

    const pageDiv = this.viewer.querySelector(`.page[data-page-number="${match.page}"]`);
    const textLayer = pageDiv?.querySelector('.textLayer');
    if (!textLayer) {
      console.warn(`Text layer not found for page ${match.page}`);
      return;
    }

    const model = this._pageModels?.[match.page - 1];
    if (!model) return;

    const spans = this._mapItemsToSpans(textLayer, model.items, match.itemIndices);
    if (spans.length === 0) {
      console.warn("Could not map matched items to text layer spans");
      return;
    }

    // Convert span positions to text-layer-relative coordinates,
    // compensating for the CSS transform scale on the text layer
    const textLayerRect = textLayer.getBoundingClientRect();
    const transform = window.getComputedStyle(textLayer).transform;
    let scale = 1;
    if (transform && transform !== 'none') {
      const matrixMatch = transform.match(/matrix\(([^,]+)/);
      if (matrixMatch) {
        scale = parseFloat(matrixMatch[1]) || 1;
      }
    }

    const cluster = spans.map(span => {
      const r = span.getBoundingClientRect();
      return {
        span,
        rect: {
          left: (r.left - textLayerRect.left) / scale,
          top: (r.top - textLayerRect.top) / scale,
          right: (r.right - textLayerRect.left) / scale,
          bottom: (r.bottom - textLayerRect.top) / scale,
          width: r.width / scale,
          height: r.height / scale
        }
      };
    });

    this._createClusterHighlight(textLayer, cluster, scrollIntoView);
  }

  /**
   * Maps matched text-content item indices to text layer span elements.
   * PDF.js renders one span per text content item in item order; this walks
   * both sequences in lockstep with a small lookahead for resynchronization,
   * and falls back to exact-text search if the correspondence drifts.
   *
   * Known gap: the exact-text fallback only triggers when the lockstep walk
   * finds *none* of the wanted spans (`result.length === 0`). If it resyncs
   * but drifts outside the 3-span lookahead partway through (missing some
   * wanted spans, not all), those are silently skipped and the highlight is
   * drawn from a subset — a partial box rather than a wrong one, with no
   * logging. Not yet observed on the tests/pdf-match/ gold set; harden if a
   * real document shows a ragged highlight.
   * @param {HTMLElement} textLayer - The page's text layer element
   * @param {TextItem[]} items - Page model items
   * @param {number[]} itemIndices - Indices of the matched items
   * @returns {HTMLElement[]} The corresponding span elements
   * @private
   */
  _mapItemsToSpans(textLayer, items, itemIndices) {
    const spans = Array.from(textLayer.querySelectorAll('span'));
    const wanted = new Set(itemIndices);
    const result = [];
    let s = 0;
    for (let i = 0; i < items.length; i++) {
      let found = -1;
      for (let j = s; j < Math.min(s + 3, spans.length); j++) {
        if (spans[j].textContent === items[i].str) {
          found = j;
          break;
        }
      }
      if (found === -1) continue;
      if (wanted.has(i)) result.push(spans[found]);
      s = found + 1;
    }
    // Fallback: lockstep failed entirely - find spans by exact text
    if (result.length === 0) {
      for (const i of itemIndices) {
        const str = items[i].str;
        if (!str.trim()) continue;
        const span = spans.find(sp => sp.textContent === str);
        if (span) result.push(span);
      }
    }
    return result;
  }

  /**
   * Clears any existing match highlight overlays
   * @param {boolean} clearState - Also clear the stored match state (default: false)
   * @private
   */
  _clearClusterHighlights(clearState = false) {
    const highlights = this.viewer.querySelectorAll('.cluster-highlight, .span-highlight');
    highlights.forEach(highlight => highlight.remove());

    if (clearState) {
      this._highlightMatch = null;
    }
  }



  /**
   * Vertical offset (in pixels) to compensate for text layer misalignment.
   * Positive values move the highlight down, negative values move it up.
   * Set to 'auto' to auto-calculate based on line height.
   * @type {number|'auto'}
   */
  highlightVerticalOffset = 0;

  /**
   * Calculates the average line height from text layer spans.
   * Used for auto-offset calculation.
   * @param {HTMLElement} textLayer - The text layer element
   * @returns {number} Average line height in pixels
   * @private
   */
  _calculateLineHeight(textLayer) {
    const spans = textLayer.querySelectorAll('span');
    if (spans.length === 0) return 12; // Default fallback

    // Sample up to 10 spans to get average line height
    const sampleSize = Math.min(10, spans.length);
    let totalHeight = 0;

    for (let i = 0; i < sampleSize; i++) {
      const span = spans[i];
      const computedStyle = window.getComputedStyle(span);
      const lineHeight = parseFloat(computedStyle.lineHeight) || parseFloat(computedStyle.fontSize) || 12;
      totalHeight += lineHeight;
    }

    return totalHeight / sampleSize;
  }

  /**
   * Creates highlight overlays for each matched span in a cluster,
   * plus a dashed boundary around the entire cluster.
   * @param {HTMLElement} textLayer - The text layer element
   * @param {Array<{span: HTMLElement, rect: Object, score: number}>} cluster - The cluster to highlight
   * @param {boolean} scrollIntoView - Whether to scroll the highlight into view (default: true)
   * @private
   */
  _createClusterHighlight(textLayer, cluster, scrollIntoView = true) {
    if (cluster.length === 0) return;

    // Calculate vertical offset to compensate for text layer misalignment
    let verticalOffset = this.highlightVerticalOffset;
    if (verticalOffset === 'auto') {
      verticalOffset = this._calculateLineHeight(textLayer);
    }

    // Highlight each matched span individually
    for (const item of cluster) {
      const spanHL = document.createElement('div');
      spanHL.className = 'span-highlight';
      spanHL.style.left = `${item.rect.left}px`;
      spanHL.style.top = `${item.rect.top + verticalOffset}px`;
      spanHL.style.width = `${item.rect.width}px`;
      spanHL.style.height = `${item.rect.height}px`;
      textLayer.appendChild(spanHL);
    }

    // Calculate cluster bounding box
    let minLeft = Infinity, minTop = Infinity;
    let maxRight = -Infinity, maxBottom = -Infinity;

    for (const item of cluster) {
      minLeft = Math.min(minLeft, item.rect.left);
      minTop = Math.min(minTop, item.rect.top);
      maxRight = Math.max(maxRight, item.rect.right);
      maxBottom = Math.max(maxBottom, item.rect.bottom);
    }

    const padding = 3;
    const boundary = document.createElement('div');
    boundary.className = 'cluster-highlight';
    boundary.style.left = `${minLeft - padding}px`;
    boundary.style.top = `${minTop - padding + verticalOffset}px`;
    boundary.style.width = `${maxRight - minLeft + padding * 2}px`;
    boundary.style.height = `${maxBottom - minTop + padding * 2}px`;
    textLayer.appendChild(boundary);

    if (scrollIntoView) {
      boundary.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  }

  /**
   * Cancels all active thumbnail render tasks
   * @private
   */
  _cancelThumbnailRendering() {
    for (const renderTask of this.thumbnailRenderTasks) {
      try {
        renderTask.cancel();
      } catch (error) {
        // Ignore errors from cancelling already-completed tasks
      }
    }
    this.thumbnailRenderTasks = [];
  }

  /**
   * Renders thumbnails for all pages in the sidebar
   * @returns {Promise<void>}
   * @private
   */
  async _renderThumbnails() {
    if (!this.pdfDoc || !this.thumbnailView) {
      return;
    }

    // Cancel any existing thumbnail rendering
    this._cancelThumbnailRendering();

    // Clear existing thumbnails
    this.thumbnailView.innerHTML = '';

    const numPages = this.pdfDoc.numPages;
    const thumbnailWidth = 160; // Fixed thumbnail width

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await this.pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });

      // Calculate scale to fit thumbnail width
      const scale = thumbnailWidth / viewport.width;
      const thumbnailViewport = page.getViewport({ scale });

      // Create thumbnail container
      const thumbnailContainer = document.createElement('div');
      thumbnailContainer.className = 'thumbnail';
      thumbnailContainer.dataset.pageNumber = pageNum;

      // Create canvas for thumbnail
      const canvas = document.createElement('canvas');
      canvas.width = thumbnailViewport.width;
      canvas.height = thumbnailViewport.height;

      const context = canvas.getContext('2d');
      const renderContext = {
        canvasContext: context,
        viewport: thumbnailViewport
      };

      // Render page to canvas and track the render task
      const renderTask = page.render(renderContext);
      this.thumbnailRenderTasks.push(renderTask);

      try {
        await renderTask.promise;
      } catch (error) {
        // Ignore RenderingCancelledException (expected when switching documents)
        if (error.name !== 'RenderingCancelledException') {
          console.error(`Failed to render thumbnail for page ${pageNum}:`, error);
        }
        // Stop rendering remaining thumbnails if this one was cancelled
        if (error.name === 'RenderingCancelledException') {
          break;
        }
      }

      // Remove completed task from tracking array
      const taskIndex = this.thumbnailRenderTasks.indexOf(renderTask);
      if (taskIndex !== -1) {
        this.thumbnailRenderTasks.splice(taskIndex, 1);
      }

      // Add page number label
      const label = document.createElement('div');
      label.className = 'thumbnail-label';
      label.textContent = `Page ${pageNum}`;

      thumbnailContainer.appendChild(canvas);
      thumbnailContainer.appendChild(label);

      // Click handler to navigate to page
      thumbnailContainer.addEventListener('click', () => {
        this.goToPage(pageNum);
      });

      this.thumbnailView.appendChild(thumbnailContainer);
    }
  }
}

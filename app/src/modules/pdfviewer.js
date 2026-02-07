/**
 * A PDF.js viewer API using PDFViewer component
 *
 * Uses the official PDF.js PDFViewer component with built-in UI controls
 * for page navigation, zoom, and search functionality.
 */

import * as pdfTextSearch from './pdf-text-search.js';

/**
 * PDFJSViewer Class
 *
 * Provides an API for rendering and interacting with PDFs using the PDF.js PDFViewer component,
 * without an iframe. Includes built-in controls and rendering capabilities.
 */
export class PDFJSViewer {

  /**
   * An array of {page, positions, matchIndexes} objects with the best matches to the last search()
   * @type {Array<{page: number, positions: number[], matchIndexes: number[]}>}
   */
  bestMatches = [];

  /**
   * The index of the currently highlighted best match
   * @type {number}
   */
  matchIndex = 0;

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

    // Current highlight state for re-rendering on zoom
    /** @type {string[]|null} */
    this._highlightTerms = null;
    /** @type {number|null} */
    this._highlightPageNumber = null;

    // Track last successful match page for efficient searching
    /** @type {number} */
    this._lastMatchPage = 1;
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
            textLayerMode: 2, // Enable text layer (0=disabled, 1=enabled, 2=enabled+enhanced)
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
            const pageNumber = evt.pageNumber;
            // Only re-highlight if this is the page we had highlights on
            if (this._highlightTerms && this._highlightPageNumber === pageNumber) {
              // Re-highlight without scrolling (user is already looking at the area)
              this._highlightTermsInTextLayer(this._highlightTerms, this._highlightPageNumber, 5, false);
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
    this.bestMatches = [];
    this.matchIndex = 0;
    this._highlightTerms = null;
    this._highlightPageNumber = null;
  }

  /**
   * Searches for a string within the PDF document.
   *
   * @param {Array<string>|string} query - The search terms, either as a string or an array of strings.
   * @param {object} [options={}] - Search options
   * @param {boolean} [options.phraseSearch=false] - Whether to search for exact phrases
   * @param {boolean} [options.caseSensitive=false] - Whether the search is case sensitive
   * @param {boolean} [options.entireWord=true] - Whether to match entire words only
   * @param {boolean} [options.highlightAll=true] - Whether to highlight all matches
   * @returns {Promise<Array<{pageIndex: number, matchIndex: number}>>} - Array of match locations
   */
  async search(query, options = {}) {
    if (!query || query.length === 0) {
      console.warn("No search terms provided.");
      return [];
    }

    if (!this.isLoadedFlag) {
      await this.isReady();
      if (!this.loadPromise) {
        throw new Error("PDF document not loaded. Call load() first.");
      }
      console.log("Waiting for PDF document to load...");
      await this.loadPromise;
    }

    if (!Array.isArray(query)) {
      query = [query];
    }

    if (query.length > 20) {
      console.warn("Query too big, reducing to 20 entries");
      query = query.slice(0, 20);
    }

    console.log("Searching for", query.map(q => `'${q}'`).join(", "), "...");

    // Note: Don't call _clearHighlights() here - it interferes with the find controller

    const defaultOptions = {
      phraseSearch: false,
      caseSensitive: false,
      entireWord: true,
      highlightAll: true
    };

    options = Object.assign(defaultOptions, options);

    // Extract text from all pages and search
    const pageMatches = await this._searchAllPages(query, options);

    // Calculate best matches using density clustering
    const bestMatches = this._getBestMatches(query, pageMatches);
    console.log(`Found ${bestMatches.length} best matches.`);

    this.bestMatches = bestMatches;

    if (bestMatches.length > 0) {
      await this.scrollToBestMatch(0);

      // Use custom highlighting for multi-term search on the best match page only
      // PDF.js findController only works for single phrase search
      const pageNumber = bestMatches[0].page;
      this._lastMatchPage = pageNumber;
      this._highlightTermsInTextLayer(query, pageNumber);
    }

    return [];
  }

  /**
   * Searches all pages for the given query terms
   * @param {string[]} query - Array of search terms
   * @param {object} options - Search options
   * @returns {Promise<number[][]>} - Array of arrays, where each inner array contains match positions for a page
   * @private
   */
  async _searchAllPages(query, options) {
    const pageMatches = [];

    for (let pageNum = 1; pageNum <= this.pdfDoc.numPages; pageNum++) {
      const textContent = await this._getPageText(pageNum);
      const matches = this._findMatchesInText(textContent, query, options);
      pageMatches.push(matches);
    }

    return pageMatches;
  }

  /**
   * Gets text content for a page
   * @param {number} pageNum - Page number (1-based)
   * @returns {Promise<string>} - Page text content
   * @private
   */
  async _getPageText(pageNum) {
    const page = await this.pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const text = textContent.items.map(item => item.str).join(' ');
    return text;
  }

  /**
   * Finds matches in text content
   * @param {string} text - Text to search in
   * @param {string[]} query - Search terms
   * @param {object} options - Search options
   * @returns {number[]} - Array of match positions (character offsets)
   * @private
   */
  _findMatchesInText(text, query, options) {
    const matches = [];

    for (const term of query) {
      let searchText = text;
      let searchTerm = term;

      if (!options.caseSensitive) {
        searchText = text.toLowerCase();
        searchTerm = term.toLowerCase();
      }

      let index = 0;
      while ((index = searchText.indexOf(searchTerm, index)) !== -1) {
        // Check for whole word match if required
        if (options.entireWord) {
          const before = index > 0 ? searchText[index - 1] : ' ';
          const after = index + searchTerm.length < searchText.length
            ? searchText[index + searchTerm.length]
            : ' ';

          if (/\w/.test(before) || /\w/.test(after)) {
            index++;
            continue;
          }
        }

        matches.push(index);
        index += searchTerm.length;
      }
    }

    return matches.sort((a, b) => a - b);
  }

  /**
   * Scrolls to the best match with the given index.
   * @param {number} index - The index of the best match found, defaults to 0
   * @returns {Promise<boolean>}
   */
  async scrollToBestMatch(index = 0) {
    if (this.bestMatches.length === 0) {
      throw new Error("No best matches - do a search first");
    }

    if (index < 0 || index >= this.bestMatches.length) {
      throw new Error(`Index out of bounds: ${index} of ${this.bestMatches.length}`);
    }

    const match = this.bestMatches[index];
    const pageNumber = match.page;

    // Navigate to the page with the match
    await this.goToPage(pageNumber);

    this.matchIndex = index;
    return true;
  }

  /**
   * Selects the best matches from search results by comparing
   * the density of clustered search terms.
   * @param {string[]} searchTerms - The query search terms
   * @param {number[][]} pageMatches - Array of match positions per page
   * @returns {Array<{page: number, positions: number[], matchIndexes: number[]}>} - Array of best match objects
   * @private
   */
  _getBestMatches(searchTerms, pageMatches) {
    const minNumMatches = Math.max(Math.round(searchTerms.length * 0.8), 3);

    const candidates = pageMatches.map((positions, idx) => ({
      page: idx + 1,
      positions
    }));

    const bestMatches = candidates.filter(match => match.positions.length >= minNumMatches);

    if (bestMatches.length === 0) {
      console.warn("No best match found.");
      console.log({ pageMatches, minNumMatches, candidates });
      return [];
    }

    /**
     * Returns the cluster of values which are most densely spread
     * @param {number[]} arr - Array of numbers
     * @param {number} windowSize - Size of the sliding window
     * @returns {number[]} - The densest cluster
     */
    function findDensestCluster(arr, windowSize) {
      let minDiff = Infinity;
      let minCluster = [];
      for (let i = 0; i <= arr.length - windowSize; i++) {
        const _window = arr.slice(i, i + windowSize);
        const diff = _window[_window.length - 1] - _window[0];
        if (diff < minDiff) {
          minDiff = diff;
          minCluster = _window;
        }
      }
      return minCluster;
    }

    bestMatches.sort((a, b) => {
      return (
        findDensestCluster(b.positions, minNumMatches).length -
        findDensestCluster(a.positions, minNumMatches).length
      );
    });

    return bestMatches.map(match => {
      const cluster = findDensestCluster(match.positions, minNumMatches);
      match.matchIndexes = cluster.map(position => match.positions.indexOf(position));
      match.positions = cluster;
      return match;
    }).filter(match => match.positions.length > 0);
  }

  /**
   * Clears any existing cluster highlight overlays
   * @param {boolean} clearState - Also clear the highlight state (default: false)
   * @private
   */
  _clearClusterHighlights(clearState = false) {
    const highlights = this.viewer.querySelectorAll('.cluster-highlight');
    highlights.forEach(highlight => highlight.remove());

    // Clear debug styles from matched spans
    const debugSpans = this.viewer.querySelectorAll('.debug-matched-span');
    debugSpans.forEach(span => {
      span.style.outline = '';
      span.style.backgroundColor = '';
      span.classList.remove('debug-matched-span');
    });

    if (clearState) {
      this._highlightTerms = null;
      this._highlightPageNumber = null;
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
   * Creates a highlight overlay for a cluster of spans
   * @param {HTMLElement} textLayer - The text layer element
   * @param {Array<{span: HTMLElement, rect: Object, score: number}>} cluster - The cluster to highlight
   * @param {boolean} scrollIntoView - Whether to scroll the highlight into view (default: true)
   * @private
   */
  _createClusterHighlight(textLayer, cluster, scrollIntoView = true) {
    if (cluster.length === 0) return;

    // DEBUG: Highlight each matched span with a red border
    for (const item of cluster) {
      item.span.style.outline = '2px solid red';
      item.span.style.backgroundColor = 'rgba(255, 0, 0, 0.2)';
      item.span.classList.add('debug-matched-span');
    }

    // Calculate bounding box for the cluster
    let minLeft = Infinity, minTop = Infinity;
    let maxRight = -Infinity, maxBottom = -Infinity;

    for (const item of cluster) {
      minLeft = Math.min(minLeft, item.rect.left);
      minTop = Math.min(minTop, item.rect.top);
      maxRight = Math.max(maxRight, item.rect.right);
      maxBottom = Math.max(maxBottom, item.rect.bottom);
    }

    // Add padding
    const padding = 5;
    minLeft = Math.max(0, minLeft - padding);
    minTop = Math.max(0, minTop - padding);
    maxRight += padding;
    maxBottom += padding;

    // Calculate vertical offset to compensate for text layer misalignment
    let verticalOffset = this.highlightVerticalOffset;
    if (verticalOffset === 'auto') {
      // Auto-calculate: use one line height as offset (common misalignment pattern)
      verticalOffset = this._calculateLineHeight(textLayer);
    }
    minTop += verticalOffset;
    maxBottom += verticalOffset;

    // Create highlight overlay
    const highlight = document.createElement('div');
    highlight.className = 'cluster-highlight';
    highlight.style.left = `${minLeft}px`;
    highlight.style.top = `${minTop}px`;
    highlight.style.width = `${maxRight - minLeft}px`;
    highlight.style.height = `${maxBottom - minTop}px`;

    textLayer.appendChild(highlight);

    // Scroll the highlight into view (unless disabled, e.g., during zoom re-render)
    if (scrollIntoView) {
      highlight.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  }

  /**
   * Highlights search terms by finding the densest spatial cluster on the page
   * and drawing a bounding box around it. Uses the pdf-text-search module
   * for span-to-term matching which handles hyphenation and OCR fragmentation.
   * @param {string[]} terms - Array of search terms to highlight
   * @param {number} pageNumber - The page number to highlight (1-based)
   * @param {number} minClusterSize - Minimum number of matching spans required (default: 5)
   * @param {boolean} scrollIntoView - Whether to scroll the highlight into view (default: true)
   * @private
   */
  _highlightTermsInTextLayer(terms, pageNumber, minClusterSize = 5, scrollIntoView = true) {
    // Clear previous highlights
    this._clearClusterHighlights();

    // Store state for re-highlighting on zoom change
    this._highlightTerms = terms;
    this._highlightPageNumber = pageNumber;

    if (!terms || terms.length === 0) return;

    // Find the specific page's text layer
    const page = this.viewer.querySelector(`.page[data-page-number="${pageNumber}"]`);
    if (!page) {
      console.warn(`Page ${pageNumber} not found in viewer`);
      return;
    }

    const textLayer = page.querySelector('.textLayer');
    if (!textLayer) {
      console.warn(`Text layer not found for page ${pageNumber}`);
      return;
    }

    // Use the pdf-text-search module to find the best cluster
    const cluster = pdfTextSearch.findBestCluster(textLayer, terms, { minClusterSize });

    if (!cluster) {
      console.log(`No suitable cluster found on page ${pageNumber}`);
      return;
    }

    console.log(`Highlighting cluster: ${cluster.spans.length} spans, score ${cluster.totalScore}, ${Math.round(cluster.bounds.height)}px height on page ${pageNumber}`);

    this._createClusterHighlight(textLayer, cluster.spans, scrollIntoView);
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

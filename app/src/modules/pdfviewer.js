/**
 * A PDF.js viewer API using PDFViewer component
 *
 * Uses the official PDF.js PDFViewer component with built-in UI controls
 * for page navigation, zoom, and search functionality.
 */

/**
 * Text layer scale adjustment to compensate for alignment issues.
 * Adjust this value if the text selection doesn't align with visible text.
 * Values < 1.0 shrink the text layer, values > 1.0 enlarge it.
 * @type {number}
 */
const TEXT_LAYER_SCALE_ADJUSTMENT = 0.97;

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

          // Apply text layer scale adjustment via CSS custom property
          this.pdfViewerContainer.style.setProperty('--text-layer-scale', TEXT_LAYER_SCALE_ADJUSTMENT);

          // Listen for page changes
          this.eventBus.on('pagesinit', () => {
            // Use page-width instead of page-fit for better text layer alignment
            this.pdfViewer.currentScaleValue = 'page-width';
          });

          // Re-highlight when scale changes (zoom in/out)
          this.eventBus.on('scalechanging', () => {
            // Debounce: wait for scale change to settle, then re-highlight
            if (this._scaleChangeTimeout) {
              clearTimeout(this._scaleChangeTimeout);
            }
            this._scaleChangeTimeout = setTimeout(() => {
              if (this._highlightTerms && this._highlightPageNumber) {
                // Re-highlight without scrolling (user is already looking at the area)
                this._highlightTermsInTextLayer(this._highlightTerms, this._highlightPageNumber, 5, false);
              }
            }, 100);
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
    if (clearState) {
      this._highlightTerms = null;
      this._highlightPageNumber = null;
    }
  }

  /**
   * Finds all spans in the text layer that contain any of the search terms
   * @param {HTMLElement} textLayer - The text layer element
   * @param {string[]} terms - Array of search terms
   * @returns {Array<{span: HTMLElement, rect: DOMRect, matchCount: number}>}
   * @private
   */
  _findMatchingSpans(textLayer, terms) {
    // Filter out terms that are too short or too generic
    // - Keep terms with 4+ characters
    // - Keep 4-digit numbers (years like 1927)
    // - Filter out short numbers (page refs like "5", "65") as they match everywhere
    const filteredTerms = terms.filter(term => {
      if (/^\d+$/.test(term)) {
        // For pure numbers, only keep 4-digit years
        return term.length === 4;
      }
      // For text, require at least 4 characters
      return term.length >= 4;
    });

    if (filteredTerms.length === 0) {
      console.warn('No valid search terms after filtering');
      return [];
    }

    console.log('DEBUG: Filtered terms:', filteredTerms);

    const escapedTerms = filteredTerms.map(term =>
      term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
    const textLayerRect = textLayer.getBoundingClientRect();
    const matches = [];

    const spans = textLayer.querySelectorAll('span');
    spans.forEach(span => {
      const text = span.textContent || '';
      const spanMatches = text.match(regex);
      if (spanMatches && spanMatches.length > 0) {
        const spanRect = span.getBoundingClientRect();
        // Convert to coordinates relative to text layer
        matches.push({
          span,
          text: text.substring(0, 50), // For debugging
          matched: spanMatches,
          rect: {
            left: spanRect.left - textLayerRect.left,
            top: spanRect.top - textLayerRect.top,
            right: spanRect.right - textLayerRect.left,
            bottom: spanRect.bottom - textLayerRect.top,
            width: spanRect.width,
            height: spanRect.height
          },
          matchCount: spanMatches.length
        });
      }
    });

    // Debug: log matched spans
    console.log('DEBUG: Matched spans:', matches.map(m => ({ text: m.text, matched: m.matched, y: Math.round(m.rect.top) })));

    return matches;
  }

  /**
   * Clusters matching spans by spatial proximity using union-find
   * Uses separate horizontal and vertical thresholds since text flows horizontally
   * @param {Array<{span: HTMLElement, rect: Object, matchCount: number}>} matchingSpans
   * @param {number} verticalThreshold - Max vertical distance (pixels) - very tight for same/adjacent lines
   * @param {number} horizontalThreshold - Max horizontal distance (pixels) - tight for nearby text
   * @returns {Array<Array<{span: HTMLElement, rect: Object, matchCount: number}>>} - Array of clusters
   * @private
   */
  _clusterSpansByProximity(matchingSpans, verticalThreshold = 14, horizontalThreshold = 60) {
    if (matchingSpans.length === 0) return [];

    // Calculate center points for each span
    const centers = matchingSpans.map(m => ({
      x: m.rect.left + m.rect.width / 2,
      y: m.rect.top + m.rect.height / 2
    }));

    // Union-Find data structure
    const parent = matchingSpans.map((_, i) => i);
    const rank = matchingSpans.map(() => 0);

    const find = (i) => {
      if (parent[i] !== i) {
        parent[i] = find(parent[i]);
      }
      return parent[i];
    };

    const union = (i, j) => {
      const pi = find(i);
      const pj = find(j);
      if (pi === pj) return;
      if (rank[pi] < rank[pj]) {
        parent[pi] = pj;
      } else if (rank[pi] > rank[pj]) {
        parent[pj] = pi;
      } else {
        parent[pj] = pi;
        rank[pi]++;
      }
    };

    // Build clusters by connecting nearby spans
    // Two spans are neighbors if within BOTH vertical and horizontal thresholds
    for (let i = 0; i < matchingSpans.length; i++) {
      for (let j = i + 1; j < matchingSpans.length; j++) {
        const dx = Math.abs(centers[i].x - centers[j].x);
        const dy = Math.abs(centers[i].y - centers[j].y);
        // Must be close in both dimensions
        if (dy <= verticalThreshold && dx <= horizontalThreshold) {
          union(i, j);
        }
      }
    }

    // Group spans by their root parent
    const clusterMap = new Map();
    for (let i = 0; i < matchingSpans.length; i++) {
      const root = find(i);
      if (!clusterMap.has(root)) {
        clusterMap.set(root, []);
      }
      clusterMap.get(root).push(matchingSpans[i]);
    }

    // Convert to array and sort by match density (matches per area)
    const clusters = Array.from(clusterMap.values());
    clusters.sort((a, b) => {
      // Calculate bounding box area for each cluster
      const getArea = (cluster) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const item of cluster) {
          minX = Math.min(minX, item.rect.left);
          minY = Math.min(minY, item.rect.top);
          maxX = Math.max(maxX, item.rect.right);
          maxY = Math.max(maxY, item.rect.bottom);
        }
        return (maxX - minX) * (maxY - minY);
      };
      const countA = a.reduce((sum, m) => sum + m.matchCount, 0);
      const countB = b.reduce((sum, m) => sum + m.matchCount, 0);
      const densityA = countA / Math.max(1, getArea(a));
      const densityB = countB / Math.max(1, getArea(b));
      // Prefer higher density, then more matches
      if (Math.abs(densityA - densityB) > 0.0001) {
        return densityB - densityA;
      }
      return countB - countA;
    });

    return clusters;
  }

  /**
   * Creates a highlight overlay for a cluster of spans
   * @param {HTMLElement} textLayer - The text layer element
   * @param {Array<{span: HTMLElement, rect: Object, matchCount: number}>} cluster - The cluster to highlight
   * @param {boolean} scrollIntoView - Whether to scroll the highlight into view (default: true)
   * @private
   */
  _createClusterHighlight(textLayer, cluster, scrollIntoView = true) {
    if (cluster.length === 0) return;

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
   * and drawing a bounding box around it
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

    // Find all spans containing search terms
    const matchingSpans = this._findMatchingSpans(textLayer, terms);
    if (matchingSpans.length === 0) {
      console.log(`No matching spans found on page ${pageNumber}`);
      return;
    }

    // Cluster spans by spatial proximity (tight thresholds for compact citations)
    const clusters = this._clusterSpansByProximity(matchingSpans);

    // Helper to calculate cluster bounding box dimensions
    const getClusterBounds = (cluster) => {
      let minY = Infinity, maxY = -Infinity;
      let minX = Infinity, maxX = -Infinity;
      for (const item of cluster) {
        minY = Math.min(minY, item.rect.top);
        maxY = Math.max(maxY, item.rect.bottom);
        minX = Math.min(minX, item.rect.left);
        maxX = Math.max(maxX, item.rect.right);
      }
      return { height: maxY - minY, width: maxX - minX };
    };

    // Filter clusters: must have minClusterSize spans and reasonable bounding box
    // Citations typically don't span more than ~70px vertically (3-4 lines)
    const maxHeight = 70;
    const validClusters = clusters.filter(c => {
      if (c.length < minClusterSize) return false;
      const bounds = getClusterBounds(c);
      return bounds.height <= maxHeight;
    });

    if (validClusters.length === 0) {
      // Fall back: try clusters that are too tall but still reasonably sized
      const fallbackClusters = clusters.filter(c => {
        if (c.length < 3) return false;
        const bounds = getClusterBounds(c);
        return bounds.height <= maxHeight * 1.5; // Allow 50% more height for fallback
      });

      if (fallbackClusters.length > 0) {
        const fallback = fallbackClusters[0];
        console.log(`Using fallback cluster with ${fallback.length} spans`);
        this._createClusterHighlight(textLayer, fallback, scrollIntoView);
      } else if (clusters.length > 0 && clusters[0].length >= 3) {
        console.log(`No compact cluster found, using best available with ${clusters[0].length} spans`);
        this._createClusterHighlight(textLayer, clusters[0], scrollIntoView);
      } else {
        console.log(`No suitable cluster found on page ${pageNumber}`);
      }
      return;
    }

    // Use the best valid cluster (already sorted by density)
    const bestCluster = validClusters[0];
    const totalMatches = bestCluster.reduce((sum, m) => sum + m.matchCount, 0);
    const bounds = getClusterBounds(bestCluster);
    console.log(`Highlighting cluster: ${bestCluster.length} spans, ${totalMatches} matches, ${Math.round(bounds.height)}px height on page ${pageNumber}`);
    console.log('DEBUG: Cluster contents:', bestCluster.map(m => ({ text: m.text, matched: m.matched })));

    this._createClusterHighlight(textLayer, bestCluster, scrollIntoView);
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

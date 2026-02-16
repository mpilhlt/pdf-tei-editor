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
   * An array of best matching pages from the last search(), sorted by score
   * @type {Array<{page: number, matchCount: number, totalScore: number}>}
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
    /** @type {number|null} */
    this._highlightMinClusterSize = null;

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
            const pageNumber = evt.pageNumber;
            // Only re-highlight if this is the page we had highlights on
            if (this._highlightTerms && this._highlightPageNumber === pageNumber) {
              // Clear old highlights immediately to avoid stale visuals
              this._clearClusterHighlights();
              // Wait for layout to stabilize before re-computing positions
              requestAnimationFrame(() => {
                this._highlightTermsInTextLayer(
                  this._highlightTerms, this._highlightPageNumber,
                  this._highlightMinClusterSize, false, this._highlightAnchorTerm
                );
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
    this._highlightMinClusterSize = null;
  }

  /**
   * Searches for terms within the PDF document using span-level scoring.
   * Finds the best matching page and highlights the densest cluster of matching spans.
   *
   * @param {Array<string>|string} query - The search terms, either as a string or an array of strings.
   * @param {Object} [options={}] - Search options
   * @param {string|null} [options.anchorTerm=null] - Required term that must be in the cluster (e.g., footnote number)
   * @returns {Promise<void>}
   */
  async search(query, options = {}) {
    const { anchorTerm = null } = options;

    if (!query || query.length === 0) {
      console.warn("No search terms provided.");
      return;
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

    // Score all pages using span-level matching (consistent with highlight clustering)
    // If anchorTerm is set, only consider pages that have an exact match for it
    const pageScores = await this._scoreAllPages(query, anchorTerm);

    // Select best pages by score
    const bestMatches = this._getBestMatches(query, pageScores);
    console.log(`Found ${bestMatches.length} best matches.`);

    this.bestMatches = bestMatches;

    if (bestMatches.length > 0) {
      const pageNumber = bestMatches[0].page;
      this._lastMatchPage = pageNumber;

      // Set highlight state before navigation - the textlayerrendered event handler
      // will apply highlights when the text layer is ready
      this._highlightTerms = query;
      this._highlightPageNumber = pageNumber;
      this._highlightMinClusterSize = Math.max(2, Math.min(query.length, 5));
      this._highlightAnchorTerm = anchorTerm;

      await this.scrollToBestMatch(0);

      // If text layer already exists (cached page), apply highlights directly.
      // Otherwise, textlayerrendered event handler will do it.
      const page = this.viewer.querySelector(`.page[data-page-number="${pageNumber}"]`);
      const textLayer = page?.querySelector('.textLayer');
      if (textLayer) {
        this._highlightTermsInTextLayer(query, pageNumber, null, true, anchorTerm);
      }
    }
  }

  /**
   * Scores all pages by matching text content items against search terms.
   * Uses the same scoring logic as the span-level highlight clustering
   * for consistent page selection.
   * @param {string[]} query - Array of search terms
   * @param {string|null} [anchorTerm=null] - If set, only include pages with exact match for this term
   * @returns {Promise<Array<{page: number, matchCount: number, totalScore: number, hasAnchor: boolean}>>}
   * @private
   */
  async _scoreAllPages(query, anchorTerm = null) {
    const lookups = pdfTextSearch.buildTermLookups(query);
    const anchorLower = anchorTerm?.toLowerCase();
    const pageScores = [];

    for (let pageNum = 1; pageNum <= this.pdfDoc.numPages; pageNum++) {
      const page = await this.pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      let matchCount = 0;
      let totalScore = 0;
      let hasAnchor = false;

      const items = textContent.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const score = pdfTextSearch.scoreSpan(item.str, lookups);
        if (score > 0) {
          matchCount++;
          totalScore += score;
        }
        // Check for anchor: span starts with the anchor FOLLOWED BY content (not just the number alone)
        // This avoids matching superscript footnote references like "4" - we want "4 Vgl..." or "4Die..."
        if (anchorLower && !hasAnchor) {
          const text = item.str.toLowerCase().trim();
          // Pattern 1: anchor followed by space+text in same span (e.g., "2 Dazu etwa:")
          // Pattern 2: anchor followed by letter in same span (e.g., "2Dazu")
          hasAnchor = text.startsWith(anchorLower + ' ') ||
                      (text.startsWith(anchorLower) && text.length > anchorLower.length && /[a-z]/i.test(text[anchorLower.length]));

          // Pattern 3: standalone anchor number, with next non-whitespace item starting with letter
          // This handles PDFs that render "2" and "Dazu etwa:" as separate spans (with whitespace items between)
          if (!hasAnchor && text === anchorLower) {
            // Find the next non-whitespace item (check up to 5 items ahead)
            for (let j = i + 1; j < Math.min(i + 5, items.length); j++) {
              const nextText = items[j].str.trim();
              if (nextText.length > 0) {
                if (/^[a-z]/i.test(nextText)) {
                  hasAnchor = true;
                }
                break; // Stop at first non-whitespace item
              }
            }
          }
        }
      }

      pageScores.push({ page: pageNum, matchCount, totalScore, hasAnchor });
    }

    // If anchorTerm is set, filter to only pages that have a span starting with the anchor
    let filteredScores = pageScores;
    if (anchorTerm) {
      const pagesWithAnchor = pageScores.filter(p => p.hasAnchor);
      if (pagesWithAnchor.length > 0) {
        filteredScores = pagesWithAnchor;
      }
    }

    return filteredScores;
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
   * Selects the best matching pages from page scores.
   * @param {string[]} searchTerms - The query search terms
   * @param {Array<{page: number, matchCount: number, totalScore: number}>} pageScores - Scores per page
   * @returns {Array<{page: number, matchCount: number, totalScore: number}>} - Best pages sorted by score
   * @private
   */
  _getBestMatches(searchTerms, pageScores) {
    const minMatchCount = Math.max(2, Math.round(searchTerms.length * 0.5));

    const candidates = pageScores
      .filter(ps => ps.matchCount >= minMatchCount)
      .sort((a, b) => b.totalScore - a.totalScore);

    if (candidates.length === 0) {
      console.warn("No best match found.");
      return [];
    }

    return candidates.slice(0, 5);
  }

  /**
   * Clears any existing cluster highlight overlays
   * @param {boolean} clearState - Also clear the highlight state (default: false)
   * @private
   */
  _clearClusterHighlights(clearState = false) {
    const highlights = this.viewer.querySelectorAll('.cluster-highlight, .span-highlight');
    highlights.forEach(highlight => highlight.remove());

    if (clearState) {
      this._highlightTerms = null;
      this._highlightPageNumber = null;
      this._highlightMinClusterSize = null;
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
   * Highlights search terms by finding the densest spatial cluster on the page
   * and drawing a bounding box around it. Uses the pdf-text-search module
   * for span-to-term matching which handles hyphenation and OCR fragmentation.
   * @param {string[]} terms - Array of search terms to highlight
   * @param {number} pageNumber - The page number to highlight (1-based)
   * @param {number|null} [minClusterSize=null] - Minimum spans required (null = auto-calculate from term count)
   * @param {boolean} [scrollIntoView=true] - Whether to scroll the highlight into view
   * @param {string|null} [anchorTerm=null] - Required term that must be in the cluster
   * @private
   */
  _highlightTermsInTextLayer(terms, pageNumber, minClusterSize = null, scrollIntoView = true, anchorTerm = null) {
    // Clear previous highlights
    this._clearClusterHighlights();

    // Auto-calculate minClusterSize based on number of search terms
    const effectiveMinClusterSize = minClusterSize ?? Math.max(2, Math.min(terms?.length || 2, 5));

    // Store state for re-highlighting on zoom change
    this._highlightTerms = terms;
    this._highlightPageNumber = pageNumber;
    this._highlightMinClusterSize = effectiveMinClusterSize;
    this._highlightAnchorTerm = anchorTerm;

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
    const cluster = pdfTextSearch.findBestCluster(textLayer, terms, { minClusterSize: effectiveMinClusterSize, anchorTerm });

    if (!cluster) {
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

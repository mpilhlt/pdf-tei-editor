/**
 * A basic PDF.js v5 API
 */

/**
 * PDFJSViewer Class
 *
 * Provides an API for interacting with a PDF.js viewer embedded in an iframe,
 * assuming the viewer and PDF files are hosted on the same origin.
 */
export class PDFJSViewer {

  /**
   * An array of {page, positions} objects with the best matches to the last search()
   */
  bestMatches = null;

  /**
   * The index of the currently highlighted best match
   */
  matchIndex = 0;

  /**
   * Constructor for the PDFJSViewer class.
   * @param {string} iframeId - The ID of the iframe element containing the PDF.js viewer.
   * @param {string?} pdfPath - The path to the PDF document. If given, used when `load()` is called without argument.
   * @throws {Error} If the iframe element is not found.
   */
  constructor(containerDivId, pdfPath) {
    this.pdfPath = pdfPath;
    this.containerDiv = document.getElementById(containerDivId);
    if (!this.containerDiv) {
      throw new Error(`Cannot find element with id ${containerDivId}`);
    }

    // create iframe for PDF.js
    const iframe = document.createElement('iframe');
    this.containerDiv.appendChild(iframe);
    this.iframe = iframe;

    // references to objects in iframe 
    this.iframeWindow = null;
    this.pdfViewer = null;
    this.pdfLinkService = null;
    this.pdfDoc = null;
    this.eventBus = null;

    // promise which will resolve when PDF.js is ready
    this.initializePromise = null;
    // will be true when PDF.js is ready
    this.isReadyFlag = false;
    // promise which will resolve when the document is loaded
    this.loadPromise = null;
    // will be true when the current document is done loading
    this.isLoadedFlag = false;
  }

  show() {
    this.iframe.style.display = ''
    return this;
  }

  hide() {
    this.iframe.style.display = 'none'
    return this;
  }

  /**
   * Checks if the viewer is ready and initializes it if necessary.
   *
   * This method ensures that the iframe is loaded and the necessary PDF.js
   * objects (iframeWindow, pdfViewer, pdfLinkService) are available.  It
   * handles the asynchronous loading process, so you can await this method
   * before calling other methods in the class. The PDF.js viewer must be hosted
   * on the same origin for this to work.
   *
   * @returns {Promise<void>} - A promise that resolves when the viewer is ready.
   */
  async isReady() {
    if (this.isReadyFlag) {
      return; // Already ready, resolve immediately
    }

    if (!this.initializePromise) {
      this.initializePromise = new Promise((resolve, reject) => {
        this.iframe.onload = async () => {
          console.log("PDF.js viewer loaded in iframe, initializing...");
          try {
            this.iframeWindow = this.iframe.contentWindow;
            this.PDFViewerApplication = this.iframeWindow.PDFViewerApplication
            this.pdfViewer = this.PDFViewerApplication.pdfViewer;
            this.pdfLinkService = this.PDFViewerApplication.pdfLinkService;
            this.findController = this.PDFViewerApplication.findController;
            this.eventBus = this.pdfViewer.eventBus;
            this.eventBus.on("pagesinit", () => {
              this.pdfViewer.currentScaleValue = 'page-fit';
            });
            this.PDFViewerApplication.initializedPromise.then(() => {
              // enable hand tool
              this.PDFViewerApplication.pdfCursorTools.switchTool(1);

              // finish initialization
              this.isReadyFlag = true;
              console.log("PDF.js viewer initialized.");
              resolve();
            })
          } catch (error) {
            this.isReadyFlag = false;
            reject(error);
          }
        };

        this.iframe.onerror = () => {
          this.isReadyFlag = false;
          reject(new Error("Error loading PDF.js viewer in iframe."));
        };

        // remove pdf.js's saved state since it interferes 
        window.addEventListener('beforeunload', () => localStorage.removeItem('pdfjs.history'))
        const file = this.pdfPath ? this.pdfPath : '/web/empty.pdf'
        this.iframe.src = `/web/pdfjs/web/viewer.html?file=${file}#pagemode=none`
      });
    }
    return this.initializePromise;
  }

  /**
   * Asynchronously loads a PDF into the viewer.
   *
   * This method loads the PDF document using the `pdfjsLib.getDocument()` method
   * and then sets the document on the PDF.js viewer and link service.
   *
   * @param {string?} pdfPath - The path to the PDF document. Can be omitted if it has been given to the constructor
   * @returns {Promise<void>} - A promise that resolves when the PDF is loaded, rejects on errors.
   * @throws {Error} If there is an error loading the PDF in the iframe.
   */
  async load(pdfPath) {
    pdfPath = pdfPath || this.pdfPath;
    if (!pdfPath) {
      throw new Error("No PDF path has been given.");
    }
    await this.isReady();

    if (this.loadPromise) {
      console.log("Already loading PDF, waiting for it to finish...");
      await this.loadPromise; // Already loading, wait until this is done to reload
    }
    this.isLoadedFlag = false;

    this.loadPromise = new Promise(async (resolve, reject) => {
      try {
        this.pdfDoc = await this.iframeWindow.pdfjsLib.getDocument(pdfPath).promise;
        this.pdfViewer.setDocument(this.pdfDoc);
        this.pdfLinkService.setDocument(this.pdfDoc, null);
        console.log("PDF loaded successfully.");
        this.isLoadedFlag = true;
        resolve();
      } catch (error) {
        reject(new Error(`Error loading PDF: ${error}`));
      }
    });
    return this.loadPromise;
  }

  /**
   * Switches to a specific page in the PDF.
   *
   * This method sets the `currentPageNumber` property on the `pdfViewer` object
   * to navigate to the specified page.
   *
   * @param {number} pageNumber - The page number to switch to (1-based).
   * @throws {Error} If the viewer hasn't been intialized.
   */
  async goToPage(pageNumber) {
    await this.isReady();
    this.pdfViewer.currentPageNumber = pageNumber;
  }

  /**
   * Sets the zooming factor of the PDF viewer.
   *
   * This method sets the `currentScaleValue` property on the `pdfViewer` object
   * to change the zoom level.
   *
   * @param {number} zoomFactor - The desired zoom factor (e.g., 1.0 for 100%, 2.0 for 200%).
   * @throws {Error} If the viewer hasn't been intialized.
   */
  async setZoom(zoomFactor) {
    await this.isReady();
    this.pdfViewer.currentScaleValue = zoomFactor;
  }


  /**
   * Searches for a string within the PDF document using the PDF.js Viewer's findController.
   *
   * @param {Array<string>|string} query - The search terms, either as a string or an array of strings.
   * If an array is provided, the search will be performed for each term in the array.
   * @param {object?} options - An object with keys phraseSearch (true), caseSensitive (false), entireWord (true), 
   * highlightAll (false), findPrevious (false),
   * @returns {Promise<Array<{pageIndex: number, matchIndex: number}>>} - A promise that resolves with an array of objects,
   * each containing the page index (0-based) and match index (0-based) of the found string.
   * Returns an empty array if no matches are found.
   * @throws {Error} If there is an error during the search.
   */
  async search(query, options = {}) {

    if (!query || query.length === 0) {
      console.warn("No search terms provided.");
      return [];
    }

    // wait for document to be loaded
    if (!this.isLoadedFlag) {
      await this.isReady();
      if (!this.loadPromise) {
        throw new Error("PDF document not loaded. Call load() first.");
      }
      console.log("Waiting for PDF document to load...");
      await this.loadPromise;
    }

    if (!Array.isArray(query)) {
      query = [query]
    }

    if (query.length > 20) {
      console.warn("Query too big, reducing to 20 entries");
      query = query.slice(0, 20)
    }

    console.log("Searching for", query.map(q => `'${q}'`).join(", "), "...");

    const defaultOptions = {
      query,
      phraseSearch: false,
      caseSensitive: false,
      entireWord: true,
      highlightAll: true,
      findPrevious: false,
    };

    // override defaults with options
    options = Object.assign(defaultOptions, options)

    return new Promise((resolve, reject) => {
      this.pdfViewer.eventBus.dispatch("find", options);
      this.pdfViewer.eventBus.on("updatefindcontrolstate", (event) => {
        // timeout to let the highlighter do its thing
        setTimeout(() => {
          const bestMatches = this.#getBestMatches(query)
          console.log(`Found ${bestMatches.length} best matches.`)
          this.bestMatches = bestMatches;
          if (bestMatches.length) {
            if (bestMatches.length > 1){
              // if we have several best matches, show them in the console so that the sorting algorithm can be improved
              console.log({bestMatches})
            }
            this.scrollToBestMatch().catch(reject)
          }
          resolve();
        }, 100)
      },
        { once: true } // Remove the event listener after the first event
      );
    });
  }

  async _waitForPageViewRendered(pageIndex) {
    return new Promise(async (resolve, reject) => {
      const pageView = await this.pdfViewer.getPageView(pageIndex);
      if (pageView.renderingState === 3) { // RenderingStates.FINISHED
        return resolve(pageView);
      }
      pageView.eventBus.on("pagerendered", () => resolve(pageView), { once: true })
    })
  }

  /**
   * Scrolls to the best match wit the given index. 
   * @param {number} index The index of the best match found, defaults to 0
   */
  async scrollToBestMatch(index = 0) {
    if (!this.bestMatches) {
      throw new Error("No best matches - do a search first");
    }

    if (index < 0 || index > this.bestMatches.length) {
      throw new Error(`Index out of bounds: ${index} of ${this.bestMatches.length}`);
    }

    // The following relies on undocumented behavior. There seem to exist no API for switching between 
    // the matches, and most of the internal stuff is hidden via private methods and properties so we 
    // have to tweak what is available. 

    // In the bestMatches lookup table, we have object containing the page and an array
    // of indexes into the array contained in findController.pageMatches[pageIndex], which refer 
    // to the position of the match in the page text.

    const match = this.bestMatches[index]
    const pageNumber = match.page;
    const pageIndex = pageNumber - 1
    const matchIndex = match.matchIndexes[0]

    // load the page
    this.pdfViewer.scrollPageIntoView({ pageNumber })

    // we need the page to be rendered, so continue after a timeout
    return new Promise((resolve,reject) => {
      setTimeout(() => {
        try {

          // There seems to be no way of getting from the text position to the DOM element which provides 
          // the highlighting of the match. This is provided by `pageView.textlayer.highlighter`, which has a property 
          // `matches` containing an array of objects of this form:
          //  [{ begin: { divIdx: 2, offset: 0 }, end: { divIdx: 2, offset: 6 }, ...] . If we know the match index,
          // we can look up the corresponding Div element in the highlighter's textDivs property. 
  
          const highlighter = this.pdfViewer.getPageView(pageIndex).textLayer.highlighter
          let { matches, textDivs } = highlighter
          const { divIdx, offset } = matches[matchIndex].begin
          const element = textDivs[divIdx]
  
          // Scroll the match into view by hacking `scrollMatchIntoView()`
          this.findController._scrollMatches = true;
          this.findController._selected.matchIdx = matchIndex;
          this.findController._selected.pageIdx = pageIndex;
          this.findController.scrollMatchIntoView({ element, pageIndex, matchIndex });
        } catch (error) {
          reject("Error computing the best match:", error.message)
        }
        resolve()
      }, 100)
    })
  }

  /**
   * Selects the best matches from the results of the previous search by comparing
   * the length of the most densely clustered search terms.  
   * @param {Array} searchTerms The query search terms
   * @returns {Array} An array of {pageIndex, matchIndexes, positions} objects
   */
  #getBestMatches(searchTerms) {
    // the number of matches on a page that need to be reached to be a candidate for a "best match"
    // calculated at 80% (since there might be hyphenated words that cannot be found) with a minimum of 3 matched terms
    const minNumMatches = Math.max(Math.round(searchTerms.length * .8), 3)

    // filter the page matches by this value
    const { pageMatches } = this.pdfViewer.findController
    const candidates = pageMatches.map((positions, idx) => ({ page: idx + 1, positions }))
    const bestMatches = candidates.filter(match => match.positions.length >= minNumMatches)

    if (bestMatches.length === 0) {
      // we did not find a best match, this should not occur, do log some diagnostics
      console.warn("No best match found.")
      console.log({ pageMatches, minNumMatches, candidates })
    }

    // returns the cluster of values which are most densely spread, i.e. which have the
    // smallest distance of lowest and highest value in a given window
    // written by Codestral 22B
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

    // sort the pages according to cluster size, i.e. the page where the highest number
    // of search terms appear the most densely clustered - this should be our citation
    bestMatches.sort((a, b) => {
      return (
        findDensestCluster(b.positions, minNumMatches).length -
        findDensestCluster(a.positions, minNumMatches).length
      )
    })

    // return the page matches in this order, but only retain the densest cluster
    return bestMatches.map(match => {
      const cluster = findDensestCluster(match.positions, minNumMatches);
      match.matchIndexes = cluster.map(position => match.positions.indexOf(position))
      match.positions = cluster
      return match
    }).filter(match => match.positions.length > 0)
  }
}

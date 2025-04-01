/**
 * A basic PDF.js v5 API
 */

/**
 * Clusters an array of highlighted divs based on geometric proximity and
 * uniqueness of text content.
 *
 * @param {HTMLElement[]} highlightedDivs - An array of highlighted div elements.
 * @returns {HTMLElement[]} - An array of clustered div elements.
 */
function clusterHighlightedDivs(highlightedDivs) {
  if (!highlightedDivs || highlightedDivs.length === 0) {
    return []; // Return empty array if input is empty or null
  }

  /**
   * Calculates the geometric distance between two HTML elements.
   * @param {HTMLElement} el1 - The first element.
   * @param {HTMLElement} el2 - The second element.
   * @returns {number} The distance between the centers of the elements.
   */
  function calculateDistance(el1, el2) {
    const rect1 = el1.getBoundingClientRect();
    const rect2 = el2.getBoundingClientRect();
    const centerX1 = rect1.left + rect1.width / 2;
    const centerY1 = rect1.top + rect1.height / 2;
    const centerX2 = rect2.left + rect2.width / 2;
    const centerY2 = rect2.top + rect2.height / 2;
    const distanceX = centerX2 - centerX1;
    const distanceY = centerY2 - centerY1;
    return Math.sqrt(distanceX * distanceX + distanceY * distanceY);
  }

  // Remove duplicates, keeping the closest ones
  const uniqueDivs = [];
  const seenTexts = new Set();

  for (const div of highlightedDivs) {
    const text = div.textContent;

    if (!seenTexts.has(text)) {
      uniqueDivs.push(div);
      seenTexts.add(text);
    } else {
      // Duplicate found.  Check if the existing one is farther away.
      const existingIndex = uniqueDivs.findIndex(d => d.textContent === text);
      const existingDiv = uniqueDivs[existingIndex];

      // Calculate average distance of new div and existing div to all other divs
      let newDivTotalDistance = 0;
      let existingDivTotalDistance = 0;

      for (const otherDiv of highlightedDivs) {
        if (otherDiv !== div && otherDiv !== existingDiv) {
          newDivTotalDistance += calculateDistance(div, otherDiv);
          existingDivTotalDistance += calculateDistance(existingDiv, otherDiv);
        }
      }

      const newDivAverageDistance = newDivTotalDistance / (highlightedDivs.length - 2);
      const existingDivAverageDistance = existingDivTotalDistance / (highlightedDivs.length - 2);

      // If the new div is closer on average, replace the existing one
      if (newDivAverageDistance < existingDivAverageDistance) {
        uniqueDivs[existingIndex] = div;
      }
    }
  }


  // Cluster based on geometric proximity. This is a simple, greedy clustering.
  const clusters = [];
  const unclustered = [...uniqueDivs]; // Create a copy so we can modify it

  while (unclustered.length > 0) {
    const currentCluster = [unclustered.shift()]; // Start a new cluster with the first unclustered div

    // Find the closest div to the current cluster
    let closestDiv = null;
    let minDistance = Infinity;

    for (let i = 0; i < unclustered.length; i++) {
      const div = unclustered[i];
      let distanceToCluster = 0;

      // Calculate the average distance from the div to all divs in the current cluster
      for (const clusterDiv of currentCluster) {
        distanceToCluster += calculateDistance(div, clusterDiv);
      }
      distanceToCluster /= currentCluster.length;

      if (distanceToCluster < minDistance) {
        minDistance = distanceToCluster;
        closestDiv = div;
      }
    }

    //Add the closest div to this cluster if it's closer than other unclustered nodes are to it.
    if (closestDiv) {
      let closestToClosest = Infinity;
      for (let i = 0; i < unclustered.length; i++) {
        if (unclustered[i] === closestDiv) continue;

        const distance = calculateDistance(closestDiv, unclustered[i]);

        if (distance < closestToClosest) {
          closestToClosest = distance;
        }
      }

      if (minDistance < closestToClosest) {
        currentCluster.push(closestDiv);
        unclustered.splice(unclustered.indexOf(closestDiv), 1); // Remove from unclustered
      } else {
        //No good match for this cluster; break
        clusters.push(currentCluster);
        continue;
      }
    } else {
      //No more divs to cluster
    }

    clusters.push(currentCluster);
  }

  //Flatten the clusters into a single array.  For more complex clustering scenarios you might want the clusters
  return clusters.reduce((acc, cluster) => acc.concat(cluster), []);
}


/**
 * PDFJSViewer Class
 *
 * Provides an API for interacting with a PDF.js viewer embedded in an iframe,
 * assuming the viewer and PDF files are hosted on the same origin.
 */
export class PDFJSViewer {
  /**
   * Constructor for the PDFJSViewer class.
   * @param {string} iframeId - The ID of the iframe element containing the PDF.js viewer.
   * @param {string?} pdfPath - The path to the PDF document. If given, used when `load()` is called without argument.
   * @throws {Error} If the iframe element is not found.
   */
  constructor(iframeId, pdfPath) {
    this.iframeId = iframeId;
    this.pdfPath = pdfPath;
    this.pdfjsViewerIframe = document.getElementById(iframeId);

    if (!this.pdfjsViewerIframe) {
      throw new Error(`PDF.js viewer iframe not found (id='${iframeId}')`);
    }

    this.iframeWindow = null;
    this.pdfViewer = null;
    this.pdfLinkService = null;
    this.pdfDoc = null; // Store the PDF document
    this.eventBus = null;
    this.isReadyFlag = false;
    this.initializePromise = null; // Store the initialization promise
  }

  show() {
    this.pdfjsViewerIframe.style.display = ''
    return this;
  }

  hide(){
    this.pdfjsViewerIframe.style.display = 'none'
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
        this.pdfjsViewerIframe.onload = async () => {
          console.log("PDF.js viewer loaded in iframe, initializing...");
          try {
            this.iframeWindow = this.pdfjsViewerIframe.contentWindow;
            this.PDFViewerApplication = this.iframeWindow.PDFViewerApplication
            this.pdfViewer = this.PDFViewerApplication.pdfViewer;
            this.pdfLinkService = this.PDFViewerApplication.pdfLinkService;
            this.findController = this.PDFViewerApplication.findController;
            this.eventBus = this.pdfViewer.eventBus;
            this.eventBus.on("pagesinit", () => {
              this.pdfViewer.currentScaleValue = 'page-fit';
            });
            this.PDFViewerApplication.initializedPromise.then(() => {
              this.isReadyFlag = false;
              console.log("PDF.js viewer initialized.");
              resolve();
            })
          } catch (error) {
            this.isReadyFlag = false;
            reject(error);
          }
        };

        this.pdfjsViewerIframe.onerror = () => {
          this.isReadyFlag = false;
          reject(new Error("Error loading PDF.js viewer in iframe."));
        };

        // remove pdf.js's saved state since it interferes 
        window.addEventListener('beforeunload', () => localStorage.removeItem('pdfjs.history'))

        this.pdfjsViewerIframe.src = `/pdfjs/web/viewer.html` + (this.pdfPath ? `?url=${this.pdfPath}` : '');
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

    try {
      this.pdfDoc = await this.iframeWindow.pdfjsLib.getDocument(pdfPath).promise;
      this.pdfViewer.setDocument(this.pdfDoc);
      this.pdfLinkService.setDocument(this.pdfDoc, null);
      console.log("PDF loaded successfully.");
    } catch (error) {
      throw new Error(`Error loading PDF in iframe: ${error}`);
    }
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
   * Scrolls a specific coordinate in a given page to a specified percentage of the iframe.
   *
   * This method scrolls the PDF viewer to a specific location on a given page,
   * calculated as a percentage of the iframe's width and height.
   *
   * @param {number} pageNumber - The page number to scroll in (1-based).
   * @param {number} xPercent - The horizontal percentage (0-100) of the iframe to scroll to.
   * @param {number} yPercent - The vertical percentage (0-100) of the iframe to scroll to.
   * @throws {Error} If the viewer hasn't been intialized.
   * @throws {Error} If the specified page is not found.
   */
  async scrollToPercentage(pageNumber, xPercent, yPercent) {
    await this.isReady();

    const page = this.pdfViewer.getPageView(pageNumber - 1);

    if (!page) {
      throw new Error(`Page ${pageNumber} not found`);
    }

    const pageWidth = page.width;
    const pageHeight = page.height;
    const viewerWidth = this.pdfViewer.container.clientWidth;
    const viewerHeight = this.pdfViewer.container.clientHeight;

    const scrollX = (xPercent / 100) * pageWidth - (viewerWidth / 2);
    const scrollY = (yPercent / 100) * pageHeight - (viewerHeight / 2);

    this.pdfViewer.container.scrollTo({
      top: scrollY,
      left: scrollX,
      behavior: 'smooth'
    });
  }

  /**
   * Searches for a string within the PDF document using the PDF.js Viewer's findController.
   *
   * @param {string} query - The string to search for.
   * @param {object?} options - An object with keys phraseSearch (true), caseSensitive (false), entireWord (true), 
   * highlightAll (false), findPrevious (false),
   * @returns {Promise<Array<{pageIndex: number, matchIndex: number}>>} - A promise that resolves with an array of objects,
   * each containing the page index (0-based) and match index (0-based) of the found string.
   * Returns an empty array if no matches are found.
   * @throws {Error} If there is an error during the search.
   */
  async search(query, options = {}) {
    await this.isReady();

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

    return new Promise((resolve) => {
      this.pdfViewer.eventBus.dispatch("find", options);
      this.pdfViewer.eventBus.on("updatefindcontrolstate", (event) => {
        const result = [];
        // Iterate through all matches and collect page and match indexes.
        for (let i = 0; i < this.findController.pageMatches.length; i++) {
          const pageMatches = this.findController.pageMatches[i];
          for (let j = 0; j < pageMatches.length; j++) {
            result.push({ pageIndex: i, matchIndex: j });
          }
        }
        resolve(result);
      },
        { once: true } // Remove the event listener after the first event
      );
    });
  }

  async _waitForPageViewRendered(pageIndex){
    return new Promise(async (resolve, reject) => {
      const pageView = await this.pdfViewer.getPageView(pageIndex);
      if (pageView.renderingState === 3 ) { // RenderingStates.FINISHED
        return resolve(pageView);
      }
      pageView.eventBus.on("pagerendered", () => resolve(pageView), {once: true})
    })
  }

  async getHighlightedDivs(pageIndex) {
    const pageView = await this._waitForPageViewRendered(pageIndex);
    return Array.from(pageView.textLayer.div.getElementsByClassName('highlight'));
  }


  /**
   * Highlights a specific search result and scrolls it into view using the PDF.js Viewer's findController.
   *
   * @param {number} pageIndex - The index of the page containing the match (0-based).
   * @param {number} matchIndex - The index of the match within the page's text content (0-based).
   */
  async highlightAndScrollTo(pageIndex, matchIndex) {
    await this.isReady();

    //Ensure highlightAll is false so that it is not highlighted until the user goes to it.
    this.pdfViewer.eventBus.dispatch("find", {
      query: this.findController.state.query, //Preserve the existing query
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: false,
      findPrevious: false,
    });

    // Set the current match index.
    this.findController.updateMatchPosition(matchIndex, pageIndex);

    // Scroll the match into view
    this.findController.scrollToCurrentMatch();
  }
}
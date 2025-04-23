
// todo
export class ApplicationState {

  /**
   * The data on the files on the server which can be worked on
   * @type {Array<Object>}
   */
  #fileData = null

  // #pdfPath = null
  // #xmlPath = null
  // #diffXmlPath = null
  // #pdfViewer = null
  // #xmlEditor = null
  // #lastSelectedXpathlNode = null
  // #currentIndex = null
  // #selectionXpath = null
  // #lastCursorXpath = null
  // #currentXpathResultSize = null
  // #currentXpathResultIndex = null
  // #lastSelectedXpathlNode = null

  constructor() {
  
  }

  /**
   * Returns a promise that resolves with the file data, when available. Immediately resolves if the
   * file data already has been loaded
   * @param {boolean} refresh
   * @returns {Array<Object>}
   */
  async getfileData(refresh=false) {
    if (refresh || this.#fileData === null) {
      const { files } = await client.getFileList();
      this.#fileData = files
    }
    return this.#fileData
  }
  
}

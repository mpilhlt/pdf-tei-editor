
// todo
class ApplicationState {
  #pdfPath = null
  #xmlPath = null
  #diffXmlPath = null
  #pdfViewer = null
  #xmlEditor = null
  #lastSelectedXpathlNode = null
  #currentIndex = null
  #selectionXpath = null
  #lastCursorXpath = null
  #currentXpathResultSize = null
  #currentXpathResultIndex = null
  #lastSelectedXpathlNode = null

  constructor() {
  
  }

  // pdf path
  get pdfPath() { 
    return this.#pdfPath
  }

  set pdfPath(path) {
    if (path !== this.#pdfPath) {
      this.#pdfPath = path
      UrlHash.set('pdf', path)
    }
  }

  get xmlPath() {
    return this.#xmlPath
  } 

  set xmlPath(path) { 
    this.#xmlPath = path
  }
  get diffXmlPath() {
    return this.#diffXmlPath
  } 
  set diffXmlPath(path) { 
    this.#diffXmlPath = path
  }
  
}

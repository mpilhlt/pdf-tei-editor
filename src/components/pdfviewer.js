import { PDFJSViewer } from '../modules/pdfviewer.js'
import { app, PdfTeiEditor } from '../app.js'

/**
 * component is an instance of PDFViewer
 * @type {PDFJSViewer}
 */
export const pdfViewerComponent = new PDFJSViewer('pdf-viewer')

// hide the editor until it is fully loaded
pdfViewerComponent.hide().isReady().then(()=>pdfViewerComponent.show())

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 * @returns {Promise<void>}
 */
async function install(app) {
  
  app.registerComponent('pdfviewer', pdfViewerComponent, 'pdfviewer')

  app.on("change:xpath", (value, old) => {
    console.warn(`TODO reimplement search node in PDF for  ${value}`)
        // trigger auto-search if enabled, 
        // const autoSearchSwitch = $('#switch-auto-search') // todo convert into state app
        // if (autoSearchSwitch.checked) {
        //   await app.services.searchNodeContentsInPdf(node)
        // }
  })
  app.logger.info("PDFViewer component installed.")
  await pdfViewerComponent.isReady()
  app.logger.info("Waiting for PDF Viewer ready...")
}

/**
 * component plugin
 */
export const pdfViewerPlugin = {
    name: "pdfviewer",
    install
}

export default pdfViewerPlugin


//
// Implementation
//

/**
 * Given a Node in the XML, search and highlight its text content in the PDF Viewer
 * @param {Element} node 
 */
async function searchNodeContentsInPdf(node) {

  let searchTerms = getNodeText(node)
    // split all node text along whitespace and hypen/dash characters
    .reduce((acc, term) => acc.concat(term.split(/[\s\p{Pd}]/gu)), [])
    // Search terms must be more than three characters or consist of digits. This is to remove 
    // the most common "stop words" which would litter the search results with false positives.
    // This incorrectly removes hyphenated word parts but the alternative would be to  have to 
    // deal with language-specific stop words
    .filter(term => term.match(/\d+/) ? true : term.length > 3)

  // make the list of search terms unique
  searchTerms = Array.from(new Set(searchTerms))

  // add footnote
  if (node.hasAttribute("source")) {
    const source = node.getAttribute("source")
    // get footnote number 
    if (source.slice(0, 2) === "fn") {
      // remove the doi prefix
      searchTerms.unshift(source.slice(2) + " ")
    }
  }

  // start search
  await app.pdfViewer.search(searchTerms);
}

// utilities

/**
 * Returns a list of non-empty text content from all text nodes contained in the given node
 * @returns {Array<string>}
 */
function getNodeText(node) {
  return getTextNodes(node).map(node => node.textContent.trim()).filter(Boolean)
}

/**
 * Recursively extracts all text nodes contained in the given node into a flat list
 * @return {Array<Node>}
 */
function getTextNodes(node) {
  let textNodes = [];
  if (node.nodeType === Node.TEXT_NODE) {
    textNodes.push(node);
  } else {
    for (let i = 0; i < node.childNodes.length; i++) {
      textNodes = textNodes.concat(getTextNodes(node.childNodes[i]));
    }
  }
  return textNodes;
}

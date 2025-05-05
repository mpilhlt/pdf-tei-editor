/**
 * This component provides the core services that can be called programmatically or via user commands
 */
import { app, PdfTeiEditor } from '../app.js'
import { UrlHash } from '../modules/browser-utils.js'
import { xpathInfo } from '../modules/utils.js'

// name of the component
const name = "services"

/**
 * component API
 */
const servicesComponent = {
  load, 
  validateXml, 
  searchNodeContentsInPdf, 
  saveXml, 
  extractFromPDF,
  showMergeView,
  removeMergeView,
  getDoiFromXml,
  getDoiFromFilenameOrUserInput,
  xpathInfo,
  getXpathResultSize
}

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  app.registerComponent(name, servicesComponent, name)
  console.log("Services component installed.")
}

/**
 * component plugin
 */
const servicesPlugin = {
  name,
  install
}

export { servicesComponent, servicesPlugin }
export default servicesPlugin

/**
 * Loads the given XML and/or PDF file(s) into the editor and viewer 
 * @param {Object} param0 The XML and PDF paths
 * @param {string} param0.xml The path to the XML file
 * @param {string} param0.pdf The path to the PDF file
 */
async function load({ xml, pdf }) {

  const promises = []

  // PDF 
  if (pdf) {
    console.log("Loading PDF", pdf)
    promises.push(app.pdfviewer.load(pdf))
  }

  // XML
  if (xml) {
    console.log("Loading XML", xml)
    servicesComponent.removeMergeView()
    promises.push(app.xmleditor.loadXml(xml))
  }

  // await promises in parallel
  await Promise.all(promises)

  if (pdf) { 
    app.pdfPath = pdf
    // update selectboxes in the toolbar
    await app.commandbar.update()
    app.xmlPath = app.diffXmlPath = null
  }
  if (xml) {
    app.xmlPath = xml
    app.diffXmlPath = xml
  }
}

/**
 * Validates the XML document by calling the validation service
 * @returns {Promise<void>}
 */
async function validateXml() {
  console.log("Validating XML...")
  await app.xmleditor.validateXml()
}

/**
 * Saves the current XML content to the server
 * @param {string} filePath The path to the XML file
 * @returns {Promise<void>}
 */
async function saveXml(filePath) {
  console.log("Saving XML on server...");
  await app.client.saveXml(app.xmleditor.getXML(), filePath)
}

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

/**
 * Extracts references from the given PDF file
 * @param {string} filename The name of the PDF file
 * @param {string} doi The DOI of the PDF file
 * @returns {Promise<{xml, pdf}>} An object with path to the xml and pdf files
 * @throws {Error} If the DOI is not valid
 */
async function extractFromPDF(filename, doi = "") {
  if (!filename) {
    throw new Error("No filename given")
  }
  app.spinner.show('Extracting references, please wait')
  try {
    let result = await app.client.extractReferences(filename, doi)
    app.commandbar.update()
    return result
  } finally {
    app.spinner.hide()
  }
}

/**
 * Creates a diff between the current and the given document and shows a merge view
 * @param {string} diff The path to the xml document with which to compare the current xml doc
 */
async function showMergeView(diff) {
  console.log("Loading diff XML", diff)
  app.spinner.show('Computing file differences, please wait...')
  try {
    await app.xmleditor.showMergeView(diff)
  } finally {
    app.spinner.hide()
  }
  app.diffXmlPath = diff
}

/**
 * Removes all remaining diffs
 */
function removeMergeView() {
  app.xmleditor.hideMergeView()
  app.diffXmlPath = app.xmlPath
  UrlHash.remove("diff")
}


//
// helper methods
// 

function getDoiFromXml() {
  return app.xmleditor.getDomNodeByXpath("//tei:teiHeader//tei:idno[@type='DOI']")?.textContent
}

function getDoiFromFilenameOrUserInput(filename) {
  if (filename.match(/^10\./)) {
    // treat as a DOI-like filename
    // do we have URL-encoded filenames?
    doi = filename.slice(0, -4)
    if (decodeURIComponent(doi) !== doi) {
      // filename is URL-encoded DOI
      doi = decodeURIComponent(doi)
    } else {
      // custom decoding 
      doi = doi.replace(/_{1,2}/, '/').replaceAll(/__/g, '/')
    }
  }
  const msg = "Please enter the DOI of the PDF. This will add metadata to the generated TEI document"
  doi = prompt(msg, doi)
  if (doi === null) {
    // user cancelled
    throw new Error("User cancelled DOI input")
  } else if (!isDoi(doi)) {
    window.app.dialog.error(`${doi} does not seem to be a DOI, please try again.`)
    throw new Error("Invalid DOI")
  }
}

function getXpathResultSize(xpath) {
  try {
    return app.xmleditor.countDomNodesByXpath(xpath)
  } catch (e) {
    console.error(e)
    return 0
  }
}



//
// helper methods
//

function isDoi(doi) {
  // from https://www.crossref.org/blog/dois-and-matching-regular-expressions/
  const DOI_REGEX = /^10.\d{4,9}\/[-._;()\/:A-Z0-9]+$/i  
  return Boolean(doi.match(DOI_REGEX)) 
}
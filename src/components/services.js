/**
 * This component provides the core services that can be called programmatically or via user commands
 */
import { isDoi } from './modules/utils.js'
import { app, PdfTeiEditor } from '../app.js'

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
  getDoiFromFilenameOrUserInput
}

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function start(app) {
  app.registerComponent(name, servicesComponent, name)
  console.log("Services plugin installed.")
}

/**
 * component plugin
 */
const servicesPlugin = {
  name,
  app: { start }
}

export { servicesComponent, servicesPlugin }
export default servicesPlugin



/**
 * Loads the given XML original, XML diff and/or PDF files into the editor and viewer 
 * without reloading the app
 * @param {Object} param0 The XML and PDF paths
 * @param {string} param0.xml The path to the XML file
 * @param {string} param0.pdf The path to the PDF file
 * @param {string} param0.diff The path to the diff XML file
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
    promises.push(app.xmleditor.loadXml(xml))
  }

  // await promises in parallel
  await Promise.all(promises)

  if (pdf) {
    xmlPath = diffXmlPath = null
    // update the URL hash
    UrlHash.set('pdf', pdf)
    UrlHash.remove('xml')
    UrlHash.remove('diff')
    UrlHash.remove('xpath')
    pdfPath = pdf
  }
  if (xml) {
    // update the URL hash 
    UrlHash.set('xml', xml)
    UrlHash.remove('diff')
    UrlHash.remove('xpath')
    diffXmlPath = xml
    xmlPath = xml
  }
  // update selectboxes in the toolbar
  populateFilesSelectboxes()
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

async function showMergeView(diff) {
  console.log("Loading diff XML", diff)
  app.spinner.show('Computing file differences, please wait...')
  try {
    await app.xmleditor.showMergeView(diff)
  } finally {
    app.spinner.hide()
  }
  diffXmlPath = diff
  UrlHash.set('diff', diff)
  diffSelectbox.selectedIndex = Array.from(diffSelectbox.options).findIndex(option => option.value === diff)
  $$('#nav-diff button').forEach(node => node.disabled = false)
}

function removeMergeView() {
  UrlHash.remove("diff")
  diffXmlPath = xmlPath
  diffSelectbox.selectedIndex = versionSelectbox.selectedIndex
  $$('#nav-diff button').forEach(node => node.disabled = true)
}



//
// update state
//

/**
 * Called when the URL hash changes
 * @param {Event} evt The hashchange event
 * @returns {void}
 */
function onHashChange(evt) {
  const xpath = UrlHash.get("xpath");
  if (xpath && xpath !== getSelectionXpath()) {
    setSelectionXpath(xpath)
  } else {
    setSelectionXpath(getSelectionXpath())
  }
}


/**
 * Sets the xpath for selecting nodes, and selects the first
 * @param {string} xpath The xpath identifying the node(s)
 */
function setSelectionXpath(xpath) {
  let index = 1;
  // if the xpath has a final index, override our own and strip it from the selection xpath
  const m = xpath.match(/(.+?)\[(\d+)\]$/)
  if (m) {
    xpath = m[1]
    index = parseInt(m[2])
  }
  const selectbox = $('#select-xpath');

  if (selectbox.value !== xpath) {
    let index = Array.from(selectbox.options).findIndex(option => option.value === xpath)
    // custom xpath
    if (index === -1) {
      index = selectbox.length - 1
      selectbox[index].value = xpath
      selectbox[index].text = `Custom: ${xpath}`
      selectbox[index].disabled = false
    }
    // update the selectbox
    selectbox.selectedIndex = index;
  }

  // update xpath
  const xpathHasChanged = selectionXpath !== xpath
  const size = getXpathResultSize(xpath)
  if (xpathHasChanged) {
    selectionXpath = xpath
    console.log("Setting xpath", xpath)
    updateIndexUI(index, size)
  }

  // select the first node
  if (size > 0 && (index !== currentIndex || xpathHasChanged)) {
    selectByIndex(index)
  }
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

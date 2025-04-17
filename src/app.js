import { XMLEditor } from './xmleditor.js'
import { PDFJSViewer } from './pdfviewer.js'
import *  as client from './client.js'
import { $, UrlHash, showMessage, addBringToForegroundListener, makeDraggable } from './browser-utils.js'
import { uploadFile } from './upload.js'
import { disableValidation } from './lint.js'
import { Spinner } from '../web/spinner.js' // included so that <custom-spinner> element is defined
import { isDoi } from './utils.js'

// the last selected node, can be null
let lastSelectedXmlNode = null;
// the index of the currently selected node, 1-based
let currentIndex = null;
// the current xpath
let currentXpath = null;
// the xml editor
let xmlEditor = null;
// the pdf viewer
let pdfViewer = null;
// the path from which to load the autocompletion data
const tagDataPath = '/data/tei.json'

try {
  main()
} catch (error) {
  console.error(error)
}

/**
 * The main application
 */
async function main() {

  showSpinner('Loading documents, please wait...')

  // get info from URL 
  const urlParams = new URLSearchParams(window.location.search);
  const pdfPath = window.pdfPath = urlParams.get('pdf');
  const xmlPath = window.xmlPath = urlParams.get('xml');

  console.log(`Starting Application\nPDF: ${pdfPath}\nXML: ${xmlPath}`);

  // disable regular validation so that we have more control over it
  disableValidation(true)

  // wait for UI to be fully set up
  try {
    await Promise.all([
      pdfPath ? loadPdfViewer(pdfPath) : null,
      xmlPath ? loadXmlEditor(xmlPath, tagDataPath) : null,
      configureNavigation()
    ]).catch(e => { throw e; })
  } catch (error) {
    spinner.hide();
    alert(error.message)
    throw error
  }

  console.log("All Editors/Viewers loaded.")

  if (xmlEditor) {
    // handle selection change
    xmlEditor.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, event => {
      handleSelectionChange(event.detail)
    });

    // this triggers the initial selection
    setSelectionXpathFromUrl()

    // measure how long it takes to validate the document
    const startTime = new Date().getTime();
    xmlEditor.validateXml().then(() => {
      const endTime = new Date().getTime();
      const seconds = Math.round((endTime - startTime) / 1000);
      // disable validation if it took longer than 3 seconds
      console.log(`Validation took ${seconds} seconds${seconds > 3 ? ", disabling it." : "."}`)
      disableValidation(seconds > 3)
    })
  }

  hideSpinner()
  $('#document-nav').show()
  console.log("Application ready.")
}

function showSpinner(msg) {
  $('#spinner').show(msg)
}

function hideSpinner() {
  $('#spinner').hide()
}

async function loadXmlEditor(xmlPath, tagDataPath) {
  console.log("Initializing XML Editor...")
  let tagData;
  try {
    console.log("Loading autocompletion data...");
    const res = await fetch(tagDataPath);
    tagData = await res.json();
  } catch (error) {
    console.error('Error fetching from', tagDataPath, ":", error);
    return;
  }
  xmlEditor = window.xmlEditor = new XMLEditor('xml-editor', tagData);
  console.log("Loading XML data...");
  await xmlEditor.loadXml(xmlPath)
}

async function loadPdfViewer(pdfPath) {
  pdfViewer = window.pdfViewer = new PDFJSViewer('pdf-viewer', pdfPath).hide();
  await pdfViewer.load(pdfPath)
  pdfViewer.show()
}


async function configureNavigation() {

  await Promise.all([
    populateFilesSelectbox(),
    populateXpathSelectbox()
  ])

  // when everything is configured, we can show the UI
  $('#navigation').show()

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener(['#navigation', '.cm-panels']);

  // make navigation draggable
  makeDraggable($('#navigation'))

  // configure "verification" button
  $('#btn-node-status').addEventListener('click', handleStatusUpdate)

  // allow to input node index
  $('#selection-index').addEventListener('click', onClickSelectionIndex)

  // load new document
  $('#btn-load-document').addEventListener('click', onClickLoadDocument)

  // save current version
  $('#btn-save-document').addEventListener('click', onClickSaveButton);
}

async function handleSelectionChange(ranges) {
  if (ranges.length === 0) return;

  // we care only for the first selected node
  const range = ranges[0]
  const selectedNode = range.node;
  lastSelectedXmlNode = selectedNode;
  if (!selectedNode) return;

  const selectionTagName = xpathInfo(getSelectionXpath()).tagName
  const statusButton = $('#btn-node-status')
  if (selectedNode.tagName === selectionTagName) { 
    statusButton.disabled = false
    if (pdfViewer) {
      await searchNodeContentsInPdf(selectedNode)
    }
  } else {
    statusButton.disabled = true
  }
}

function handleStatusUpdate() {
  if (lastSelectedXmlNode) {
    const status = lastSelectedXmlNode.getAttribute('status');
    switch (status) {
      case "unresolved":
        lastSelectedXmlNode.setAttribute("status", "verified")
        break;
      case "verified":
        lastSelectedXmlNode.removeAttribute("status")
        break;
      default:
        lastSelectedXmlNode.setAttribute("status", "unresolved")
    }
    // update the editor content
    window.xmlEditor.updateFromXmlTree()
    selectByIndex(currentIndex)
  }
}

function onClickSelectionIndex() {
  let index = prompt('Enter node index')
  if (!index) return;
  try {
    selectByIndex(parseInt(index))
  } catch (error) {
    alert(error.message)
  }
}


async function onClickLoadDocument() {
  try {
    const { type, filename } = await uploadFile('/api/upload');
    switch (type) {
      case "xml":
        alert("Loading XML documents not implemented yet.")
        break
      case "pdf":
        extractFromPDF(filename)
        break;
    }
  } catch (error) {
    console.error('Error uploading file:', error);
  }
}

async function onClickSaveButton() {
  const xmlPath = $('#select-version').value;
  await validateAndSave(xmlPath)
}

async function extractFromPDF(filename) {
  let doi = ""
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
  const msg = "Please enter the DOI of the PDF, this will add metadata to the generated TEI document"
  doi = prompt(msg, doi)
  if (doi === null) {
    return;
  } else if (!isDoi(doi)) {
    alert(`${doi} does not seem to be a DOI, please try again.`)
    return;
  }
  showSpinner('Extracting references, please wait')
  try {
    const { pdf, xml } = await client.extractReferences(filename, doi)
    reloadApp({ pdf, xml })
  } catch (e) {
    //
  } finally {
    hideSpinner()
  }
}

function reloadApp({ xml, pdf }) {
  window.location.href = `${window.location.pathname}?pdf=${pdf}&xml=${xml}`;
}


/**
 * Given a Node in the XML, search and highlight its text content in the PDF Viewer
 * @param {Node} node 
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
  // start search
  await window.pdfViewer.search(searchTerms);
}

function documentLabel(fileData) {
  if (fileData.author) {
    return `${fileData.author}, ${fileData.title.substr(0, 25)}... (${fileData.date})`;
  }
  return fileData.id
}


/**
 * Populates the selectbox for file name and version
 */
async function populateFilesSelectbox() {

  // the selectboxes to populate
  const fileSelectbox = $('#select-doc')
  const versionSelectbox = $('#select-version')
  const diffSelectbox = $('#select-diff-version')

  // Fetch data from api
  const { files } = await client.getFileList();

  console.log('Loaded file data.');

  // Clear existing options
  fileSelectbox.innerHTML = versionSelectbox.innerHTML = '';

  // Populate file select box 
  files.forEach(fileData => {
    const option = document.createElement('option');
    option.value = fileData.id;
    option.text = documentLabel(fileData)
    fileSelectbox.appendChild(option);
  });

  // if we have no paths in the URL, stop here and just load the first entry
  if (!window.xmlPath || !window.pdfPath) {
    loadFilesFromSelectedId()
    return
  }

  // align selectboxes with url query params
  const fileData = files.find(file => file.pdf == pdfPath)
  if (fileData) {
    // select the filename
    fileSelectbox.selectedIndex = files.indexOf(fileData);
    
    // populate the version selectbox depending on the selected file
    if (fileData.versions) {
      fileData.versions.forEach((version) => {
        const option = document.createElement('option');
        option.value = version.path;
        option.text = version.label;
        versionSelectbox.appendChild(option);
        diffSelectbox.appendChild(option.cloneNode(true))
      })

      versionSelectbox.selectedIndex = fileData.versions.findIndex(version => version.path === xmlPath)
      diffSelectbox.selectedIndex = versionSelectbox.selectedIndex
    }
  }

  // listen for changes in the PDF selectbox
  function loadFilesFromSelectedId() {
    const selectedFile = files.find(file => file.id === fileSelectbox.value);
    const pdf = selectedFile.pdf;
    const xml = selectedFile.xml
    reloadApp({ xml, pdf })
  }
  fileSelectbox.addEventListener('change', loadFilesFromSelectedId);

  // listen for changes in the TEI version selectbox  
  function loadFilesFromSelectedVersion() {
    const selectedFile = files.find(file => file.id === fileSelectbox.value);
    const pdf = selectedFile.pdf;
    const xml = versionSelectbox.value
    reloadApp({ xml, pdf })
  }
  versionSelectbox.addEventListener('change', loadFilesFromSelectedVersion);

  // listen for changes in the diff version selectbox  
  async function loadDiff() {
    
    const xmlPath = diffSelectbox.value
    if (xmlPath !== versionSelectbox.value) {
      showSpinner('Computing file differences, please wait...')
      xmlEditor.showMergeView(xmlPath)
      hideSpinner()
    } else {
      loadFilesFromSelectedId()
    }
  }
  diffSelectbox.addEventListener('change', loadDiff);
}

/**
 * Triggers a validation of the document (or waits for an ongoing one to finish), and saves the document
 * if validation was successful
 * @param {StorageManager} filePath 
 * @returns {Promise<void>}
 */
async function validateAndSave(filePath) {
  let diagnostics = await xmlEditor.validateXml()
  if (diagnostics.length) {
    showMessage("There are validation errors in the document. The document has not been saved. Correct and try again.", "Validation Errors")
    return diagnostics;
  }
  console.log("Saving XML on server...");
  await client.saveXml(xmlEditor.getXML(), filePath)
}

/**
 * Populates the selectbox for the xpath expressions that control the navigation within the xml document
 */
async function populateXpathSelectbox() {
  const selectbox = $('#select-xpath');
  try {
    const data = [
      {
        "xpath": "//tei:biblStruct",
        "label": "<biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[@status='verified']",
        "label": "Verified <biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[not(@status='verified')]",
        "label": "Unverified <biblStruct>"
      },
      {
        "xpath": "//tei:biblStruct[@status='unresolved']",
        "label": "Unresolved <biblStruct>"
      },      
      {
        "xpath": null,
        "label": "Custom XPath"
      }
    ];

    // Clear existing options
    selectbox.innerHTML = '';

    // Populate select box with options
    data.forEach(item => {
      const option = document.createElement('option');
      option.value = item.xpath || ''
      option.text = item.label
      option.disabled = item.xpath === null
      selectbox.appendChild(option);
    });

    // button to edit the xpath manually
    $('#btn-edit-xpath').addEventListener('click', () => {
      const custom = selectbox[selectbox.length - 1]
      const xpath = prompt("Enter custom xpath", custom.value)
      if (xpath && xpath.trim()) {
        custom.value = xpath
        custom.text = `Custom: ${xpath}`
        selectbox.selectedIndex = selectbox.length - 1
      }
    })

    // listen for changes in the selectbox
    selectbox.addEventListener('change', () => {
      // this triggers the selection via the window's `hashchange` event
      UrlHash.set("xpath", selectbox.value)
    });

    // update selectbox according to the URL hash
    window.addEventListener('hashchange', setSelectionXpathFromUrl);

    // setup click handlers
    $('#btn-prev-node').addEventListener('click', () => previousNode());
    $('#btn-next-node').addEventListener('click', () => nextNode());

  } catch (error) {
    console.error('Error populating xpath selectbox:', error);
  }
}

/**
 * Reads the selection xpath from the URL. If no is given, takes it from the selectbox value
 */
function setSelectionXpathFromUrl() {
  const xpath = UrlHash.get("xpath");
  if (xpath) {
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
  const xpathHasChanged = currentXpath !== xpath
  const size = getXpathResultSize(xpath)
  if (xpathHasChanged) {
    currentXpath = xpath
    console.log("Setting xpath", xpath)
    updateIndexUI(index, size)
  }

  // select the first node
  if (size > 0 && (index !== currentIndex || xpathHasChanged)) {
    selectByIndex(index)
  } 
}

function updateIndexUI(index, size) {
  $('#selection-index').textContent = `(${size > 0 ? index : 0}/${size})`
  $('#btn-next-node').disabled = $('#btn-prev-node').disabled = size < 2;
}

function getSelectionXpath() {
  return currentXpath || $('#select-xpath').value;
}

function xpathInfo(xpath) {
  const xpathRegex = /^(.*?\/)?(?:(\w+):)?(\w+)(.*)?$/;
  const match = xpath.match(xpathRegex);
  if (match) {
    return {
      prefix: match[1] || "",  // Everything before the final tag name (or empty string)
      namespace: match[2] || "", // Namespace (e.g., "tei") or empty string
      tagName: match[3],      // Tag name (e.g., "biblStruct")
      attributes: match[4] || ""   // Attribute selectors (e.g., "[@status='verified']") or empty string
    };
  } else {
    return null;  // Indicate no match
  }
}

function getXpathResultSize(xpath) {
  return window.xmlEditor.countDomNodesByXpath(xpath)
}

function getSelectionXpathResultSize() {
  return getXpathResultSize(getSelectionXpath())
}

/**
 * Selects the node identified by the xpath in the select box and the given index
 * @param {number} index 1-based index
 * @returns {void}
 */
function selectByIndex(index) {
  // Wait for editor to be ready
  if (!xmlEditor.isReady()) {
    console.warn("Editor not ready, deferring selection")
    xmlEditor.addEventListener(XMLEditor.EVENT_XML_CHANGED, () => {
      console.warn("Editor is now ready")
      selectByIndex(index)
    }, { once: true })
    return;
  }

  // check if selection is within bounds
  const xpath = getSelectionXpath()
  const size = getXpathResultSize(xpath)
  if (index > size || size === 0 || index < 1) {
    throw new Error(`Index out of bounds: ${index} of ${size} items`);
  }
  updateIndexUI(index, size)
  currentIndex = index;
  const xpathWithIndex = `${xpath}[${currentIndex}]`

  try {
    window.xmlEditor.selectByXpath(xpathWithIndex);
    UrlHash.set('xpath', xpathWithIndex)
  } catch (error) {
    // this sometimes fails for unknown reasons
    console.warn(error.message)
  }
}

/**
 * Selects the next node matching the current xpath 
 */
function nextNode() {
  if (currentIndex < getSelectionXpathResultSize()) {
    currentIndex++;
  }
  selectByIndex(currentIndex);
}

/**
 * Selects the previous node matching the current xpath 
 */
function previousNode() {
  if (currentIndex > 1) {
    currentIndex--;
  }
  selectByIndex(currentIndex);
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

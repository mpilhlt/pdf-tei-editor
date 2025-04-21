import { XMLEditor } from './xmleditor.js'
import { PDFJSViewer } from './pdfviewer.js'
import *  as client from './client.js'
import { $, $$, UrlHash, showMessage, addBringToForegroundListener, makeDraggable } from './browser-utils.js'
import { uploadFile } from './upload.js'
import { disableValidation, validationEvents } from './lint.js'
import { isDoi } from './utils.js'

// custom elements
import '../web/spinner.js'
import '../web/switch.js'
import '../web/list-editor.js'

/**
 * The XML editor
 * @type {XMLEditor}
 */
let xmlEditor = null;

/**
 * The XML editor
 * @type {PDFJSViewer}
 */
let pdfViewer = null;

/**
 * The last selected node, can be null
 * @type {Node?}
 */
let lastSelectedXpathlNode = null;

// the path from which to load the autocompletion data
const tagDataPath = '/data/tei.json'

// the index of the currently selected node, 1-based
let currentIndex = null;

// the current xpath used for selection
let selectionXpath = null;

// the xpath of the cursor within the xml document
let lastCursorXpath = null;

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
  const diffXmlPath = window.diffXmlPath = urlParams.get('diff');

  console.log(`Starting Application\nPDF: ${pdfPath}\nXML: ${xmlPath}`);

  // disable regular validation so that we have more control over it
  disableValidation(true)

  // wait for UI to be fully set up
  try {
    await Promise.all([
      pdfPath ? loadPdfViewer(pdfPath) : null,
      xmlPath ? loadXmlEditor(xmlPath, tagDataPath) : null,
      setupUI()
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
    onHashChange()

    // measure how long it takes to validate the document
    const startTime = new Date().getTime();
    validateXml().then(() => {
      const endTime = new Date().getTime();
      const seconds = Math.round((endTime - startTime) / 1000);
      // disable validation if it took longer than 3 seconds
      console.log(`Validation took ${seconds} seconds${seconds > 3 ? ", disabling it." : "."}`)
      disableValidation(seconds > 3)
    })

    xmlEditor.addEventListener(XMLEditor.EVENT_XML_CHANGED, async () => {
      $('#btn-save-document').text('Save').enable()
    })
  }

  // load & save prompt data
  client.loadInstructions().then(data => {
    const promptEditor = $('#prompt-editor');
    promptEditor.data = data;
    promptEditor.addEventListener('data-changed', evt => {
      client.saveInstructions(evt.detail)
    })
    $('#btn-edit-prompt').enable()
  })

  // finish initialization
  hideSpinner()
  $('#document-nav').show()
  $('#btn-save-document').enable()
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


/**
 * Code to configure the initial state of the UI
 */
async function setupUI() {

  await Promise.all([
    populateFilesSelectboxes(),
    populateXpathSelectbox()
  ])

  // when everything is configured, we can show the UI
  $('#navigation').show()

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener(['#navigation', '.cm-panels']);

  // make navigation draggable
  makeDraggable($('#navigation'))

  // configure "status" buttons
  $$('.btn-node-status').forEach(btn => btn.addEventListener('click', evt => setNodeStatus(evt.target.dataset.status)))

  // allow to input node index
  $('#selection-index').addEventListener('click', onClickSelectionIndex)

  // load new document
  $('#btn-load-document').addEventListener('click', onClickLoadDocument)

  // extract from current PDF
  $('#btn-extract').addEventListener('click', onClickExtractBtn)

  // validate xml
  const validateBtn = $('#btn-validate-document')
  validateBtn.addEventListener('click', onClickValidateButton);
  validationEvents.addEventListener(validationEvents.EVENT.START, () => {
    validateBtn.innerHTML = "Validating XML..."
    validateBtn.disable();
  })
  validationEvents.addEventListener(validationEvents.EVENT.END, () => {
    validateBtn.innerHTML = "Validate"
    validateBtn.enable();
  })

  // save current version
  $('#btn-save-document').addEventListener('click', onClickSaveButton);

  // auto-search switch
  $('#switch-auto-search').addEventListener('change', onAutoSearchSwitchChange)

  // edit prompt
  $('#btn-edit-prompt').addEventListener('click', () => $('#dlg-prompt-editor').showModal())
  $('#prompt-editor').addEventListener('close', () => $('#dlg-prompt-editor').close())

  // cleanup
  $('#btn-cleanup').addEventListener('click', onClickBtnCleanup)
  $('#btn-cleanup').disabled = $('#select-version').options.length < 2

}

/**
 * Handles change of selection in the document
 * @param {Array} ranges An array of object of the form {to, from, node}
 * @returns 
 */
async function handleSelectionChange(ranges) {
  if (ranges.length === 0 || !xmlEditor.getXmlTree()) return;

  // we care only for the first selected node or node parent matching our xpath
  const xpathTagName = xpathInfo(getSelectionXpath()).tagName
  const range = ranges[0]

  /** @type {Node} */
  let selectedNode = range.node;
  if (!selectedNode) {
    lastSelectedXpathlNode = null;
    lastCursorXpath = null;
    return;
  }

  // find parent if tagname doesn't match
  while (selectedNode) {
    if (selectedNode.tagName === xpathTagName) break;
    selectedNode = selectedNode.parentNode
  }

  // update the buttons
  $$('.btn-node-status').forEach(btn => btn.disabled = !Boolean(selectedNode))

  // the xpath of the current cursor position
  const newCursorXpath = selectedNode && xmlEditor.getXPathForNode(selectedNode)

  // do nothing if we cannot find a matching parent, or the parent is the same as before
  if (!selectedNode || lastSelectedXpathlNode === selectedNode || newCursorXpath === lastCursorXpath) {
    return;
  }

  // remember new (parent) node
  lastSelectedXpathlNode = selectedNode;
  lastCursorXpath = newCursorXpath

  // update URL
  const { basename } = xpathInfo(lastCursorXpath)
  UrlHash.set("xpath", `//tei:${basename}`) // the xpath from the DOM does not have a prefix

  // trigger auto-search if enabled
  const autoSearchSwitch = $('#switch-auto-search')
  if (pdfViewer && autoSearchSwitch.checked) {
    await searchNodeContentsInPdf(selectedNode)
  }
}

/**
 * Sets the status attribute of the last selected node, or removes it if the status is empty
 * @param {string} status The new status, can be "verified", "unresolved", "comment" or ""
 * @returns {Promise<void>}
 * @throws {Error} If the status is not one of the allowed values
 */
async function setNodeStatus(status) {
  if (!lastSelectedXpathlNode) {
    return
  }
  // update XML document from editor content
  xmlEditor.updateNodeFromEditor(lastSelectedXpathlNode)

  // set/remove the status attribute
  switch (status) {
    case "":
      lastSelectedXpathlNode.removeAttribute("status")
      break;
    case "comment":
      throw new Error("Commenting not implemented yet")
      // const comment = prompt(`Please enter the comment to store in the ${lastSelectedXpathlNode.tagName} node`)
      // if (!comment) {
      //   return
      // }
      // const commentNode = xmlEditor.getXmlTree().createComment(comment)
      // const firstElementNode = Array.from(lastSelectedXpathlNode.childNodes).find(node => node.nodeType === Node.ELEMENT_NODE)
      // const insertBeforeNode = firstElementNode || lastSelectedXpathlNode.firstChild || lastSelectedXpathlNode
      // if (insertBeforeNode.previousSibling && insertBeforeNode.previousSibling.nodeType === Node.TEXT_NODE) {
      //   // indentation text
      //   lastSelectedXpathlNode.insertBefore(insertBeforeNode.previousSibling.cloneNode(), insertBeforeNode)
      // } 
      // lastSelectedXpathlNode.insertBefore(commentNode, insertBeforeNode.previousSibling)
      break;
    default:
      lastSelectedXpathlNode.setAttribute("status", status)
  }
  // update the editor content
  await xmlEditor.updateEditorFromNode(lastSelectedXpathlNode)

  // reselect the current node when done
  selectByIndex(currentIndex)
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

async function onClickValidateButton() {
  $('#btn-validate-document').disable()
  await validateXml()
}

async function onClickSaveButton() {
  const xmlPath = $('#select-version').value;
  await saveXml(xmlPath)
  $('#btn-save-document').text('Saved').disable()
}

async function onClickExtractBtn() {
  const pdfPath = $('#select-doc').value;
  const fileData = (await client.getFileList()).files.find(file => file.id === pdfPath)
  if (!fileData) {
    alert("No file selected")
    return
  }
  let doi;
  try {
    doi = getDoiFromXml()
  } catch (error) {
    console.warn(error.message)
  }
  extractFromPDF(fileData.pdf, doi)
}

async function onAutoSearchSwitchChange(evt) {
  const checked = evt.detail.checked
  console.log(`Auto search is: ${checked}`)
  if (checked) {
    await searchNodeContentsInPdf(lastSelectedXpathlNode)
  }
}

async function onClickBtnCleanup() {
  const msg = "Are you sure you want to clean up the extraction history? This will delete all versions of this document and leave only the current gold standard version."
  if (!confirm(msg)) return;
  const options = Array.from($('#select-version').options)
  const filePathsToDelete = options
    .slice(1) // skip the first option, which is the gold standard version  
    .map(option => option.value)
  if (filePathsToDelete.length > 0) {  
    await client.deleteFiles(filePathsToDelete)
  }
  xmlPath = options[0].value
  reloadApp({ xml: xmlPath, pdf: pdfPath })
}

function getDoiFromXml() {
  return xmlEditor.getDomNodeByXpath("//tei:teiHeader//tei:idno[@type='DOI']")?.textContent
}

async function extractFromPDF(filename, doi = "") {
  if (doi === "") {
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
      // user cancelled
      return;
    } else if (!isDoi(doi)) {
      alert(`${doi} does not seem to be a DOI, please try again.`)
      return
    }
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
async function populateFilesSelectboxes() {

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

      // set the version of the selectbox to the URL 
      versionSelectbox.selectedIndex = fileData.versions.findIndex(version => version.path === xmlPath)

      // set the diff selectbox to the URL value, if given
      if (UrlHash.get("diff")) {
        const diffIndex = fileData.versions.findIndex(version => version.path === UrlHash.get("diff"))
        if (diffIndex) {
          // trigger the diff mode with a timeout
          setTimeout(() => { diffSelectbox.selectedIndex = diffIndex; loadDiff() }, 1000)
        }
      }
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
    const diffXmlPath = diffSelectbox.value
    if (UrlHash.get('diff') !== diffXmlPath) {
      UrlHash.set('diff', diffXmlPath)
    }
    if (diffXmlPath !== versionSelectbox.value) {
      showSpinner('Computing file differences, please wait...')
      await xmlEditor.showMergeView(diffXmlPath)
      hideSpinner()
    } else {
      loadFilesFromSelectedId()
    }
  }
  diffSelectbox.addEventListener('change', loadDiff);
}

async function validateXml() {
  console.log("Validating XML...")
  await xmlEditor.validateXml()
}

/**
 * Triggers a validation of the document (or waits for an ongoing one to finish), and saves the document
 * if validation was successful
 * @param {StorageManager} filePath 
 * @returns {Promise<void>}
 */
async function saveXml(filePath) {
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
    window.addEventListener('hashchange', onHashChange);

    // setup click handlers
    $('#btn-prev-node').addEventListener('click', () => previousNode());
    $('#btn-next-node').addEventListener('click', () => nextNode());

  } catch (error) {
    console.error('Error populating xpath selectbox:', error);
  }
}

/**
 * Calls when the URL hash values change. Handles selection xpath and diff xml path
 */
function onHashChange() {
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

function updateIndexUI(index, size) {
  $('#selection-index').textContent = `(${size > 0 ? index : 0}/${size})`
  $('#btn-next-node').disabled = $('#btn-prev-node').disabled = size < 2;
}

function getSelectionXpath() {
  return selectionXpath || $('#select-xpath').value;
}

function xpathInfo(xpath) {
  if (!xpath) {
    throw new Error("No xpath given")
  }
  const xpathRegex = /^(?:(\w+):)?(\w+)(.*)?$/;
  const basename = xpath.split("/").pop()
  const match = basename.match(xpathRegex);
  const parentPath = xpath.slice(0, xpath.length - basename.length)  // Everything before the final tag name (or empty string)
  const prefix = match[1] || "" // Namespace prefix (e.g., "tei") or empty string
  const tagName = match[2]  // Tag name (e.g., "biblStruct")
  const attributeSelectors = match[3] || "" // Attribute selectors (e.g., "[@status='verified']") or empty string

  if (match) {
    return { parentPath, prefix, tagName, attributeSelectors, basename };
  } else {
    return null;  // Indicate no match
  }
}

function getXpathResultSize(xpath) {
  return xmlEditor.countDomNodesByXpath(xpath)
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
    console.log("Editor not ready, deferring selection")
    xmlEditor.addEventListener(XMLEditor.EVENT_XML_CHANGED, () => {
      console.log("Editor is now ready")
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

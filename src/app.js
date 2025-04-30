// sorry for this horrible mess, this code will be refactored when I have a bit more time!

import { XMLEditor } from './xmleditor.js'
import { PDFJSViewer } from './pdfviewer.js'
import *  as client from './client.js'
import { $, $$, UrlHash, showMessage, addBringToForegroundListener, makeDraggable } from './browser-utils.js'
import { uploadFile } from './upload.js'
import { disableValidation, validationEvents } from './lint.js'
import { isDoi } from './utils.js'
//import { UiState } from './appstate.js'

// custom elements
import '../web/spinner.js'
import '../web/switch.js'
import '../web/list-editor.js'
import { diff } from '@codemirror/merge'

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
 * The data about the pdf and xml files on the server
 */
let fileData = null;

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

const spinner = $('#spinner')

// get document paths from URL hash - are the global vars needed?
let pdfPath = window.pdfPath = UrlHash.get('pdf');
let xmlPath = window.xmlPath = UrlHash.get('xml');
let diffXmlPath = window.diffXmlPath = UrlHash.get('diff');

// UI elements
const fileSelectbox = $('#select-doc')
const versionSelectbox = $('#select-version')
const diffSelectbox = $('#select-diff-version')

// run main app
try {
  main()
} catch (error) {
  console.error(error)
}

/**
 * The main application
 */
async function main() {

  //const appState = new ApplicationState()

  spinner.show('Loading documents, please wait...')

  console.log(`Starting Application\nPDF: ${pdfPath}\nXML: ${xmlPath}`);

  // disable regular validation so that we have more control over it
  disableValidation(true)

  // wait for UI to be fully set up

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

  try {

    // Fetch file data from api
    await reloadFileData()

    if (!fileData || fileData.length === 0) {
      throw new Error("No files found")
    }

    // select default files
    pdfPath = pdfPath || fileData[0].pdf
    xmlPath = xmlPath || fileData[0].xml
    diffXmlPath = diffXmlPath || fileData[0].xml

    // setup the UI
    setupUI()
    await Promise.all([
      loadPdfViewer(pdfPath),
      loadXmlEditor(xmlPath, tagDataPath),
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

    if (diffXmlPath !== xmlPath) {
      // load the diff view
      try {
        await showMergeView(diffXmlPath)
      } catch (error) {
        console.error("Error loading diff view:", error)
      }
    } else {
      // measure how long it takes to validate the document
      const startTime = new Date().getTime();
      validateXml().then(() => {
        const endTime = new Date().getTime();
        const seconds = Math.round((endTime - startTime) / 1000);
        // disable validation if it took longer than 3 seconds
        console.log(`Validation took ${seconds} seconds${seconds > 3 ? ", disabling it." : "."}`)
        disableValidation(seconds > 3)
      })
    }

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
  spinner.hide()
  $('#document-nav').show()
  $('#btn-save-document').enable()
  console.log("Application ready.")
}


async function reloadFileData() {
  const { files } = await client.getFileList();
  fileData = files
}

// Populates the selectbox for file name and version
function populateFilesSelectboxes() {

  // Clear existing options
  fileSelectbox.innerHTML = versionSelectbox.innerHTML = diffSelectbox.innerHTML = '';

  // Populate file select box 
  fileData.forEach(file => {
    const option = document.createElement('option');
    option.value = file.id;
    option.text = file.label
    if (file.pdf === pdfPath) {
      option.selected = true
      // populate the version and diff selectboxes depending on the selected file
      if (file.versions) {
        file.versions.forEach((version) => {
          const option = document.createElement('option');
          option.value = version.path;
          option.text = version.label;
          option.selected = (version.path === xmlPath)
          versionSelectbox.appendChild(option);
          const diffOption = option.cloneNode(true)
          diffOption.selected = (diffOption.value === diffXmlPath)
          diffSelectbox.appendChild(diffOption)
        })
      }
    }
    fileSelectbox.appendChild(option);
  });

}

// Populates the selectbox for the xpath expressions that 
// control the navigation within the xml document
function populateXpathSelectbox() {
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

  } catch (error) {
    console.error('Error populating xpath selectbox:', error);
  }
}

/**
 * Code to configure the initial state of the UI
 */
function setupUI() {

  // populate the selectboxes and setup change handlers
  populateXpathSelectbox()
  populateFilesSelectboxes()

  fileSelectbox.addEventListener('change', onChangePdfSelectbox);
  versionSelectbox.addEventListener('change', onChangeVersionSelectbox);
  diffSelectbox.addEventListener('change', onChangeDiffSelectbox);

  // update selectbox according to the URL hash
  window.addEventListener('hashchange', onHashChange);

  // setup click handlers
  $('#btn-prev-node').click(() => previousNode());
  $('#btn-next-node').click(() => nextNode());
  $('#btn-prev-diff').click(() => xmlEditor.goToPreviousDiff())
  $('#btn-next-diff').click(() => xmlEditor.goToNextDiff())
  $('#btn-diff-keep-all').click(() => {
    xmlEditor.rejectAllDiffs()
    removeMergeView()
  })
  $('#btn-diff-change-all').click(() => {
    xmlEditor.acceptAllDiffs()
    removeMergeView()
  })

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener(['#navigation', '.cm-panels']);

  // make navigation draggable
  makeDraggable($('#navigation'))

  // configure "status" buttons
  $$('.btn-node-status').forEach(btn => btn.addEventListener('click', evt => setNodeStatus(evt.target.dataset.status)))

  // allow to input node index
  $('#selection-index').addEventListener('click', onClickSelectionIndex)

  // when everything is configured, we can show the navigation
  $('#navigation').show()

  //
  // Document commands toolbar
  //

  // load new document
  $('#btn-load-document').addEventListener('click', onClickLoadDocument)

  // extract from current PDF
  $('#btn-extract').addEventListener('click', onClickExtractBtn)

  // validate xml button
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

  //
  // UI event handlers
  // 

  // listen for changes in the PDF selectbox
  async function onChangePdfSelectbox() {
    const selectedFile = fileData.find(file => file.id === fileSelectbox.value);
    const pdf = selectedFile.pdf
    const xml = selectedFile.xml
    const filesToLoad = {}

    if (pdf && pdf !== pdfPath) {
      filesToLoad.pdf = pdf
    }
    if (xml && xml !== xmlPath) {
      filesToLoad.xml = xml
    }

    if (Object.keys(filesToLoad).length > 0) {
      try {
        await load(filesToLoad)
      }
      catch (error) {
        console.error(error)
      }
    }
  }


  // listen for changes in the version selectbox  
  async function onChangeVersionSelectbox() {
    const xml = versionSelectbox.value
    if (xml !== xmlPath) {
      try {
        await load({ xml })
      } catch (error) {
        console.error(error)
      }
    }
  }  

  // listen for changes in the diff version selectbox  
  async function onChangeDiffSelectbox() {
    const diff = diffSelectbox.value
    const isDiff = diff && diff !== xmlPath
    if (isDiff) {
      try {
        await showMergeView(diff)
      } catch (error) {
        console.error(error)
      }
    } else {
      removeMergeView()
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
          try {
            const doi = getDoiFromFilenameOrUserInput(filename)
            const { xml, pdf } = await extractFromPDF(filename, doi)
            await load({ xml, pdf })
          } catch (error) {
            console.error(error)
          }

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
    const filename = fileData.pdf
    try {
      doi = doi || getDoiFromFilenameOrUserInput(filename)
      let { xml, pdf } = await extractFromPDF(filename, doi)
      let diff = xml
      await reloadFileData()
      await load({ pdf })
      await showMergeView(diff)
    } catch (error) {
      console.error(error)
    }
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
    try {
      await reloadFileData()
      populateFilesSelectboxes()
      await load({ xml: xmlPath, pdf: pdfPath })
    } catch (error) {
      console.error(error)
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
}

//
// commands
// 

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
    promises.push(pdfViewer.load(pdf))
  }

  // XML
  if (xml) {
    console.log("Loading XML", xml)
    promises.push(xmlEditor.loadXml(xml))
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
  await xmlEditor.validateXml()
}

/**
 * Saves the current XML content to the server
 * @param {string} filePath The path to the XML file
 * @returns {Promise<void>}
 */
async function saveXml(filePath) {
  console.log("Saving XML on server...");
  await client.saveXml(xmlEditor.getXML(), filePath)
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
  spinner.show('Extracting references, please wait')
  try {
    let result = await client.extractReferences(filename, doi)
    // reload the file selectboxes
    await reloadFileData()
    populateFilesSelectboxes()
    return result
  } finally {
    spinner.hide()
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

async function showMergeView(diff) {  
  console.log("Loading diff XML", diff)
  spinner.show('Computing file differences, please wait...')
  try {
    await xmlEditor.showMergeView(diff)
  } finally {
    spinner.hide()
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
// get info about state or documents
// 

function getDoiFromXml() {
  return xmlEditor.getDomNodeByXpath("//tei:teiHeader//tei:idno[@type='DOI']")?.textContent
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
    alert(`${doi} does not seem to be a DOI, please try again.`)
    throw new Error("Invalid DOI")
  }
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

function getSelectionXpath() {
  return selectionXpath || $('#select-xpath').value;
}


function getXpathResultSize(xpath) {
  try {
    return xmlEditor.countDomNodesByXpath(xpath)
  } catch (e) {
    return 0
  }

}


function getSelectionXpathResultSize() {
  return getXpathResultSize(getSelectionXpath())
}

//
// navigation
//

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

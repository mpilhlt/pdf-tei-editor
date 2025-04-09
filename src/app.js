import { XMLEditor } from './xmleditor.js'
import { PDFJSViewer } from './pdfviewer.js'
import { $, addBringToForegroundListener, makeDraggable } from './utils.js'
import { getFileList, saveDocument } from './client.js'
import { xml } from '@codemirror/lang-xml'
import { UrlHash } from './browser-utils.js'

// the last selected node, can be null
let lastSelectedXmlNode = null;
// the index of the currently selected node, 1-based
let currentIndex = 1;

try {
  main()
} catch (error) {
  console.error(error)
}

export async function main() {

  // get info from URL 
  const urlParams = new URLSearchParams(window.location.search);
  const pdfPath = window.pdfPath = urlParams.get('pdf');
  const xmlPath = window.xmlPath = urlParams.get('xml');

  let tagData;
  try {
    const res = await fetch('/data/tei.json');
    tagData = await res.json();
    console.log("Loaded autocompletion data");
  } catch (error) {
    console.error('Error fetching JSON:', error);
  }

  const pdfViewer = window.pdfViewer = new PDFJSViewer('pdf-viewer', pdfPath).hide();
  const xmlEditor = window.xmlEditor = new XMLEditor('xml-editor', tagData, 'biblStruct');

  if (pdfPath && xmlPath) {

    console.log(`PDF: ${pdfPath}\nXML: ${xmlPath}`);

    // XML Editor
    console.log("Loading XML data...");
    xmlEditor.loadXml(xmlPath).then(() => {
      console.log("Validating XML data with TEI XSD...");
      xmlEditor.validateXml(); // no way of knowing when this is finished at the moment
      setSelectionPathFromUrl()
    });

    // PDF
    pdfViewer.load(pdfPath).then(() => pdfViewer.show());

    // handle selection change
    xmlEditor.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, event => {
      handleSelectionChange(event.detail)
    });

    // configure "verification" button
    $('#btn-node-status').addEventListener('click', handleStatusUpdate)
  }

  // configure navigation UI
  Promise.all([
    populateFilesSelectbox(), 
    populateXpathSelectbox()
  ]).then(() => {
    $('#navigation').show()
  })

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener(['#navigation', '.cm-panels']);

  // make navigation draggable
  makeDraggable($('#navigation'))

}

// ==========================================================================================
//
// helper functions
//
// ==========================================================================================

async function handleSelectionChange(ranges) {

  if (ranges.length === 0) return;

  // we care only for the first selected node
  const range = ranges[0]
  const selectedNode = range.node;
  lastSelectedXmlNode = selectedNode;
  if (!selectedNode) return;

  // check status as "verified"
  const statusButton = $('#btn-node-status')
  const status = selectedNode.getAttribute('status');
  statusButton.disabled = false
  switch (status) {
    case "verified":
      statusButton.textContent = "Mark node as unverified"
      break;
    default:
      statusButton.textContent = "Mark node as verified"
  }

  // search node contents in the PDF

  // search terms must be more than three characters
  const searchTerms = getNodeText(selectedNode).filter(term => term.length > 3);
  // for maximum 10 search terms 
  if (searchTerms.length < 10) {
    await window.pdfViewer.search(searchTerms);
  }
}

function handleStatusUpdate() {
  if (lastSelectedXmlNode) {
    const status = lastSelectedXmlNode.getAttribute('status');
    switch (status) {
      case "verified":
        lastSelectedXmlNode.removeAttribute("status")
        break;
      default:
        lastSelectedXmlNode.setAttribute("status", "verified")
    }
    // update the editor content
    window.xmlEditor.updateFromXmlTree()
    selectByIndex(currentIndex)
  }
}

function documentLabel(fileData) {
  return `${fileData.author}, ${fileData.title.substr(0, 25)}... (${fileData.date})`;
}

async function populateFilesSelectbox() {
  const selectbox = $('#select-doc');
  try {
    // Fetch data from api
    const { files } = await getFileList();

    // Clear existing options
    selectbox.innerHTML = '';

    // Populate select box with options
    files.forEach(fileData => {
      const option = document.createElement('option');
      option.value = fileData.id;
      option.text = documentLabel(fileData)
      selectbox.appendChild(option);
    });

    console.log('Loaded file data.');

    function loadFilesFromSelectedId() {
      const selectedFile = files.find(file => file.id === selectbox.value);
      const pdf = selectedFile.pdf;
      const xml = selectedFile.xml;
      window.location.href = `${window.location.pathname}?pdf=${pdf}&xml=${xml}`;
    }
    // listen for changes in the selectbox
    selectbox.addEventListener('change', loadFilesFromSelectedId);

    if (!window.xmlPath || !window.pdfPath) {
      // if no query params, load the first entry 
      loadFilesFromSelectedId(files)
    } else {
      // otherwise align selection with url
      const fileFromUrl = files.find(file => file.pdf == pdfPath)
      if (fileFromUrl) {
        selectbox.selectedIndex = files.indexOf(fileFromUrl);
      }
    }

    // configure save button
    $('#btn-save-document').addEventListener('click', async () => {
      const fileData = files[selectbox.selectedIndex];
      if (confirm(`Do you want to save ${documentLabel(fileData)}?`)) {
        await saveDocument(xmlEditor.getXml(), fileData.xml)
      }
    });

  } catch (error) {
    console.error('Error populating files selectbox:', error);
  }
}

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
    window.addEventListener('hashchange', setSelectionPathFromUrl);

    // setup click handlers
    $('#btn-prev-node').addEventListener('click', () => previousNode());
    $('#btn-next-node').addEventListener('click', () => nextNode());

  } catch (error) {
    console.error('Error populating xpath selectbox:', error);
  }
}

function setSelectionPathFromUrl() {
  const xpath = UrlHash.get("xpath");
  if (xpath) {
    setSelectionXpath(xpath)
  } else {
    setSelectionXpath(getSelectionXpath())
  }
}

function setSelectionXpath(xpath) {
  console.log("Setting xpath", xpath)
  const selectbox = $('#select-xpath');
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

  // select the first node
  selectByIndex(1)
}

function getSelectionXpath() {
  return $('#select-xpath').value;
}

function getSelectionXpathResultSize() {
  const xpath = getSelectionXpath()
  const count = window.xmlEditor.countDomNodesByXpath(xpath)
  console.log("Selected xpath result nodes", xpath, count)
  return count
}

/**
 * Selects the node identified by the xpath in the select box and the current index
 * @param {number} index 1-based index
 * @returns {void}
 */
function selectByIndex(index) {
  const size = getSelectionXpathResultSize()

  // disable navigation if we have no or just one result
  $('#btn-next-node').disabled = $('#btn-prev-node').disabled = size < 2;
  
  // check if selection is within bounds
  if (index < 1 || index > size || size === 0) {
    console.warn(`Index out of bounds: ${index} of ${size} items`);
    index = 1
  }
  currentIndex = index;
  let xpath = getSelectionXpath()

  // if the xpath already has a final index, override our own
  const m = xpath.match(/(.+?)\[(\d+)\]$/)
  if (m) {
    xpath = m[1]
    currentIndex = parseInt(m[1])
  }

  try {
    window.xmlEditor.selectByXpath(`${xpath}[${currentIndex}]`);
  } catch (error) {
    // this sometimes fails for unknown reasons
    console.warn(error.message)
  }
}

/**
 * Highlights the next node in the `nodes` array.
 *  Moves to the next index and updates the highlight.
 */
function nextNode() {
  if (currentIndex < getSelectionXpathResultSize()) {
    currentIndex++;
  }
  selectByIndex(currentIndex);
}

/**
 * Highlights the previous node in the `nodes` array.
 *  Moves to the previous index and updates the highlight.
 */
function previousNode() {
  if (currentIndex > 1) {
    currentIndex--;
  }
  selectByIndex(currentIndex);
}


/**
 * extract the text from text nodes
 */
function getNodeText(node) {
  return getTextNodes(node).map(node => node.textContent.trim()).filter(Boolean)
}

/**
 * Recursively extract all text nodes contained in the given node into a flat list
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

function addIds() {
  console.log(`Adding xml:id to each record of type ${this.recordTag}`);
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xml, "application/xml");
  this.nodes = Array.from(xmlDoc.getElementsByTagName(this.recordTag));
  for (let [idx, node] of this.nodes.entries()) {
    if (!node.hasAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:id")) {
      node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:id", `biblStruct${idx}`)
    }
  }
  xml = (new XMLSerializer()).serializeToString(xmlDoc)
}
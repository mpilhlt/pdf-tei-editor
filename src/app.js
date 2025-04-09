import { XMLEditor } from './xmleditor.js'
import { PDFJSViewer } from './pdfviewer.js'
import { $, addBringToForegroundListener, makeDraggable } from './utils.js'
import { get_file_list, saveDocument } from './client.js'
import { xml } from '@codemirror/lang-xml'

let lastSelectedXmlNode = null;

try {
  main()
} catch (error) {
  console.error(error)
}

export async function main() {

  // get info from URL 
  const urlParams = new URLSearchParams(window.location.search);
  const pdfPath = urlParams.get('pdf');
  const xmlPath = urlParams.get('xml');

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
      nextNode();
    });

    // PDF
    pdfViewer.load(pdfPath).then(() => pdfViewer.show());

    // start in edit mode
    //$('editor-switch').checked = true;

    // setup navigation
    $('#btn-prev-node').addEventListener('click', () => previousNode());
    $('#btn-next-node').addEventListener('click', () => nextNode());

    // handle selection change
    xmlEditor.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, event => {
      handleSelectionChange(event.detail)
    });

    // configure "verification" button
    $('#btn-node-status').addEventListener('click', event => {
      const btn = event.target
      if (lastSelectedXmlNode) {
        const status = lastSelectedXmlNode.getAttribute('status');
        switch (status) {
          case "verified":
            lastSelectedXmlNode.removeAttribute("status")
            break;
          default:
            lastSelectedXmlNode.setAttribute("status", "verified")
        }
      } else {
        // if no status
        lastSelectedXmlNode.setAttribute("status", "verified")
      }
      // update the editor content
      window.xmlEditor.updateFromXmlTree()
    })

  } else {
    $('#btn-prev-node').hide()
    $('#btn-next-node').hide()
  }

  // configure file select box
  const selectBox = $('#select-doc');
  populateSelectBox(selectBox)
    .then(files => {
      function loadFilesFromSelectedId() {
        const selectedFile = files.find(file => file.id === selectBox.value);
        const pdf = selectedFile.pdf;
        const xml = selectedFile.xml;
        window.location.href = `${window.location.pathname}?pdf=${pdf}&xml=${xml}`;
      }
      // listen for changes in the selectbox
      selectBox.addEventListener('change', loadFilesFromSelectedId);

      if (!xmlPath || !pdfPath) {
        // if no query params, load the first entry 
        loadFilesFromSelectedId(files)
      } else {
        // otherwise align selection with url
        const fileFromUrl = files.find(file => file.pdf == pdfPath)
        if (fileFromUrl) {
          selectBox.selectedIndex = files.indexOf(fileFromUrl);
        }
      }

      // show navigation 
      $('#navigation').show()

      // configure save button
      $('#btn-save-document').addEventListener('click', async () => {
        const fileData = files[selectBox.selectedIndex];
        if (confirm(`Do you want to save ${documentLabel(fileData)}?`)) {
          await saveDocument(xmlEditor.getXml(), fileData.xml)
        }
      });
    });

  // read/edit switch
  //$('#editor-switch').addEventListener('change', handleEditorSwitch);

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

  console.log(ranges)

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

function documentLabel(fileData) {
  return `${fileData.author}, ${fileData.title.substr(0, 25)}... (${fileData.date})`;
}

async function populateSelectBox(selectBox) {
  try {
    // Fetch data from api
    const { files } = await get_file_list();
    // Clear existing options
    selectBox.innerHTML = '';

    // Populate select box with options
    files.forEach(fileData => {
      const option = document.createElement('option');
      option.value = fileData.id;
      option.text = documentLabel(fileData)
      selectBox.appendChild(option);
    });
    console.log('Loaded file data.')
    return files;

  } catch (error) {
    console.error('Error fetching data:', error);
  }
}

function handleEditorSwitch(event) {
  const checked = event.target.checked;
  if (checked) {
    console.log("Edit mode")
  } else {
    console.log("Read-only mode")
  }
}

// this needs to be put into its own class

// the index of the currently selected node
let currentIndex = 0;
// the type of node containing the basic dataset record item
const recordNodeTag = 'tei:biblStruct';

async function selectByIndex(index) {
  if (index < 0 || index >= window.xmlEditor.getXmlTree().getElementsByTagName("biblStruct").length) {
    console.error("Index out of bounds");
    return;
  }
  currentIndex = index;
  try {
    window.xmlEditor.selectByXpath(`//${recordNodeTag}[${currentIndex}]`);
  } catch (error) {
    // this sometimes fails for unknown reasons
    console.warn(error.message)
  }

}

/**
 * Highlights the next node in the `nodes` array.
 *  Moves to the next index and updates the highlight.
 */
async function nextNode() {
  if (currentIndex < window.xmlEditor.getXmlTree().getElementsByTagName("biblStruct").length - 1) {
    currentIndex++;
  }
  selectByIndex(currentIndex);
}

/**
 * Highlights the previous node in the `nodes` array.
 *  Moves to the previous index and updates the highlight.
 */
async function previousNode() {
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
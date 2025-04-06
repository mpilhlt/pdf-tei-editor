import { XMLEditor } from './xmleditor.js'
import { PDFJSViewer } from './pdfviewer.js'
import { $, $$, addBringToForegroundListener, makeDraggable } from './utils.js'
import { get_file_list } from './client.js'

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

  const pdfViewer = window.pdfViewer = new PDFJSViewer('pdf-viewer', pdfPath);
  const xmlEditor = window.xmlEditor = new XMLEditor('xml-editor', tagData, 'biblStruct');

  if (pdfPath && xmlPath) {

    console.log(`PDF: ${pdfPath}\nXML: ${xmlPath}`);

    // XML Editor
    xmlEditor.loadXml(xmlPath);

    // PDF
    pdfViewer.load(pdfPath).then(() => pdfViewer.show());

    // start in edit mode
    document.getElementById('editor-switch').checked = true;

    // setup UI
    $('#prev-bibl').addEventListener('click', () => xmlEditor.previousNode());
    $('#next-bibl').addEventListener('click', () => xmlEditor.nextNode());

    // when the selected biblStruct changes, show its source in the PDF
    xmlEditor.addEventListener(XMLEditor.EVENT_CURRENT_NODE_CHANGED, event => {
      handleBiblStructChange(pdfViewer, event.detail)
    });

    // highlight the first biblStruct
    xmlEditor.focusNodeByIndex(0);
  } else {
    document.getElementById('prev-bibl').style.display = 'none'
    document.getElementById('next-bibl').style.display = 'none'
  }

  // file select box
  const selectBox = document.getElementById('select-doc');
  populateSelectBox(selectBox).then(files => {
    function loadFilesFromSelectedId() {
      const selectedFile = files.find(file => file.id === selectBox.value);
      const pdf = selectedFile.pdf;
      const xml = selectedFile.xml;
      window.location.href = `${window.location.pathname}?pdf=${pdf}&xml=${xml}`;
    }
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
  });

  // read/edit switch
  document.getElementById('editor-switch').addEventListener('change', handleEditorSwitch);

  // bring clicked elements into foreground when clicked
  addBringToForegroundListener(['#navigation', '.cm-panels']);

  // make navigation draggable
  makeDraggable($('#navigation'))

  // helper functions

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

  async function handleBiblStructChange(pdfViewer, node) {
    console.log("BiblStruct changed", node);
    if (!node) {  
      return;
    }
    const searchTerms = getNodeText(node).filter(term => term.length > 2);
    const searchResult = await pdfViewer.search(searchTerms);
  }

  async function populateSelectBox(selectBox, filePath) {
    try {
      // Fetch data from api
      const {files} = await get_file_list();
      // Clear existing options
      selectBox.innerHTML = '';

      // Populate select box with options
      files.forEach(file => {
        const option = document.createElement('option');
        option.value = file.id;
        option.text = `${file.author}, ${file.title.substr(0,25)}... (${file.date})`;
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
}




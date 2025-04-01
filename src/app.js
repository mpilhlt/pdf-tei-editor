import { XMLEditor } from './xmleditor.js'
import { PDFJSViewer } from './pdfviewer.js'

try {
  main()
} catch(error) {
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

  const pdfViewer = new PDFJSViewer('pdfjs-viewer', pdfPath).hide();
  const xmlEditor = new XMLEditor('xml-editor', tagData).hide();

  if (pdfPath && xmlPath) {
    // PDF
    await pdfViewer.load();
    pdfViewer.show();

    // XML Editor
    await xmlEditor.loadXml(xmlPath)
    xmlEditor.show();

    // start in edit mode
    document.getElementById('editor-switch').checked = true;

    // Navigate using buttons
    document.getElementById('prev-bibl').addEventListener('click', () => xmlEditor.previousNode());
    document.getElementById('next-bibl').addEventListener('click', () => xmlEditor.nextNode());

    // // navigate using keys in read-only mode
    // document.addEventListener('keydown', (event) => {
    //     if (event.key === 'ArrowLeft') {
    //         xmlEditor.previousNode()
    //     } else if (event.key === 'ArrowRight') {
    //         xmlEditor.nextNode()
    //     }
    // });

    // when the selected biblStruct changes, show its source in the PDF
    xmlEditor.addEventListener(xmlEditor.EVENT_CURRENT_NODE_CHANGED, event => {
      handleBiblStructChange(pdfViewer, event.detail)
    });

    // highlight the first biblStruct
    xmlEditor.highlightNodeByIndex(0);
  } else {
    document.getElementById('prev-bibl').style.display = 'none'
    document.getElementById('next-bibl').style.display = 'none'
  }

  // populate select box and load first document 
  const selectBox = document.getElementById('select-doc');
  const files = await populateSelectBox(selectBox, '/data/files.json')

  function loadFilesFromSelectedId() {
    const selectedFile = files.find(file => file.id === selectBox.value);
    const pdf = selectedFile.pdf;
    const xml = selectedFile.xml;
    window.location.href = `${window.location.pathname}?pdf=${pdf}&xml=${xml}`;
  }

  // Add event listener to select box
  selectBox.addEventListener('change', loadFilesFromSelectedId);

  // toggle read/edit
  document.getElementById('editor-switch').addEventListener('change', handleEditorSwitch);

  // load the first entry if no query params
  if (!xmlPath || !pdfPath) {
    loadFilesFromSelectedId()
  } else {
    const fileFromUrl = files.find(file => file.pdf == pdfPath)
    if (fileFromUrl) {
      selectBox.selectedIndex = files.indexOf(fileFromUrl);
    }
  }

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
    const searchTerms = getNodeText(node).filter(term => term.length > 2);
    const searchResult = await pdfViewer.search(searchTerms);
  }

  async function populateSelectBox(selectBox, filePath) {
    try {
      // Fetch data from file
      const response = await fetch(filePath);
      const data = await response.json();
      const files = data.files;
      // Clear existing options
      selectBox.innerHTML = '';

      // Populate select box with options
      files.forEach(file => {
        const option = document.createElement('option');
        option.value = file.id;
        option.text = file.id;
        selectBox.appendChild(option);
      });

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

import { app, PdfTeiEditor } from '../app.js'
import { XMLEditor } from '../modules/xmleditor.js'
import { disableValidation } from '../modules/lint.js'

/**
 * This class adds node navigation to the XML Editor
 */
class NavXmlEditor extends XMLEditor {
  /**
   * Disables the validation, i.e. any validation triggered returns an empty array
   * @param {boolean} value 
   */
  disableValidation(value) {
    disableValidation(value)
  }
} 

/**
 * component is an instance of NavXmlEditor
 * @type {NavXmlEditor}
 */
export const xmlEditorComponent = new NavXmlEditor('xml-editor')

// the path oto the autocompletion data
const tagDataPath = '/data/tei.json'

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function start(app) {
  app.registerComponent('xmleditor', xmlEditorComponent, 'xmleditor')
  console.log("XML Editor plugin installed.")
  
  // load autocomplete data
  try {
    const res = await fetch(tagDataPath);
    const tagData = await res.json();
    xmlEditorComponent.startAutocomplete(tagData)
    console.log("Loaded autocompletion data...");
  } catch (error) {
    console.error('Error fetching from', tagDataPath, ":", error);
  }
  // handle selection change
  xmlEditorComponent.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, event => {
    handleSelectionChange(event.detail)
  });
}

/**
 * component plugin
 */
export const xmlEditorPlugin = {
  name: "xmleditor",
  app: { start }
}

export {XMLEditor}
export default xmlEditorPlugin

//
// navigation
//


/**
 * the current xpath used for selection
 */
let selectionXpath = null;

/**
 * The last selected node, can be null
 * @type {Node?}
 */
let lastSelectedXpathlNode = null;

// the index of the currently selected node, 1-based
let currentIndex = null;

// the xpath of the cursor within the xml document
let lastCursorXpath = null;

/**
 * Returns information on the given xpath
 * @param {string} xpath An xpath expression
 * @returns {Object}
 */
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
    return app.xmleditor.countDomNodesByXpath(xpath)
  } catch (e) {
    return 0
  }
}

function getSelectionXpathResultSize() {
  return getXpathResultSize(getSelectionXpath())
}

/**
  * Handles change of selection in the document
  * @param {Array} ranges An array of object of the form {to, from, node}
  * @returns 
  */
async function handleSelectionChange(ranges) {
  if (ranges.length === 0 || !app.xmleditor.getXmlTree()) return;

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
  const newCursorXpath = selectedNode && app.xmleditor.getXPathForNode(selectedNode)

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
  if (autoSearchSwitch.checked) {
    await searchNodeContentsInPdf(selectedNode)
  }
}


/**
 * Selects the node identified by the xpath in the select box and the given index
 * @param {number} index 1-based index
 * @returns {void}
 */
function selectByIndex(index) {
  // Wait for editor to be ready
  if (!app.xmleditor.isReady()) {
    console.log("Editor not ready, deferring selection")
    app.xmleditor.addEventListener(XMLEditor.EVENT_XML_CHANGED, () => {
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
    window.app.xmleditor.selectByXpath(xpathWithIndex);
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

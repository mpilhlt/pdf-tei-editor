import { app, PdfTeiEditor } from '../app.js'
import { XMLEditor } from '../modules/xmleditor.js'
import { disableValidation } from '../modules/lint.js'

/**
 * This class adds node navigation to the XML Editor
 */
class NavXmlEditor extends XMLEditor {

  /**
   * The last selected node, can be null
   * @type {Node?}
   */
  lastSelectedXpathlNode = null;

  /**
   * The index of the currently selected node, 1-based
   * @type{Number}
   */
  currentIndex = null;

  /**
   * The xpath of the cursor within the xml document
   * @type {string}
   */
  lastCursorXpath = null;

  /**
   * Constructs an XMLEditor instance.
   * @param {string} editorDivId - The ID of the div element where the XML editor will be shown.
   * @param {Object?} tagData - Autocompletion data
   */
  constructor(editorDivId, tagData) {
    super(editorDivId, tagData) 
    // handle selection change
    this.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, this.onSelectionChange);
  }

  /**
    * Handles change of selection in the document
    * @param {Array} ranges An array of object of the form {to, from, node}
    * @returns 
    */
  async onSelectionChange(event) {
    const ranges = event.detail
    if (ranges.length === 0 || !app.xmleditor.getXmlTree()) return;

    // we care only for the first selected node or node parent matching our xpath
    const xpathTagName = app.services.xpathInfo(getSelectionXpath()).tagName
    const range = ranges[0]

    /** @type {Node} */
    let selectedNode = range.node;
    if (!selectedNode) {
      this.lastSelectedXpathlNode = null;
      this.lastCursorXpath = null;
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
    const newCursorXpath = selectedNode && xmlEditorComponent.getXPathForNode(selectedNode)

    // do nothing if we cannot find a matching parent, or the parent is the same as before
    if (!selectedNode || this.lastSelectedXpathlNode === selectedNode || newCursorXpath === this.lastCursorXpath) {
      return;
    }

    // remember new (parent) node
    this.lastSelectedXpathlNode = selectedNode;
    this.lastCursorXpath = newCursorXpath
  }


  /**
   * Selects the node identified by the xpath in the select box and the given index
   * @param {number} index 1-based index
   * @returns {void}
   */
  selectByIndex(index) {
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
    const { index: oldIndex, beforeIndex: selectionXpath } = app.services.xpathInfo(xpath)
    if (oldIndex === index) {
      // nothing to do
      return
    }
    const size = getXpathResultSize(selectionXpath)
    if (index > size || size === 0 || index < 1) {
      throw new Error(`Index out of bounds: ${index} of ${size} items`);
    }
    this.currentIndex = index;

    const newXpath = `${selectionXpath}[${this.currentIndex}]`

    try {
      xmlEditorComponent.selectByXpath(newXpath);
      app.xpath = newXpath
    } catch (error) {
      // this sometimes fails for unknown reasons
      console.warn(error.message)
    }
  }

  /**
   * Selects the next node matching the current xpath 
   */
  nextNode() {
    if (this.currentIndex < getXpathResultSize()) {
      this.currentIndex++;
    }
    selectByIndex(this.currentIndex);
  }

  /**
   * Selects the previous node matching the current xpath 
   */
  previousNode() {
    if (this.currentIndex > 1) {
      this.currentIndex--;
    }
    selectByIndex(this.currentIndex);
  }

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
  
  // handle xpath change
  app.on("change:xpath", onXpathChange)

  // update state when editor selection changes
  xmlEditorComponent.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, onSelectionChange);
}

/**
 * component plugin
 */
export const xmlEditorPlugin = {
  name: "xmleditor",
  app: { start }
}

export { XMLEditor }
export default xmlEditorPlugin


/**
 * Called when the app state "xpath" changes
 * @param {string|null} xpath The new xpath for selection
 * @param {string|null} old The previous xpath
 * @returns {void}
 */
function onXpathChange(xpath, old) {
  if (!xpath) {
    return
  }
  const { index, beforeIndex } = app.services.xpathInfo(xpath)
  // select the first node
  const size = app.services.getXpathResultSize(beforeIndex)
  if (size > 0 && (index !== this.currentIndex)) {
    this.currentIndex = index || 1
    selectByIndex(this.currentIndex)
  }
}

/**
 * Called when the selection in the editor changes
 */
async function onSelectionChange() {
  // update state from the xpath of the nearest selection node
  const { basename } = app.services.xpathInfo(xmlEditorComponent.lastCursorXpath)
  app.xpath = `//tei:${basename}` // the xpath from the DOM does not have a prefix, todo unhardcode

  // trigger auto-search if enabled, 
  const autoSearchSwitch = $('#switch-auto-search') // todo convert into state app
  if (autoSearchSwitch.checked) {
    await app.services.searchNodeContentsInPdf(xmlEditorComponent.lastSelectedXpathlNode)
  }
}
import { app, PdfTeiEditor } from '../app.js'
import { XMLEditor } from '../modules/xmleditor.js'
import { disableValidation } from '../modules/lint.js'
import { xpathInfo } from '../modules/utils.js'

// the path to the autocompletion data
const tagDataPath = '/data/tei.json'

/**
 * This class adds node navigation to the XML Editor
 */
class NavXmlEditor extends XMLEditor {

  /**
   * An xpath which identifies the topmost path to which selections of child nodes 
   * "bubble up"
   */
  parentPath = null;

  /**
   * The index of the currently selected primary node, 1-based
   * @type{Number}
   */
  currentIndex = 1;

  /**
   * The last selected primary node, can be null
   * @type {Node?}
   */
  selectedNode = null;  

  /**
   * The xpath of the last selected primary node
   * @type {string}
   */
  selectedXpath = null;

  /**
   * Constructs an XMLEditor instance.
   * @param {string} editorDivId - The ID of the div element where the XML editor will be shown.
   * @param {Object?} tagData - Autocompletion data
   */
  constructor(editorDivId, tagData) {
    super(editorDivId, tagData) 
    // handle selection change
    this.addEventListener(
      XMLEditor.EVENT_SELECTION_CHANGED, 
      evt => this.whenReady().then(() => this.onSelectionChange(evt))
    )
  }

  /**
    * Handles change of selection in the document
    * @param {Array} ranges An array of object of the form {to, from, node}
    * @returns 
    */
  async onSelectionChange(event) {
    const ranges = event.detail

    if (ranges.length === 0 || !this.getXmlTree() || !this.parentPath) {
      let msg = ['Cannot update selection node & xpath:']
      ranges.length || msg.push("Selection is empty")
      this.getXmlTree() || msg.push("XML Tree not ready")
      this.parentPath ||msg.push("No parent path")
      console.warn(msg.join("; "))
      return
    }

    // we care only for the first selection
    const range = ranges[0]

    // if the selection does not contain a node, abort
    let selectedNode = range.node;
    if (!selectedNode) {
      this.selectedNode = null;
      this.selectedXpath = null;
      return;
    }

    // we'll "bubble up" to the parent path by comparing tagnames (cheating)
    const parentTagName = xpathInfo(this.parentPath).tagName.toLowerCase()
    while (selectedNode) {
      if (selectedNode.tagName && selectedNode.tagName.toLowerCase() === parentTagName) break;
      selectedNode = selectedNode.parentNode
    }

    // the xpath of the current cursor position
    const newCursorXpath = selectedNode && xmlEditorComponent.getXPathForNode(selectedNode)

    // do nothing if we cannot find a matching parent, or the parent is the same as before
    if (!selectedNode || this.selectedNode === selectedNode || newCursorXpath === this.selectedXpath) {
      return;
    }

    // remember new (parent) node
    this.selectedNode = selectedNode;
    this.selectedXpath = newCursorXpath
  }

  /**
   * Selects the node identified by the xpath in the select box and the given index
   * @param {number} index 1-based index
   * @returns {void}
   */
  selectByIndex(index) {
    if (!this.parentPath) {
      throw new Error("No parent path set. Cannot select by index")
    }

    // Wait for editor to be ready
    if (!this.isReady()) {
      console.log("Editor not ready, deferring selection")
      this.addEventListener(XMLEditor.EVENT_XML_CHANGED, () => {
        console.log("Editor is now ready")
        this.selectByIndex(index)
      }, { once: true })
      return;
    }

    // check if selection is within bounds
    const size = this.countDomNodesByXpath(this.parentPath)
    if (index > size || size === 0 || index < 1) {
      throw new Error(`Index out of bounds: ${index} of ${size} items`);
    }
    this.currentIndex = index;

    const newXpath = `${this.parentPath}[${this.currentIndex}]`

    try {
      this.selectByXpath(newXpath);
    } catch (error) {
      // this sometimes fails for unknown reasons
      console.warn(error.message)
    }
  }

  /**
   * Selects the next node matching the current xpath 
   */
  nextNode() {
    if (!this.parentPath) {
      throw new Error("Cannot go to next node - no parent path set")
    }
    if (this.currentIndex < this.countDomNodesByXpath(this.parentPath)) {
      this.currentIndex++;
    }
    this.selectByIndex(this.currentIndex);
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

  /**
   * Sets the status attribute of the given node, or removes it if the status is empty
   * @param {Node} node The node
   * @param {string} status The new status, can be "verified", "unresolved", "comment" or ""
   * @returns {Promise<void>}
   * @throws {Error} If the status is not one of the allowed values
   */
  async setNodeStatus(node, status) {
    if (!node) {
      throw new Error("No node given")
    }
    // update XML document from editor content
    this.updateNodeFromEditor(node)
  
    // set/remove the status attribute
    switch (status) {
      case "":
        node.removeAttribute("status")
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
        node.setAttribute("status", status)
    }
    // update the editor content
    await this.updateEditorFromNode(node)
  }

}

/**
 * component is an instance of NavXmlEditor
 * @type {NavXmlEditor}
 */
const xmlEditorComponent = new NavXmlEditor('xml-editor')
const cmp = xmlEditorComponent;

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
async function install(app) {
  app.registerComponent('xmleditor', xmlEditorComponent, 'xmleditor')
  console.log("XML Editor component installed.")

  // load autocomplete data
  try {
    const res = await fetch(tagDataPath);
    const tagData = await res.json();
    cmp.startAutocomplete(tagData)
    console.log("Loaded autocompletion data...");
  } catch (error) {
    console.error('Error fetching from', tagDataPath, ":", error);
  }
 
  // xpath state => selection
  app.on("change:xpath", (value, old) => {
    cmp.whenReady().then(() => onXpathChange(value, old))
  })

  // selection => xpath state
  cmp.addEventListener(XMLEditor.EVENT_SELECTION_CHANGED, evt => {
    cmp.whenReady().then(() => onSelectionChange(evt))
  });
}

/**
 * component plugin
 */
const xmlEditorPlugin = {
  name: "xmleditor",
  install
}

export { XMLEditor, xmlEditorComponent, xmlEditorPlugin }
export default xmlEditorPlugin

/**
 * Called when the app state "xpath" changes to update the selection
 * @param {string|null} xpath The new xpath for selection
 * @param {string|null} old The previous xpath
 * @returns {void}
 */
function onXpathChange(xpath, old) {
  if (!xpath) {
    return
  }
  const { index, beforeIndex } = xpathInfo(xpath)
  // select the first node
  const size = app.services.getXpathResultSize(beforeIndex)
  if (size > 0 && (index !== cmp.currentIndex)) {
    cmp.parentPath = beforeIndex
    cmp.selectByIndex(index || 1)
  }
}

/**
 * Called when the selection in the editor changes to update the cursor xpath
 */
async function onSelectionChange() {
  const xpath = cmp.selectedXpath
  if (!xpath)  {
    // this usually means that the editor is not ready yet
    //console.warn("Could not determine xpath of last selected node")
    return
  }
  // update state from the xpath of the nearest selection node
  const { basename } = xpathInfo(xpath)
  app.xpath = `//tei:${basename}` // the xpath from the DOM does not have a prefix, todo unhardcode
}
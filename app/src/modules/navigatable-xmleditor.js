import { XMLEditor } from "./xmleditor.js";
import { parseXPath } from './utils.js'

export {XMLEditor}

/**
 * This class adds node navigation to the XML Editor
 */
export class NavXmlEditor extends XMLEditor {

  /**
   * An xpath which identifies the topmost path to which selections of child nodes 
   * "bubble up"
   * @type {string?}
   */
  parentPath = null;

  /**
   * The index of the currently selected primary node, 1-based
   * @type{Number}
   */
  currentIndex = 1;

  /**
   * The last selected primary node, can be null
   * @type {Element?}
   */
  selectedNode = null;

  /**
   * The xpath of the last selected primary node
   * @type {string?}
   */
  selectedXpath = null;

  /**
   * Whether focus mode is active, in which the navigated-to node is centered and
   * all other content is dimmed instead of selecting the node
   * @type {boolean}
   */
  #focusMode = false;

  /**
   * Constructs an XMLEditor instance.
   * @param {string} editorDivId - The ID of the div element where the XML editor will be shown.
   * @param {Object?} tagData - Autocompletion data
   */
  constructor(editorDivId, tagData=null) {
    super(editorDivId, tagData)
    // handle selection change
    this.on(
      XMLEditor.EVENT_SELECTION_CHANGED,
      // @ts-ignore
      this.#onSelectionChange.bind(this)
    )
  }

  /**
   * 
   * @param {any} data 
   */
  async #onSelectionChange(data) {
    await this.whenReady()
    await this.handeSelectionChange(data)
  }

  /**
   * Handles change of selection in the document
   * @param {Array} ranges An array of object of the form {to, from, node}
   * @returns 
   */
  async handeSelectionChange(ranges) {
    // wait for any editor operations to finish
    await this.whenReady()
        
    if (ranges.length === 0 || !this.getXmlTree()) {
      let msg = ['Cannot update selection node & xpath:']
      ranges.length || msg.push("Selection is empty")
      this.getXmlTree() || msg.push("XML Tree not ready")
      console.warn(msg.join("; "))
      return
    }
    
    // If no parent path is set, no normative xpath is active — skip state propagation
    if (!this.parentPath) {
      const range = ranges[0]
      if (range.node && range.node !== this.selectedNode) {
        this.selectedNode = range.node
        this.selectedXpath = null
      }
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

    // Bubble up from the cursor position until we find an ancestor whose local tag name
    // matches the leaf element of the normative parentPath (e.g. "bibl" for "//tei:listBibl/tei:bibl")
    const parentTagName = parseXPath(this.parentPath).tagName.toLowerCase()
    const originalNode = selectedNode;
    while (selectedNode) {
      if (selectedNode.tagName && selectedNode.tagName.toLowerCase() === parentTagName) break;
      selectedNode = selectedNode.parentNode
    }
    if (!selectedNode) {
      return;
    }
    if (this.selectedNode === selectedNode) {
      return;
    }

    // Find the 1-based index of the bubbled-up node among all nodes matching parentPath.
    // This gives us `parentPath[index]` — the canonical normative xpath for state.
    const xmlTree = this.getXmlTree();
    const snapshot = xmlTree.evaluate(
      this.parentPath, xmlTree, this.namespaceResolver,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    let nodeIndex = -1;
    for (let i = 0; i < snapshot.snapshotLength; i++) {
      if (snapshot.snapshotItem(i) === selectedNode) {
        nodeIndex = i + 1; // 1-based
        break;
      }
    }

    if (nodeIndex < 0) {
      return;
    }
    this.currentIndex = nodeIndex;
    this.selectedNode = selectedNode;
    this.selectedXpath = `${this.parentPath}[${nodeIndex}]`;

    // moving the cursor into another node moves the focus along, without scrolling
    if (this.#focusMode) {
      this.#tryFocus(() => this.focusDomNode(selectedNode, { scroll: false }));
    }
  }

  /**
   * Whether focus mode is active
   * @returns {boolean}
   */
  isFocusMode() {
    return this.#focusMode;
  }

  /**
   * Turns focus mode on or off. When turned on, the currently navigated-to node is
   * focused right away; subsequent navigation centers the target node and dims
   * all other content instead of selecting the node.
   * @param {boolean} enabled
   */
  setFocusMode(enabled) {
    if (enabled === this.#focusMode) return;
    this.#focusMode = enabled;
    if (!enabled) {
      this.clearFocus();
      return;
    }
    if (this.selectedXpath) {
      const xpath = this.selectedXpath;
      this.#tryFocus(() => this.focusByXpath(xpath));
    } else if (this.parentPath) {
      const xpath = `${this.parentPath}[${this.currentIndex}]`;
      this.#tryFocus(() => this.focusByXpath(xpath));
    }
  }

  /**
   * Runs a focus operation, logging instead of throwing if the node cannot be resolved
   * (e.g. while the editor is out of sync with the XML tree)
   * @param {() => void} fn
   */
  #tryFocus(fn) {
    try {
      fn();
    } catch (error) {
      console.warn(`Could not focus node: ${String(error)}`);
    }
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
      this.once(XMLEditor.EVENT_EDITOR_READY, () => {
        this.selectByIndex(index)
      })
      return;
    }

    // check if selection is within bounds
    const size = this.countDomNodesByXpath(this.parentPath)
    if (index > size || size === 0 || index < 1) {
      throw new Error(`Index out of bounds: ${index} of ${size} items`);
    }
    this.currentIndex = index;
    this.selectedNode = null; // reset so the next handeSelectionChange doesn't skip as "same node"

    const newXpath = `${this.parentPath}[${this.currentIndex}]`

    try {
      if (this.#focusMode) {
        this.focusByXpath(newXpath);
      } else {
        this.selectByXpath(newXpath);
      }
    } catch (error) {
      // this sometimes fails for unknown reasons
      console.warn(String(error))
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
    this.selectByIndex(this.currentIndex);
  }

  /**
   * Sets the status attribute of the given node, or removes it if the status is empty
   * @param {Element} node The node
   * @param {string} status The new status, can be "verified", "unresolved", "comment" or ""
   * @returns {Promise<void>}
   * @throws {Error} If the status is not one of the allowed values
   */
  async setNodeStatus(node, status) {
    if (!node) {
      throw new Error("No node given")
    }
    // update XML document from editor content
    await this.updateNodeFromEditor(node)

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

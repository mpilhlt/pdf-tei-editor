import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { xml, xmlLanguage } from "@codemirror/lang-xml";
import { linter, lintGutter, forceLinting } from "@codemirror/lint";
import { createCompletionSource } from './autocomplete.js'
import { lintSource } from './lint.js'

export class XMLEditor extends EventTarget {
  static EVENT_CURRENT_NODE_CHANGED = "currentNodeChanged";

  /**
   * Constructs an XMLEditor instance.
   * @param {string} editorDivId - The ID of the div element where the XML editor will be shown.
   */
  constructor(editorDivId, tagData, recordTag) {
    super();
    this.editorDiv = document.getElementById(editorDivId);
    this.nodes = []; // Stores the extracted nodes from the XML.
    this.xmlContent = "";
    this.currentIndex = 0;
    this.highlightedTag = null;
    this.recordTag = recordTag;

    // the number of the current diagnostic, if any, otherwise null
    this.diagnosticIndex = null;

    this.basicExtensions = [
      basicSetup,
      xml(),
      xmlLanguage.data.of({
        autocomplete: createCompletionSource(tagData)
      }),
      linter(lintSource, {autoPanel: true, delay: 2000}),
      lintGutter()
    ];
    let linterTimeout = null;

    this.state = EditorState.create({
      doc: "",
      extensions: [
        ...this.basicExtensions,
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            const xmlContent = update.state.doc.toString();
          }
        })
      ]
    });

    this.view = new EditorView({
      state: this.state,
      parent: this.editorDiv
    });

    window.myeditor = this.view; // For debugging purposes
  }

  /**
   * Loads XML, either from a string or from a given path.
   * @async
   * @param {string} xmlPathOrString - The URL or path to the XML file, or an xml string
   * @returns {Promise<string>} - A promise that resolves with the raw XML string.
   * @throws {Error} - If there's an error loading or parsing the XML.
   */
  async loadXml(xmlPathOrString) {
    let xml;
    if (xmlPathOrString.trim().slice(0, 1) != "<") {
      // treat argument as path
      try {
        const response = await fetch(xmlPathOrString);
        xml = await response.text();
      } catch (error) {
        throw new Error('Error loading or parsing XML: ' + error.message);
      }
    } else {
      // treat argument as xml string
      xml = xmlPathOrString;
    }
    
    // provide each main record with an xml:id
    if (this.recordTag) {
      const parser = new DOMParser(); 
      const xmlDoc = parser.parseFromString(xml, "application/xml");
      this.nodes = Array.from(xmlDoc.getElementsByTagName(this.recordTag));
      for (let [idx, node] of this.nodes.entries()) {
        if (!node.hasAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:id")){
          node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:id", `biblStruct${idx}`)
        }
      }
      xml = (new XMLSerializer()).serializeToString(xmlDoc)
    }
    
    this.xmlContent = xml;

    // display xml in editor
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: xml },
      selection: EditorSelection.cursor(0)
    });

    // run linting
    forceLinting(this.view);

    // highlight first node
    this.resetIndex();
    setTimeout(() => this.focusNodeByIndex(0), 500);

    return this.xmlContent;
  }

  /**
   * Focuses on a given DOM node in the displayed XML content 
   * @param {Node} node - The DOM node to highlight.  If null, the overlay is hidden.
   */
  focusNode(node) {

    console.log("Focusing node", node);

    if (node !== this.__lastNode) {
      this.dispatchEvent(new CustomEvent(XMLEditor.EVENT_CURRENT_NODE_CHANGED, {detail: node}));
      this.__lastNode = node;
    }

    if (!node) {
      this.view.dispatch({ selection: EditorSelection.range(0, 0) })
      return;
    }

    // Find the start and end positions of the node in the editor
    const id = node.getAttribute("xml:id")
    if (!id) {
      console.error(`Node has no id`, node);
      return;
    }

    const pos = this.xmlContent.indexOf(`xml:id="${id}"`)
    if (pos == -1) {
      console.error(`Cannot find node with xml:id="${id}"`)
      return
    }
    const doc = this.view.state.doc;
    if (doc.length > 0) {
      let from = doc.lineAt(pos).from;
      let to = doc.lineAt(from + node.outerHTML.length).to;
  
      // Dispatch a transaction to select the node in the editor
      this.view.dispatch({
        selection: EditorSelection.range(from, to),
        scrollIntoView: true // Optional: Scroll the selection into view
      });
    }  
    
  }

  /**
   * Highlights a node from the `nodes` array by its index.
   * @param {number} index - The index of the node to highlight.
   */
  focusNodeByIndex(index) {
    const node = this.nodes[index];
    if (!node) {
      this.focusNode(null); // Clear the highlight if node doesn't exist
      return;
    }
    try {
      this.focusNode(node);
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Highlights the next node in the `nodes` array.
   *  Moves to the next index and updates the highlight.
   */
  nextNode() {
    if (this.currentIndex < this.nodes.length - 1) {
      this.currentIndex++;
      this.focusNodeByIndex(this.currentIndex);
    }
  }

  /**
   * Highlights the previous node in the `nodes` array.
   *  Moves to the previous index and updates the highlight.
   */
  previousNode() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.focusNodeByIndex(this.currentIndex);
    }
  }

  /**
   * Resets the current index to 0, useful when re-extracting nodes.
   */
  resetIndex() {
    this.currentIndex = 0;
  }

  /**
   * Returns the currently highlighted node.
   * @returns {Node | null} - The currently highlighted node, or null if no node is highlighted.
   */
  getCurrentNode() {
    if (this.nodes.length === 0) {
      return null;
    }
    return this.nodes[this.currentIndex] || null;
  }
}
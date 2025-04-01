import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection  } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { xml, xmlLanguage } from "@codemirror/lang-xml";

export class XMLEditor extends EventTarget {

  static EVENT_CURRENT_NODE_CHANGED = "currentNodeChanged";

  /**
   * Constructs an XMLEditor instance.
   * @param {string} editorDivId - The ID of the div element where the XML editor will be shown.
   */
  constructor(editorDivId, tagData) {
    super();
    this.editorDiv = document.getElementById(editorDivId);
    this.nodes = []; // Stores the extracted nodes from the XML.
    this.xmlContent = "";
    this.currentIndex = 0;
    this.highlightedTag = null;

    this.basicExtensions = [
      basicSetup,
      xml(),
      xmlLanguage.data.of({
        autocomplete: this.createCompletionSource(tagData)
      })
    ];

    this.state = EditorState.create({
      doc: "",
      extensions: [
        ...this.basicExtensions,
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            this.xmlContent = update.state.doc.toString();
          }
        })
      ]
    });

    this.editor = new EditorView({
      state: this.state,
      parent: this.editorDiv
    });

    window.myeditor = this.editor; // For debugging purposes
  }

  show() {
    this.editorDiv.style.display = '';
    return this;
  }

  hide() {
    this.editorDiv.style.display = 'none';
    return this;
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
    this.xmlContent = xml;
    this.editor.dispatch({
      changes: { from: 0, to: this.editor.state.doc.length, insert: xml },
      selection: EditorSelection.cursor(0)
    });
    return this.xmlContent;
  }

  createCompletionSource(tags) {
    return (context) => {
      let word = context.matchBefore(/\w*/);
      console.log(context)
      if (!word || word.from == word.to || !tags) return null;

      const state = context.state;
      const pos = context.pos;
      const token = context.tokenBefore();
      console.log(token)
      // Determine context: are we inside a tag, after an attribute, etc.
      let currentTag = null;

      if (token && token.type === "tag") { //We're in a tag
        currentTag = token.string.slice(1); // remove '<'
      }

      let options = [];

      if (currentTag && tags[currentTag]) {

        //Provide attribute completions if inside tag and tag is present in schema
        if (context.matchBefore(/ /)) {
          //Providing attribute options
          if (tags[currentTag].attrs) {
            options = Object.keys(tags[currentTag].attrs).map(attr => ({ label: attr, type: "attribute" }))
          }
        } else {
          //Otherwise provide tag options
          options = Object.keys(tags).map(tag => ({ label: tag, type: "keyword" }))
        }

      } else {
        // Provide tag completions (only at the top level for this example)
        if (tags["!top"]) {
          options = tags["!top"].map(tag => ({ label: tag, type: "keyword" }))
        } else {
          options = Object.keys(tags).map(tag => ({ label: tag, type: "keyword" }))
        }

      }
      return {
        from: word.from,
        options: options,
        validFor: /^\w*$/
      };
    };
  }

  /**
   * Sets the tag name to highlight and navigates, removing the previous highlight.
   * @param {string} tagName - The tag name to highlight.
   */
  highlightTag(tagName) {
    if (this.highlightedTag !== tagName) {
      this.highlightedTag = tagName;
      this.resetIndex(); // Reset the index when highlighting a new tag
      this._extractNodes(tagName);
    }
    this.highlightNodeByIndex(this.currentIndex); // Highlight the first node after extracting.
  }

  /**
   * Extracts a list of nodes with a given tag name from an XML string.
   * @private
   * @param {string} tagName - The tag name of the nodes to extract.
   * @returns {Array<Node>} - An array of DOM nodes matching the tag name, with an added `search_index` property.
   */
  _extractNodes(tagName) {
    if (!this.xmlContent) {
      throw new Error("No XML content loaded. Call loadXml() first.");
    }

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(this.xmlContent, "application/xml");
    const nodes = Array.from(xmlDoc.getElementsByTagName(tagName)).map((node, index) => {
      node.search_index = index; // Store the index for faster lookup
      return node;
    });
    this.nodes = nodes; // Store the extracted nodes in the class property.
  }

  /**
   * Highlights a given DOM node in the displayed XML content by positioning an overlay.
   * @param {Node} node - The DOM node to highlight.  If null, the overlay is hidden.
   */
  highlightNode(node) {
    if (!node) {
      this.editor.dispatch({ selection: EditorSelection.range(0, 0) })
      return;
    }
    // Find the start and end positions of the node in the editor
    const start = this.xmlContent.indexOf(`<${node.tagName}`, this.xmlContent.indexOf(node.outerHTML))
    const end = start + node.outerHTML.length;

    if (start === -1 || end === -1) {
      console.warn(`Node not found in editor content: ${node.tagName}`);
      return;
    }

    // Dispatch a transaction to select the node in the editor
    this.editor.dispatch({
      selection: EditorSelection.range(start, end),
      scrollIntoView: true // Optional: Scroll the selection into view
    });
  }

  /**
   * Highlights a node from the `nodes` array by its index.
   * @param {number} index - The index of the node to highlight.
   */
  highlightNodeByIndex(index) {
    const node = this.nodes[index];
    if (!node) {
      this.highlightNode(null); // Clear the highlight if node doesn't exist
      return;
    }
    try {
      this.highlightNode(node);
    } catch (error) {
      console.error(error);
    }
    this.dispatchEvent(new Event(XMLEditor.EVENT_CURRENT_NODE_CHANGED));
  }

  /**
   * Highlights the next node in the `nodes` array.
   *  Moves to the next index and updates the highlight.
   */
  nextNode() {
    if (this.currentIndex < this.nodes.length - 1) {
      this.currentIndex++;
      this.highlightNodeByIndex(this.currentIndex);
    }
  }

  /**
   * Highlights the previous node in the `nodes` array.
   *  Moves to the previous index and updates the highlight.
   */
  previousNode() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.highlightNodeByIndex(this.currentIndex);
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
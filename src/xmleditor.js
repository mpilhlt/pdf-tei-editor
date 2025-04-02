import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { xml, xmlLanguage } from "@codemirror/lang-xml";
import { syntaxTree } from "@codemirror/language";
import { startCompletion } from "@codemirror/autocomplete";
import { linter, lintGutter } from "@codemirror/lint";

// load XSD
(async () => {
  try {
    const xml_xsd = await (await fetch('/schema/xml.xsd')).text()
    const tei_xsd = await (await fetch('/schema/tei.xsd')).text()
    window.tei_xsd = [xml_xsd, tei_xsd];
    console.log("XSD files loaded");
  } catch( error ) {
    console.error("Error loading XSD files:", error.message)
  }
})();

/**
 * 
 * @param {Object} node 
 * @param {EditorState} state 
 * @returns {Array<>}
 */
function getParentTagNames(node, state) {
  const tagNames = [];
  let parentNode = node.parent;
  while (parentNode) {
    if (parentNode.name === "Element") {
      const tagPortion = state.doc.sliceString(parentNode.from, parentNode.to);
      const match = tagPortion.match(/^<([a-zA-Z0-9:]+)/);
      if (match) {
        tagNames.push(match[1]); // Add the captured tag name to the list
      }
    }
    parentNode = parentNode.parent;
  }
  return tagNames;
}

/**
 * Given a data structure containing permissible children and attributes of
 * nodes with a given tag, create the completionSource data for autocompletion
 * @param {*} tagData 
 * @returns 
 */
function createCompletionSource(tagData) {
  return (context) => {
    const state = context.state;
    const pos = context.pos;
    let node = syntaxTree(state).resolveInner(pos, -1);
    let type = node.type.name;
    let text = context.state.sliceDoc(node.from, context.pos);
    let options = [];
    const parentTags = getParentTagNames(node, state);
    let completionType = "keyword";

    switch (type) {
      case "StartTag":
        options = tagData[parentTags[0]]?.children || [];
        break;
      case "TagName":
        options = tagData[parentTags[1]]?.children || [];
        break;
      case "OpenTag":
      case "AttributeName":
        options = Object.keys(tagData[parentTags[0]]?.attrs || {})
          .map(displayLabel => ({
            displayLabel,
            label: `${displayLabel}=""`,
            type: "property",
            apply: (view, completion, from, to) => {
              view.dispatch({
                changes: { from, to, insert: completion.label },
                selection: { anchor: from + completion.label.length - 1 }
              });
              // start new autocomplete
              setTimeout(() => startCompletion(view), 20);
            }
          }));
        break;
      case "AttributeValue":
        const attributeNode = node.prevSibling?.prevSibling;
        if (!attributeNode) break;
        const attributeTag = context.state.sliceDoc(attributeNode.from, attributeNode.to);
        const attrs = tagData[parentTags[0]]?.attrs;
        options = (attrs && attrs[attributeTag]) || [];
        options = options.map(option => ({
          label: option,
          type: "property",
          apply: (view, completion, from, to) => {
            view.dispatch({
              changes: { from, to, insert: completion.label },
              selection: { anchor: to + completion.label.length + 1 }, // Move cursor after the closing quote
            });
          }
        }));
        break;
    }

    if (options.length === 0) {
      return null;
    }

    // Suggest from cursor position for StartTag/OpenTag.
    const from = ["StartTag", "OpenTag", "AttributeValue"].includes(type) ? pos : node.from;
    const to = pos;

    // convert string options to completionResult objects
    options = options.map(label => typeof label === "string" ? ({ label, type: completionType }) : label);

    return {
      from, to, options,
      validFor: /^[\w@:]*$/
    };
  };
}

function lintSource(view) {
  // we don't do linting until xmllint has been loaded
  if (!window.xmllint) return [];

  // get text from document and lint it
  const doc = view.state.doc;
  const xml = doc.toString();
  const config = {xml};
  if (window.tei_xsd) {
    config.schema = window.tei_xsd;
  }
  const {errors} =  xmllint.validateXML(config)

  // convert xmllint errors to Diagnostic 
  const diagnostics = errors.map( error => {
    //"file_0.xml:26: parser error : Extra content at the end of the document"
    let m = error.match(/^[^.]+\.xml:(\d+): (?:.+) : (.+)/)
    if (!m) {
      console.warn(error);
      return null;
    }
    const [,lineNumber, message] = m;
    const { from, to } = doc.line(parseInt(lineNumber))
    const severity = "error"
    return { from, to, severity, message };
  }).filter(Boolean);
  if (diagnostics.length > 0) {
    console.warn(`${diagnostics.length} linter error(s) found.`)
  }
  return diagnostics;
}


/**
 * Extracts a list of nodes with a given tag name from an XML string.
 * @private
 * @param {string} tagName - The tag name of the nodes to extract.
 * @returns {Array<Node>} - An array of DOM nodes matching the tag name, with an added `search_index` property.
 */
function extractNodes(tagName) {
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
        autocomplete: createCompletionSource(tagData)
      }),
      linter(lintSource),
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
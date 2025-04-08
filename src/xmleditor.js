import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { xml, xmlLanguage } from "@codemirror/lang-xml";
import { linter, lintGutter, forceLinting } from "@codemirror/lint";
import { createCompletionSource } from './autocomplete.js';
import { syntaxTree } from "@codemirror/language";
import { lintSource } from './lint.js';
import { selectionChangeListener, linkSyntaxTreeWithDOM } from './codemirror_utils.js';


export class XMLEditor extends EventTarget {
  static EVENT_SELECTION_CHANGED = "selectionChanged";
  static EVENT_XML_CHANGED = "xmlChanged";

  #syntaxToDom = null; // Maps syntax tree nodes to DOM nodes
  #domToSyntax = null; // Maps DOM nodes to syntax tree nodes
  #documentVersion = null; // internal counter to track changes in the document

  /**
   * Constructs an XMLEditor instance.
   * @param {string} editorDivId - The ID of the div element where the XML editor will be shown.
   */
  constructor(editorDivId, tagData) {
    super();
    this.editorDiv = document.getElementById(editorDivId);
    if (!this.editorDiv) {
      throw new Error(`Element with ID ${editorDivId} not found.`);
    }
    this.xmlContent = "";
    this.xmlTree = null; // Stores the parsed XML tree.
    this.syntaxTree = null; // Stores the CodeMirror syntax tree

    // list of extensions to be used in the editor
    const extensions = [
      basicSetup,
      xml(),
      linter(lintSource, { autoPanel: true, delay: 2000 }),
      lintGutter(),
      selectionChangeListener(this.onSelectionChange.bind(this)),
      EditorView.updateListener.of(this.onUpdate.bind(this))
    ];

    if (tagData) {
      extensions.push(xmlLanguage.data.of({ autocomplete: createCompletionSource(tagData) }))
    }

    this.state = EditorState.create({ doc: "", extensions });

    this.view = new EditorView({
      state: this.state,
      parent: this.editorDiv
    });

    window.myeditor = this.view; // For debugging purposes
  }

  getDocumentVersion() {
    return this.#documentVersion;
  }

  onSelectionChange(selectionInfo) {
    this.dispatchEvent(new CustomEvent(XMLEditor.EVENT_SELECTION_CHANGED, { detail: selectionInfo }))
  }

  onUpdate(update) {
    if (update.docChanged) {
      this.#documentVersion += 1;
      this.xmlContent = update.state.doc.toString();
      const doc = new DOMParser().parseFromString(this.xmlContent, "application/xml");
      const errorNode = doc.querySelector("parsererror");
      if (errorNode) {
        //console.log("Document was updated but is not well-formed:", error.message)
        this.xmlContent = null;
        this.xmlTree = null;
        return;
      }
      //console.log("Document was updated and is well-formed.")
      this.xmlTree = doc;
      this.syntaxTree = syntaxTree(this.view.state);
      try {
        const maps = linkSyntaxTreeWithDOM(this.view, this.syntaxTree.topNode, this.xmlTree);
        const { syntaxToDom, domToSyntax } = maps;
        this.#syntaxToDom = syntaxToDom;
        this.#domToSyntax = domToSyntax;
        this.dispatchEvent(new Event(XMLEditor.EVENT_XML_CHANGED));
      } catch (error) {
        // since the xml document validated, this must be a bug, needd to look at this again
        console.warn(error.message)
      }
    }
  }

  /**
   * Returns the current XML content of the editor.
   * @returns {string} - The current XML content.
   */
  getXml() {
    return this.xmlContent;
  }

  getXmlTree() {
    return this.xmlTree;
  }

  getSyntaxTree() {
    return this.syntaxTree;
  }

  getView() {
    return this.view;
  }

  /**
   * Loads XML, either from a string or from a given path.
   * @async
   * @param {string} xmlPathOrString - The URL or path to the XML file, or an xml string
   * @returns {Promise} - A promise that resolves when the document is loaded.
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

    // display xml in editor
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: xml },
      selection: EditorSelection.cursor(0)
    });
    this.#documentVersion = 0;
  }

  async validateXml() {
    forceLinting(this.view);
  }

  getSyntaxNodeAt(pos) {
    let syntaxNode = syntaxTree(this.view.state).resolveInner(pos, 1);
    // find the element parent if necessary
    while (syntaxNode && !['Element', 'Document'].includes(syntaxNode.name)) {
      syntaxNode = syntaxNode.parent;
    }
    if (!syntaxNode) {
      throw new Error(`No syntax node found at position ${pos}.`);
    }
    return syntaxNode;
  }

  getDomNodeAt(pos) {
    let syntaxNode = this.getSyntaxNodeAt(pos);
    // find the element parent if necessary
    while (syntaxNode && !['Element', 'Document'].includes(syntaxNode.name)) {
      syntaxNode = syntaxNode.parent;
    }
    const domNode = syntaxNode && this.#syntaxToDom.get(syntaxNode.from);
    if (!domNode) {
      throw new Error(`No DOM node found at position ${pos}`);
    }
    return domNode;
  }

  /**
   * Returns the first DOM node that matches the given XPath expression.
   * @param {string} xpath 
   * @returns {Node} The first matching DOM node.
   * @throws {Error} If the XML tree is not loaded or if no nodes match the XPath expression.
   */
  getDomNodeByXpath(xpath) {
    if (!this.xmlTree) {
      throw new Error("XML tree is not loaded.");
    }
    if (!xpath) {
      throw new Error("XPath is not provided.");
    }
    // Create an XPath expression and evaluate it
    function namespaceResolver(prefix) {
      const namespaces = {
        'tei': 'http://www.tei-c.org/ns/1.0',
        'xml': 'http://www.w3.org/XML/1998/namespace'
      };
      return namespaces[prefix] || null;
    };
    const xpathResult = this.xmlTree.evaluate(xpath, this.xmlTree, namespaceResolver, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (xpathResult.snapshotLength > 0) {
      return xpathResult.snapshotItem(0);
    } else {
      throw new Error(`No nodes found for XPath: ${xpath}`);
    }
  }

  /**
   * Returns the first syntax node that matches the given XPath expression.
   * @param {string} xpath 
   * @returns {SyntaxNode} The first matching syntax node.
   * @throws {Error} If the XML tree is not loaded, if no DOM node match the XPath expression, or no syntax node can be found for the DOM node.
   */
  getSyntaxNodeByXpath(xpath) {
    const node = this.getDomNodeByXpath(xpath)
    const pos = this.#domToSyntax.get(node);
    if (!pos) {
      throw new Error(`No syntax node found for XPath: ${xpath}`);
    }
    return this.getSyntaxNodeAt(pos);
  }

  /**
   * Selects the DOM node that matches the given XPath expression in the editor.
   * @param {string} xpath - The XPath expression to select.
   */
  selectByXpath(xpath) {
    const { from, to } = this.getSyntaxNodeByXpath(xpath);
    this.view.dispatch({
      selection: EditorSelection.range(from, to),
      scrollIntoView: true
    });
  }
}
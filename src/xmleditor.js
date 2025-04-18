import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection, StateEffect } from "@codemirror/state";
import {unifiedMergeView} from "@codemirror/merge"
import { EditorView } from "@codemirror/view";
import { xml, xmlLanguage } from "@codemirror/lang-xml";
import { linter, lintGutter, forEachDiagnostic } from "@codemirror/lint";
import { createCompletionSource } from './autocomplete.js';
import { syntaxTree, syntaxParserRunning } from "@codemirror/language";
import { lintSource, isValidating, anyCurrentValidation, validationIsDisabled, disableValidation } from './lint.js';
import { selectionChangeListener, linkSyntaxTreeWithDOM } from './codemirror_utils.js';
import { $ } from './browser-utils.js';


export class XMLEditor extends EventTarget {
  static EVENT_SELECTION_CHANGED = "selectionChanged";
  static EVENT_XML_CHANGED = "xmlChanged";

  // private members
  /** @type {EditorView} */
  #view = null; // the EditorView instance
  #documentVersion = null; // internal counter to track changes in the document
  #editorContent = ''; // a cache of the raw text content of the editor
  /** @type {Map} */
  #syntaxToDom = null; // Maps syntax tree nodes to DOM nodes
  /** @type {Map} */
  #domToSyntax = null; // Maps DOM nodes to syntax tree nodes
  /** @type {Document} */
  #xmlTree = null; // the xml document tree
  /** @type {SyntaxNode} */
  #syntaxTree = null; // the lezer syntax tree
  #isReady = false;
  /** @type {Promise} */
  #readyPromise = null;
  /** @type {Object} */
  #mergeViewExt = null; // will be created on-demand
  /**  @type {XMLSerializer} */
  #serializer = null; // an XMLSerializer object or one with a compatible API


  /**
   * Constructs an XMLEditor instance.
   * @param {string} editorDivId - The ID of the div element where the XML editor will be shown.
   */
  constructor(editorDivId, tagData) {
    super();
    const editorDiv = document.getElementById(editorDivId);
    if (!editorDiv) {
      throw new Error(`Element with ID ${editorDivId} not found.`);
    }
    this.#xmlTree = null; // Stores the parsed XML tree.
    this.#syntaxTree = null; // Stores the CodeMirror syntax tree

    // list of extensions to be used in the editor
    const extensions = [
      basicSetup,
      xml(),
      linter(lintSource, { autoPanel: true, delay: 2000, needsRefresh: () => true }),
      lintGutter(),
      selectionChangeListener(this.#onSelectionChange.bind(this)),
      EditorView.updateListener.of(this.#onUpdate.bind(this))
    ];

    if (tagData) {
      extensions.push(xmlLanguage.data.of({ autocomplete: createCompletionSource(tagData) }))
    }

    this.#view = new EditorView({
      state: EditorState.create({ doc: "", extensions }),
      parent: editorDiv
    });

    this.#serializer = new XMLSerializer();
  }

  isReady() {
    return this.#isReady
  }

  /**
   * Loads XML, either from a string or from a given path.
   * @async
   * @param {string} xmlPathOrString - The URL or path to the XML file, or an xml string
   * @returns {Promise} - A promise that resolves when the document is loaded.
   * @throws {Error} - If there's an error loading or parsing the XML.
   */
  async loadXml(xmlPathOrString) {
    this.#isReady = false;
    this.#readyPromise = new Promise(resolve => this.addEventListener(XMLEditor.EVENT_XML_CHANGED, () => {
      this.#isReady = true;
      resolve();
    }, {once: true}))

    // fetch xml if path 
    const xml = await this.#fetchXml(xmlPathOrString);

    // display xml in editor, this triggers the update handlers
    this.#view.dispatch({
      changes: { from: 0, to: this.#view.state.doc.length, insert: xml },
      selection: EditorSelection.cursor(0)
    });
    this.#documentVersion = 0;
  }

  async #fetchXml(xmlPathOrString) {
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
    return xml
  }

  /**
   * Triggers a validation and returns an array of Diagnostic objects, or an empty array if no
   * validation errors were found
   * @returns {Promise<Array>}
   */
  async validateXml() {
    if (isValidating()) {
      // if a validation is ongoing, we can wait for it to finish and use the result
      console.log("Validation is ongoing, waiting for it to finish")
      return await anyCurrentValidation()
    }
    //console.log("Triggering a validation")
    // otherwise, we trigger the linting
    let disabledState = validationIsDisabled()
    disableValidation(false)
    // await the new validation promise once it is available
    const diagnostics = await new Promise(resolve => {
      console.log("Waiting for validation to start...")
      function checkIfValidating() {
        if (isValidating()) {
          let validationPromise = anyCurrentValidation();
          validationPromise.then(result => {
            resolve(result);
          });
        } else {
          setTimeout(checkIfValidating, 100);
        }
      }
      checkIfValidating();
    });
    disableValidation(disabledState)
    return diagnostics
  }

  async showMergeView(xmlPathOrString){
    // remove existing merge view
    this.hideMergeView()

    // fetch xml if path 
    const xml = await this.#fetchXml(xmlPathOrString);
    // create and display merge view
    this.#mergeViewExt = unifiedMergeView({
      original: xml,
      diffConfig: {scanLimit: 50000, timeout: 20000}
    })
    this.#view.addEventListener
    this.#view.dispatch({
      effects: StateEffect.appendConfig.of([this.#mergeViewExt])
    });
  }

  hideMergeView() {
    if (this.#mergeViewExt) {
      // remove it?
    }
  }

  getDocumentVersion() {
    return this.#documentVersion;
  }

  getView() {
    return this.#view;
  }

  /**
   * Returns the current content of the editor.
   * @returns {string} - The current XML content.
   */
  getEditorContent() {
    return this.#editorContent;
  }

  getXmlTree() {
    return this.#xmlTree;
  }

  /**
   * Returns the string representation of the XML tree
   * @returns {string} 
   */
  getXML() {
    return this.#serialize(this.#xmlTree, /* do not remove namespace declaration */ false)
  }

  /**
   * serializes the node (or the complete xmlTree if no node is given) to an XML string
   * @param {Node} node The node to serialize
   * @param {boolean} [removeNamespaces=true] Whether to remove the namespace declaration in the output
   */
  #serialize(node, removeNamespaces=true) {
    if (!(node && node instanceof Node)) {
      throw new TypeError("No node provided")
    }
    let xmlstring = this.#serializer.serializeToString(node)
    if (removeNamespaces) {
      xmlstring = xmlstring.replace(/ xmlns=".+?"/, '')
    }
    return xmlstring
  }

  async #waitForEditorUpdate(changes) {
    const promise = new Promise(resolve => this.addEventListener(XMLEditor.EVENT_XML_CHANGED, resolve, { once: true }))
    this.#view.dispatch({ changes });
    await promise;
  }

  /**
   * Updates the editor from a node in the XML Document. Returns a promise that resolves when
   * the editor is updated
   * @param {Node} node A XML DOM node
   */
  async updateEditorFromNode(node) {
    const syntaxNode = this.getSyntaxNodeFromDomNode(node)
    const xmlstring = this.#serialize(node)
    const changes = { from: syntaxNode.from, to: syntaxNode.to, insert: xmlstring }
    await this.#waitForEditorUpdate(changes);
  }

  /**
   * Update the complete editor content from the XML Document. When dealing with small changes,
   * use {@link updateEditorFromNode} instead.
   */
  async updateEditorFromXmlTree() {
    const changes = { from: 0, to: this.#view.state.doc.length, insert: this.getXML() }
    await this.#waitForEditorUpdate(changes);
  }

  /**
   * Updates the given node with the XML text from the editor
   * @param {Node} node A XML node
   */
  async updateNodeFromEditor(node){
    const {to, from} = this.getSyntaxNodeFromDomNode(node)
    node.outerHTML = this.#view.state.doc.sliceString(from, to)
    this.#updateMaps()
  }

  /**
   * Returns the internal syntax tree reprentation of the XML document
   * @returns {Object}
   */
  getSyntaxTree() {
    return this.#syntaxTree;
  }

  /**
   * Given a XML DOM node, return its position in the editor
   * @param {Node} domNode The node in the XML DOM
   * @returns {number}
   */
  getDomNodePosition(domNode) {
    return this.#domToSyntax.get(domNode)
  }

  /**
   * Given a node in the XML document, return the corresponding syntax tree object
   * @param {Node} domNode A node in the XML DOM 
   * @returns {Object} A SyntaxNode objectz
   */
  getSyntaxNodeFromDomNode(domNode) {
    const pos = this.getDomNodePosition(domNode)
    return this.getSyntaxNodeAt(pos)
  }

  /**
   * Given a node in the syntax tree, return the corresponding node in the XML DOM
   * @param {Object} syntaxNode The syntax node
   * @returns {Node}
   */
  getDomNodeFromSyntaxNode(syntaxNode) {
    const pos = syntaxNode.from
    return this.getDomNodeAt(pos)
  }

  /**
   * Returns the syntax node at the given position, or its next Element or Document ancestor if the findParentElement parameter is true (default)
   * @param {number} pos The cursor position in the document
   * @param {boolean} findParentElement If true, find the next ancestor which is an Element or Document Node
   * @returns {SyntaxNode}
   */
  getSyntaxNodeAt(pos, findParentElement = true) {
    let syntaxNode = syntaxTree(this.#view.state).resolveInner(pos, 1);
    // find the element parent if necessary
    if (findParentElement) {
      while (syntaxNode && !['Element', 'Document'].includes(syntaxNode.name)) {
        syntaxNode = syntaxNode.parent;
      }
    }
    if (!syntaxNode) {
      throw new Error(`No syntax node found at position ${pos}.`);
    }
    return syntaxNode;
  }

  getDomNodeAt(pos) {
    if (!this.#syntaxToDom) {
      this.#updateMaps()
    }
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
   * Returns the DOM nodes that matches the given XPath expression.
   * @param {string} xpath 
   * @returns {Array<Node>} An array of matching node snapshots.
   * @throws {Error} If the XML tree is not loaded
   */
  getDomNodesByXpath(xpath) {
    if (!this.#xmlTree) {
      throw new Error("XML tree is not loaded.");
    }
    if (!xpath) {
      throw new Error("XPath is not provided.");
    }
    const xpathResult = this.#xmlTree.evaluate(xpath, this.#xmlTree, this.#namespaceResolver, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    const result = []
    let node;
    while ((node = xpathResult.iterateNext())) {
      result.push(node)
    }
    return result;
  }

  /**
   * Returns the DOM nodes that matches the given XPath expression.
   * @param {string} xpath 
   * @returns {Array<Node>} An array of matching node snapshots.
   * @throws {Error} If the XML tree is not loaded
   */
  countDomNodesByXpath(xpath) {
    if (!this.#xmlTree) {
      throw new Error("XML tree is not loaded.");
    }
    if (!xpath) {
      throw new Error("XPath is not provided.");
    }
    xpath = `count(${xpath})`
    return this.#xmlTree.evaluate(xpath, this.#xmlTree, this.#namespaceResolver, XPathResult.NUMBER_TYPE, null).numberValue;
  }

  /**
   * Returns the first DOM node that matches the given XPath expression.
   * @param {string} xpath 
   * @returns {Node} The first matching DOM node.
   * @throws {Error} If the XML tree is not loaded or if no nodes match the XPath expression.
   */
  getDomNodeByXpath(xpath) {
    if (!this.#xmlTree) {
      throw new Error("XML tree is not loaded.");
    }
    if (!xpath) {
      throw new Error("XPath is not provided.");
    }
    const xpathResult = this.#xmlTree.evaluate(xpath, this.#xmlTree, this.#namespaceResolver, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const result = xpathResult.singleNodeValue;
    //console.warn(xpath, result)
    return result
  }

  /**
   * Returns the first syntax node that matches the given XPath expression.
   * @param {string} xpath 
   * @returns {SyntaxNode} The first matching syntax node.
   * @throws {Error} If the XML tree is not loaded, if no DOM node match the XPath expression, or no syntax node can be found for the DOM node.
   */
  getSyntaxNodeByXpath(xpath) {
    if (!this.#domToSyntax) {
      this.#updateMaps()
    }
    const node = this.getDomNodeByXpath(xpath)
    if (!node) {
      throw new Error(`No XML node found for XPath: ${xpath}`);
    }
    const pos = this.#domToSyntax.get(node);
    if (!pos) {
      throw new Error(`No syntax node found for XPath: ${xpath}`);
    }
    return this.getSyntaxNodeAt(pos);
  }

  /**
   * Selects the DOM node that matches the given XPath expression in the editor.
   * @param {string} xpath - The XPath expression to select.
   * @throws {Error} If the XML tree is not loaded, if no DOM node match the XPath expression, or no syntax node can be found for the DOM node.
   */
  selectByXpath(xpath) {
    const { from, to } = this.getSyntaxNodeByXpath(xpath);
    this.#view.dispatch({
      selection: EditorSelection.range(from, to),
      scrollIntoView: true
    });
  }

  /**
   * Generates an XPath expression to locate a given XML node within an XML document.
   * @author Gemini 2.0
   *
   * @param {Node} node The XML node to generate the XPath for.  Must be a descendant
   *                  of a document created by DOMParser.parseFromString.  If null or
   *                  undefined, returns null.
   * @returns {string|null} An XPath expression that uniquely identifies the node,
   *                       or null if the node is invalid or the xpath cannot be constructed.
   */
  getXPathForNode(node) {
    if (!node) {
      return null;
    }

    if (node.nodeType === Node.DOCUMENT_NODE) {
      return '/'; // Root document
    }

    if (node.nodeType === Node.ATTRIBUTE_NODE) {
      // XPaths for attributes are a bit different.  We need to find the parent
      // element first, then add the attribute name to the path.
      const parentPath = getXPathForNode(node.ownerElement);
      if (parentPath) {
        return parentPath + '/@' + node.name;
      } else {
        return null; // Could not determine parent's path.
      }
    }

    let path = '';
    let current = node;

    while (current && current.nodeType !== Node.DOCUMENT_NODE) {
      let index = 1; // XPath indexes are 1-based.
      let sibling = current.previousSibling;

      // Calculate the index of the current node among its siblings of the same type
      while (sibling) {
        if (sibling.nodeType === current.nodeType && sibling.nodeName === current.nodeName) {
          index++;
        }
        sibling = sibling.previousSibling;
      }

      let segment = current.nodeName;

      if (index > 1) {
        segment += `[${index}]`;
      }

      path = '/' + segment + path;
      current = current.parentNode;
    }

    if (current && current.nodeType === Node.DOCUMENT_NODE) {
      return path;
    }

    return null; // Unable to traverse all the way to the document root. This typically happens if the node doesn't belong to a DOMParser generated document.
  }

  //
  // private methods
  //

  #namespaceResolver(prefix) {
    const namespaces = {
      'tei': 'http://www.tei-c.org/ns/1.0',
      'xml': 'http://www.w3.org/XML/1998/namespace'
    };
    return namespaces[prefix] || null;
  };

  #onSelectionChange(ranges) {
    // add the selected node in the XML-DOM tree to each range
    if (ranges.length > 0) {
      for (const range of ranges) {
        try {
          const domNode = this.getDomNodeAt(ranges[0].from);
          range.node = domNode
          range.xpath = this.getXPathForNode(domNode)
        } catch (e) {
          // ignore errors
        }
      }
    }

    // inform the listeners
    this.dispatchEvent(new CustomEvent(XMLEditor.EVENT_SELECTION_CHANGED, { detail: ranges }))
  }

  async #onUpdate(update) {
    if (update.docChanged) {
      // update document version
      this.#documentVersion += 1;
      
      // update diagnostics
      forEachDiagnostic(this.#view.state, (d, from, to) => {
        d.from = from;
        d.to = to;
      });

      // sync DOM with text content and syntax tree
      await this.sync()
    }
  }


  /**
   * Synchronize xml document with the editor content
   * @returns {Promise<void>}
   */
  async sync() {
    try {
      if (await this.#updateTrees()) {
        this.#updateMaps()
        this.dispatchEvent(new Event(XMLEditor.EVENT_XML_CHANGED));  
      }
    } catch (error) {
      console.warn("Linking DOM and syntax tree failed:", error.message)
    }
  }

  /**
   * Synchronizes the syntax tree and the XML DOM
   * @returns {Promise<Boolean>} Returns true if the tree updates were successful and false if not
   */
  async #updateTrees() {
    this.#editorContent = this.#view.state.doc.toString();
    const doc = new DOMParser().parseFromString(this.#editorContent, "application/xml");
    const errorNode = doc.querySelector("parsererror");
    if (errorNode) {
      console.log("Document was updated but is not well-formed")
      this.#editorContent = null;
      this.#xmlTree = null;
      return false;
    }
    console.log("Document was updated and is well-formed.")
    this.#xmlTree = doc;

    // the syntax tree construction is async, so we need to wait for it to complete
    if (syntaxParserRunning(this.#view)){
      console.log('Waiting for syntax tree to be ready...')
      while (syntaxParserRunning(this.#view)) {
        await new Promise(resolve => setTimeout(resolve, 200)) 
      }
      console.log('Syntax tree is ready.')
    }
    this.#syntaxTree = syntaxTree(this.#view.state);
    return true
  }

  /**
   * Creates internal maps that link the syntax tree and the dom nodes
   */
  #updateMaps() {
    const maps = linkSyntaxTreeWithDOM(this.#view, this.#syntaxTree.topNode, this.#xmlTree);
    const { syntaxToDom, domToSyntax } = maps;
    this.#syntaxToDom = syntaxToDom;
    this.#domToSyntax = domToSyntax;
  }
}
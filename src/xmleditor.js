import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { xml, xmlLanguage } from "@codemirror/lang-xml";
import { linter, lintGutter, forceLinting } from "@codemirror/lint";
import { createCompletionSource } from './autocomplete.js';
import { syntaxTree } from "@codemirror/language";
import { lintSource, isValidating, anyCurrentValidation, validationIsDisabled, disableValidation } from './lint.js';
import { selectionChangeListener, linkSyntaxTreeWithDOM } from './codemirror_utils.js';
import { $ } from './browser-utils.js';


export class XMLEditor extends EventTarget {
  static EVENT_SELECTION_CHANGED = "selectionChanged";
  static EVENT_XML_CHANGED = "xmlChanged";

  // private members
  #view = null; // the EditorView instance
  #documentVersion = null; // internal counter to track changes in the document
  #editorContent = ''; // a cache of the raw text content of the editor
  #syntaxToDom = null; // Maps syntax tree nodes to DOM nodes
  #domToSyntax = null; // Maps DOM nodes to syntax tree nodes
  #xmlTree = null; // the xml document tree
  #syntaxTree = null; // the lezer syntax tree
  #isReady = false;
  #readyPromise = null;
  #readyPromiseResolvers = null;

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

    // display xml in editor, this triggers the update handlers
    this.#view.dispatch({
      changes: { from: 0, to: this.#view.state.doc.length, insert: xml },
      selection: EditorSelection.cursor(0)
    });
    this.#documentVersion = 0;
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
      $('#btn-save-document').innerHTML = "Waiting for validation..."
      $('#btn-save-document').disabled = true;
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
    const serializer = new XMLSerializer();
    return serializer.serializeToString(this.#xmlTree);
  }

  updateFromXmlTree() {
    this.#view.dispatch({
      changes: { from: 0, to: this.#view.state.doc.length, insert: this.getXML() }
    });
  }

  getSyntaxTree() {
    return this.#syntaxTree;
  }

  getSyntaxNodeFromDomNode(domNode) {
    return this.#domToSyntax.get(domNode)
  }

  getDomNodeFromSyntaxNode(syntaxNode) {
    return this.#syntaxToDom.get(syntaxNode)
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

  #onUpdate(update) {
    if (update.docChanged) {
      this.#documentVersion += 1;
      this.#updateTrees()
      try {
        this.#updateMaps()
        this.dispatchEvent(new Event(XMLEditor.EVENT_XML_CHANGED));
      } catch (error) {
        // todo: this often fails the first time for reasons unknown, needs to be investigated
        console.warn("Linking DOM and syntax tree failed:", error.message)
      }
    }
  }

  #updateTrees() {
    this.#editorContent = this.#view.state.doc.toString();
    const doc = new DOMParser().parseFromString(this.#editorContent, "application/xml");
    const errorNode = doc.querySelector("parsererror");
    if (errorNode) {
      //console.log("Document was updated but is not well-formed:", error.message)
      this.#editorContent = null;
      this.#xmlTree = null;
      return;
    }
    //console.log("Document was updated and is well-formed.")
    this.#xmlTree = doc;
    this.#syntaxTree = syntaxTree(this.#view.state);
  }

  #updateMaps() {
    const maps = linkSyntaxTreeWithDOM(this.#view, this.#syntaxTree.topNode, this.#xmlTree);
    const { syntaxToDom, domToSyntax } = maps;
    this.#syntaxToDom = syntaxToDom;
    this.#domToSyntax = domToSyntax;
  }

}
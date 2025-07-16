/**
 * @import {SyntaxNode, Tree} from '@lezer/common'
 * @import {Extension, Range} from '@codemirror/state'
 * @import {ViewUpdate} from '@codemirror/view'
 */

import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection, Compartment } from "@codemirror/state";
import { unifiedMergeView, goToNextChunk, goToPreviousChunk, getChunks, rejectChunk } from "@codemirror/merge"
import { EditorView, keymap } from "@codemirror/view";
import { xml, xmlLanguage } from "@codemirror/lang-xml";
import { createCompletionSource } from './autocomplete.js';
import { syntaxTree, syntaxParserRunning } from "@codemirror/language";

// custom modules

import { selectionChangeListener, linkSyntaxTreeWithDOM, isExtension } from './codemirror_utils.js';
import { $$ } from './browser-utils.js';

/**
 * An XML editor based on the CodeMirror editor, which keeps the CodeMirror syntax tree and a DOM XML 
 * tree in sync as far as possible, and provides linting and diffing.
 */
export class XMLEditor extends EventTarget {

  /**
   * @event SectionChangedEvent
   * @type {ViewUpdate}
   */
  /** @type {string} */  
  static EVENT_SELECTION_CHANGED = "selectionChanged";

  /**
   * @event XmlChangedEvent
   * @type {ViewUpdate}
   */
  /** @type {string} */  
  static EVENT_XML_CHANGED = "xmlChanged";
  
  /**
   * @event EditorUpdateEvent
   * @type {ViewUpdate}
   */
  /** @type {string} */
  static EVENT_EDITOR_UPDATE ="editorUpdate"

  /**
   * @event EditorUpdateDelayedEvent
   * @type {ViewUpdate}
   */
  /** @type {string} */
  static EVENT_EDITOR_DELAYED_UPDATE ="editorUpdateDelayed"

  /**
   * @event EditorXmlNotWellFormedEvent
   * @type {ViewUpdate}
   */
  /** @type {string} */
  static EVENT_EDITOR_XML_NOT_WELL_FORMED = "editorXmlNotWellFormed"


  /**
   * @event EditorXmlWellFormedEvent
   * @type {ViewUpdate}
   */
  /** @type {string} */
  static EVENT_EDITOR_XML_WELL_FORMED = "editorXmlWellFormed"  

  // private members

  /** @type {EditorView} */
  #view // the EditorView instance

  #documentVersion = 0 // internal counter to track changes in the document

  #editorContent = '' // a cache of the raw text content of the editor

  /** @type {Map} */
  #syntaxToDom; // Maps syntax tree nodes to DOM nodes

  /** @type {Map} */
  #domToSyntax; // Maps DOM nodes to syntax tree nodes

  /** @type {Document|null} */
  #xmlTree; // the xml document tree or null if xml text is invalid

  /** @type {Tree} */
  #syntaxTree // the lezer syntax tree

  #isReady = false

  /** @type {Promise | null} */
  #readyPromise

  /** @type {Object} */
  #mergeViewExt

  /** @type {string} */
  #original // the original XML document, when in merge view mode

  #updateMergButtonsInterval // interval to update the merge buttons

  /**  @type {XMLSerializer} */
  #serializer; // an XMLSerializer object or one with a compatible API

  /** @type {Compartment} */
  #mergeViewCompartment = new Compartment()

  /** @type {Compartment} */
  #autocompleteCompartment = new Compartment()

  /** @type {Compartment} */
  #linterCompartment = new Compartment()

  /** @type {Compartment} */
  #updateListenerCompartment = new Compartment()

  /** @type {Compartment} */
  #selectionChangeCompartment = new Compartment()

   /** @type {Compartment} */
  #lineWrappingCompartment = new Compartment()

  /**
   * Constructs an XMLEditor instance.
   * @param {string} editorDivId - The ID of the div element where the XML editor will be shown.
   * @param {Object?} tagData - Autocompletion data
   */
  constructor(editorDivId, tagData) {
    super();

    this.#markAsNotReady()

    const editorDiv = document.getElementById(editorDivId);
    if (!editorDiv) {
      throw new Error(`Element with ID ${editorDivId} not found.`);
    }

    // list of extensions to be used in the editor
    const extensions = [
      basicSetup,
      xml(),
      this.#linterCompartment.of([]),
      this.#selectionChangeCompartment.of([]),
      this.#updateListenerCompartment.of([]),
      this.#mergeViewCompartment.of([]),
      this.#autocompleteCompartment.of([]),
      this.#lineWrappingCompartment.of([])
    ];

    if (tagData) {
      this.startAutocomplete(tagData);
    }

    this.#view = new EditorView({
      state: EditorState.create({ doc: "", extensions }),
      parent: editorDiv
    });
    this.#serializer = new XMLSerializer();
    this.addSelectionChangeListener(this.#onSelectionChange.bind(this))
    this.addUpdateListener(this.#onUpdate.bind(this))
  }

  /**
   * Resolves a namespace prefix used in the editor to its URI.
   * @todo: should be configurable  by the user
   * @param {string|null} prefix The namespace prefix to resolve.
   * @returns {string|null} The namespace URI associated with the prefix, or empty if not found.
   */
  namespaceResolver(prefix) {
    const namespaces = {
      'tei': 'http://www.tei-c.org/ns/1.0',
      'xml': 'http://www.w3.org/XML/1998/namespace'
    }
    return namespaces[prefix] || null;
  };

  /**
   * Add one or more linter extensions to the editor
   * @param {Extension} extension 
   */
  addLinter(extension) {
    if (!isExtension(extension)) {
      console.log(extension)
      throw new TypeError("Argument must have the Extension interface")
    }
    const extensions = this.#linterCompartment.get(this.#view.state) || []
    this.#view.dispatch({
      effects: this.#linterCompartment.reconfigure([extensions, extension])
    });
  }

  /**
   * Adds an update listener
   * @param {(update:ViewUpdate) => void} listener 
   */
  addUpdateListener(listener){
    if (typeof listener != "function"){
      throw new TypeError("Argument must be a function")
    }
    const listeners = this.#updateListenerCompartment.get(this.#view.state) || []
    this.#view.dispatch({
      effects: this.#updateListenerCompartment.reconfigure([listeners, EditorView.updateListener.of(listener) ])
    })
  }

  /**
   * Adds an selection change listener
   * @param {(ranges:Range[]) => void} listener 
   */
  addSelectionChangeListener(listener) {
    if (typeof listener != "function"){
      throw new TypeError("Argument must be a function")
    }
    const listeners = this.#selectionChangeCompartment.get(this.#view.state) || []
    this.#view.dispatch({
      effects: this.#selectionChangeCompartment.reconfigure([listeners, selectionChangeListener(listener)])
    })
  }

  /**
   * Returns the current state of the editor. If false await the promise returned from 
   * isReadyPromise()
   * @returns {boolean} - Returns true if the editor is ready and the XML document is loaded
   */
  isReady() {
    return this.#isReady
  }

  /**
   * Returns a promise that resolves when the editor is ready, the XML document is loaded and
   * both syntax and xml trees are configured and synchronized
   * @returns {Promise | null} - A promise that resolves when the editor is ready and the XML document is loaded
   */
  isReadyPromise() {
    return this.#readyPromise
  }

  /**
   * A method that returns a promise that resolves when the editor is ready
   * @returns {Promise<void>}
   */
  async whenReady() {
    return this.#isReady ? Promise.resolve() : this.#readyPromise
  }

  /**
   * Loads XML, either from a string or from a given path.
   * @async
   * @param {string} xmlPathOrString - The URL or path to the XML file, or an xml string
   * @returns {Promise<void>} - A promise that resolves with no value when the document is fully loaded and the editor is ready. 
   * @throws {Error} - If there's an error loading or parsing the XML.
   */
  async loadXml(xmlPathOrString) {
    // this created the isReadyPromise
    this.#markAsNotReady()

    // fetch xml if path 
    const xml = await this.#fetchXml(xmlPathOrString);

    // display xml in editor, this triggers the update handlers
    this.#view.dispatch({
      changes: { from: 0, to: this.#view.state.doc.length, insert: xml },
      selection: EditorSelection.cursor(0)
    });
    this.#documentVersion = 0;
    await this.isReadyPromise();
  }

  /**
   * Loads and displays a merge view for the given XML file or string.
   * @param {string} xmlPathOrString The URL or path to the XML file, or an xml string
   * @returns {Promise<void>} A promise that resolves when the merge view is shown
   * @throws {Error} If there's an error loading or parsing the XML.
   */
  async showMergeView(xmlPathOrString) {
    // remove existing merge view
    await this.hideMergeView()

    // fetch xml if it is a path 
    const diff = await this.#fetchXml(xmlPathOrString);

    // create and display merge view with the original 
    this.#mergeViewExt = unifiedMergeView({
      original: diff,
      diffConfig: { scanLimit: 50000, timeout: 20000 }
    })

    this.#view.dispatch({
      effects: this.#mergeViewCompartment.reconfigure([this.#mergeViewExt])
    });

    // Overwrite the default button labels
    this.#updateMergButtonsInterval = setInterval(() => {
      $$('button[name="accept"]').forEach(b => b.innerHTML = 'Keep')
      $$('button[name="reject"]').forEach(b => b.innerHTML = 'Change')
    }, 200)
  }

  /**
   * Checks if the merge view is active.
   * @returns {boolean} Returns true if the merge view is active
   */
  isMergeViewActive() {
    return this.#mergeViewExt != null
  }

  /**
   * Removes the merge view from the editor and restores the original content.
   * @returns {Promise<void>} A promise that resolves when the merge view is hidden
   */
  async hideMergeView() {
    if (this.#mergeViewExt) {
      // stop updating the buttons
      clearInterval(this.#updateMergButtonsInterval)
      this.#updateMergButtonsInterval = null
      // remove the merge view
      this.#view.dispatch({
        effects: this.#mergeViewCompartment.reconfigure([])
      });
      this.#mergeViewExt = null;
      this.#original = '';
    }
  }

  /**
   * Move the selection to the previous diff
   */
  goToPreviousDiff() {
    if (!this.isMergeViewActive()) {
      throw new Error("Not in merge view")
    }
    goToPreviousChunk(this.#view)
  }

  /**
   * Moves the selection to the next diff
   */
  goToNextDiff() {
    if (!this.isMergeViewActive()) {
      throw new Error("Not in merge view")
    }
    goToNextChunk(this.#view)
  }

  /**
   * Accept all remaining changes in the document
   */
  acceptAllDiffs() {
    if (!this.isMergeViewActive()) {
      throw new Error("Not in merge view")
    }
    const state = this.#view.state;
    //const originalDocument = getOriginalDoc(state);
    const { chunks } = getChunks(state) || {};
    let changes = [];
    for (const chunk of chunks || []) {
      //const originalChunkText = originalDocument.sliceString(chunk.fromB, chunk.toB);
      rejectChunk(this.#view, chunk.fromA)
      // changes.push({
      //   from: chunk.fromA, 
      //   to: chunk.toA,
      //   insert: originalChunkText
      // });
    }
    this.hideMergeView()

    // changes = changes.slice(0,3)
    // console.log(changes)

    // this.#view.dispatch({ changes });
  }

  /**
   * Reject all open changes in the diff. Equivalent to removing the merge view.
   */
  rejectAllDiffs() {
    this.hideMergeView()
  }

  /**
   * Given a data object with information on the XML schema, start suggesting autocompletions
   * @param {Object} tagData The autocompletion data - todo document format
   */
  startAutocomplete(tagData) {
    const autocompleteExtension = xmlLanguage.data.of({ autocomplete: createCompletionSource(tagData) })
    //this.#autocompleteCompartment.reconfigure([autocompleteExtension])
    this.#view.dispatch({
      effects: this.#autocompleteCompartment.reconfigure([autocompleteExtension])
    });    
  }

  /**
   * Stop suggestion autocompletions
   */
  stopAutocomplete() {
    this.#view.dispatch({
      effects: this.#autocompleteCompartment.reconfigure([])
    });    
  }

  /**
   * Returns an integer that represents the current document version. This is incremented
   * whenever the document is changed in the editor.
   * @returns {number} The current document version
   */
  getDocumentVersion() {
    return this.#documentVersion;
  }

  /**
   * Returns the current editor view.
   * @returns {EditorView} The current editor view
   */
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

  /**
   * Returns the XML document tree.
   * @returns {Document|null} - The XML document tree.
   */
  getXmlTree() {
    return this.#xmlTree;
  }

  /**
   * Returns the string representation of the XML tree, if one exists
   * @returns {string} 
   */
  getXML() {
    if ( this.#xmlTree) {
      return this.#serialize(this.#xmlTree, /* do not remove namespace declaration */ false)
    }
    return ''
  }

  /**
   * Toggles line wrapping on and off
   * @param {boolean} value 
   */
  setLineWrapping(value) {
    this.#view.dispatch({
      effects: [this.#lineWrappingCompartment.reconfigure(
        value ? EditorView.lineWrapping : []
      )]
    });
  }

  /**
   * Updates the editor from a node in the XML Document. Returns a promise that resolves when
   * the editor is updated
   * @param {Element} node A XML DOM node
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
   * @param {Element} node A XML node
   */
  async updateNodeFromEditor(node) {
    const { to, from } = this.getSyntaxNodeFromDomNode(node)
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
   * @param {Element} domNode The node in the XML DOM
   * @returns {number}
   */
  getDomNodePosition(domNode) {
    return this.#domToSyntax.get(domNode)
  }

  /**
   * Given a node in the XML document, return the corresponding syntax tree object
   * @param {Element} domNode A node in the XML DOM 
   * @returns {Object} A SyntaxNode objectz
   */
  getSyntaxNodeFromDomNode(domNode) {
    const pos = this.getDomNodePosition(domNode)
    return this.getSyntaxNodeAt(pos)
  }

  /**
   * Given a node in the syntax tree, return the corresponding node in the XML DOM
   * @param {Object} syntaxNode The syntax node
   * @returns {Element}
   */
  getDomNodeFromSyntaxNode(syntaxNode) {
    const pos = syntaxNode.from
    return this.getDomNodeAt(pos)
  }

  /**
   * Returns the syntax node at the given position, or its next Element or Document ancestor if the 
   * findParentElement parameter is true (default).
   * @param {number} pos The cursor position in the document
   * @param {boolean} findParentElement If true, find the next ancestor which is an Element or Document Node
   * @returns {SyntaxNode}
   */
  getSyntaxNodeAt(pos, findParentElement = true) {
    let syntaxNode = syntaxTree(this.#view.state).resolveInner(pos, 1);
    // find the element parent if necessary
    if (findParentElement) {
      while (syntaxNode && !['Element', 'Document'].includes(syntaxNode.name)) {
        // @ts-ignore
        syntaxNode = syntaxNode.parent;
      }
    }
    if (!syntaxNode) {
      throw new Error(`No syntax node found at position ${pos}.`);
    }
    return syntaxNode;
  }

  /**
   * Returns the XML DOM node at the given position in the editor
   * @param {number} pos 
   * @returns {Element}
   */
  getDomNodeAt(pos) {
    if (!this.#syntaxToDom) {
      this.#updateMaps()
    }
    let syntaxNode = this.getSyntaxNodeAt(pos);
    // find the element parent if necessary
    while (syntaxNode && !['Element', 'Document'].includes(syntaxNode.name)) {
      // @ts-ignore
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
    // @ts-ignore
    const xpathResult = this.#xmlTree.evaluate(xpath, this.#xmlTree, this.namespaceResolver, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
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
   * @returns {Number} An array of matching node snapshots.
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
    // @ts-ignore
    return this.#xmlTree.evaluate(xpath, this.#xmlTree, this.namespaceResolver, XPathResult.NUMBER_TYPE, null).numberValue;
  }

  /**
   * Returns the first DOM node that matches the given XPath expression.
   * @param {string} xpath 
   * @returns {Node|null} The first matching DOM node.
   * @throws {Error} If the XML tree is not loaded or if no nodes match the XPath expression.
   */
  getDomNodeByXpath(xpath) {
    if (!this.#xmlTree) {
      throw new Error("XML tree is not loaded.");
    }
    if (!xpath) {
      throw new Error("XPath is not provided.");
    }
    // @ts-ignore
    const xpathResult = this.#xmlTree.evaluate(xpath, this.#xmlTree, this.namespaceResolver, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const result = xpathResult.singleNodeValue;
    //console.warn(xpath, result)
    return result
  }

  /**
   * Returns the first syntax node that matches the given XPath expression. Should be private?
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
   * @param {Element} node The XML node to generate the XPath for.  Must be a descendant
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
      // @ts-ignore
      /** @type {Attr} */ const attrNode = node
      const ownerNode = attrNode.ownerElement;
      if (ownerNode) {
        const parentPath = this.getXPathForNode(ownerNode);
        return parentPath + '/@' + attrNode.name;
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
      // @ts-ignore
      current = current.parentNode;
    }

    if (current && current.nodeType === Node.DOCUMENT_NODE) {
      return path;
    }

    return null; // Unable to traverse all the way to the document root. This typically happens if the node doesn't belong to a DOMParser generated document.
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

  //
  // private methods which are not part of the API and hide implementation details
  // 

  /**
   * Marks the editor as not ready and reates the isReadyPromise if it does not already exist
   * already exists 
   */
  #markAsNotReady() {
    this.#isReady = false
    this.#readyPromise = this.#readyPromise || 
      /** @type {Promise<void>} */(new Promise(resolve => {
        this.addEventListener(XMLEditor.EVENT_XML_CHANGED, () => {
          this.#isReady = true
          this.#readyPromise = null
          resolve();
        }, { once: true })
      }
    ))
  }

  /**
   * serializes the node (or the complete xmlTree if no node is given) to an XML string
   * @param {Element|Document} node The node to serialize
   * @param {boolean} [removeNamespaces=true] Whether to remove the namespace declaration in the output
   */
  #serialize(node, removeNamespaces = true) {
    if (!(node && node instanceof Node)) {
      throw new TypeError("No node provided")
    }
    let xmlstring = this.#serializer.serializeToString(node)
    if (removeNamespaces) {
      xmlstring = xmlstring.replace(/ xmlns=".+?"/, '')
    }
    return xmlstring
  }

  /**
   * Given a string, if the string is an xml string, return it, otherwise treat it as a path
   * and load the xml string from this location
   * @param {string} xmlPathOrString A path to an xml file, or an XML string
   * @returns {Promise<string>} The xml string
   */
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
   * @typedef {Range} RangeWithNode
   * @property {Element?} node
   * @property {string?} xpath
   */

  /**
   * Called when the selection in the editor changes
   * @param {Range[]} ranges Array of range objects
   * @fires SelectionChangedEvent
   */
  async #onSelectionChange(ranges) {
    // wait for any editor operations to finish
    await this.whenReady()    
    let rangesWithNode = []
    // add the selected node in the XML-DOM tree to each range
    if (ranges.length > 0) {
      /** @type {RangeWithNode[]} */
      rangesWithNode = ranges.map(range => {
        try {
          const node = this.getDomNodeAt(ranges[0].from);
          const xpath = this.getXPathForNode(node)
          return Object.assign({node, xpath}, range)
        } catch (e) {
          console.warn(e.message)
          return range
        }
      })
    }  

    // inform the listeners
    this.dispatchEvent(new CustomEvent(XMLEditor.EVENT_SELECTION_CHANGED, { detail: rangesWithNode }))
  }

  #updateTimeout = null

  /**
   * Called when the content of the editor changes, emits events
   * @fires {}
   * @param {Object} update Object containing data on the change
   * @returns {Promise<void>}
   */
  async #onUpdate(update) {
    if (!update.docChanged) {
      return
    }

    // inform the listeners
    this.dispatchEvent(new CustomEvent(XMLEditor.EVENT_EDITOR_UPDATE, { detail: update }))

    if (this.#updateTimeout) {
      clearTimeout(this.#updateTimeout)
    }
    // @ts-ignore
    this.#updateTimeout = setTimeout(() => this.#delayedUpdateActions(update), 1000) // todo make configurable
  }

  /**
   * Called 1 second after the last change of the editor, i.e. any action executed here are not
   * executed while the user is typing. Syncs the Syntax and DOM trees.
   * @param {Object} update The update object dispatched by the view
   */
  async #delayedUpdateActions(update) {

    // update document version
    this.#documentVersion += 1;

    // sync DOM with text content and syntax tree
    await this.sync()

    // inform the listeners
    this.dispatchEvent(new CustomEvent(XMLEditor.EVENT_EDITOR_DELAYED_UPDATE, { detail: update }))
  }


  /**
   * Given an changes object, waits for the editor to be updated and then resolves the promise
   * @param {Object} changes The changes to apply to the editor
   */
  async #waitForEditorUpdate(changes) {
    const promise = new Promise(resolve => this.addEventListener(XMLEditor.EVENT_XML_CHANGED, resolve, { once: true }))
    this.#view.dispatch({ changes });
    await promise;
  }

  /**
   * Synchronizes the syntax tree and the XML DOM
   * @returns {Promise<Boolean>} Returns true if the tree updates were successful and false if not
   */
  async #updateTrees() {
    this.#editorContent = this.#view.state.doc.toString();
    const doc = new DOMParser().parseFromString(this.#editorContent, "application/xml");
    const errorNode = doc.querySelector("parsererror");
    console.log(errorNode)
    if (errorNode) {
      console.warn("Document was updated but is not well-formed")
      this.dispatchEvent(new Event(XMLEditor.EVENT_EDITOR_XML_NOT_WELL_FORMED, {detail: errorNode}))
      this.#xmlTree = null;
      return false;
    }
    console.log("Document was updated and is well-formed.")
    this.dispatchEvent(new Event(XMLEditor.EVENT_EDITOR_XML_WELL_FORMED))
    this.#xmlTree = doc;

    // the syntax tree construction is async, so we need to wait for it to complete
    if (syntaxParserRunning(this.#view)) {
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
    if (!(this.#xmlTree && this.#syntaxTree)) {
      throw new Error("XML or Syntax tree missing")
    }
    const maps = linkSyntaxTreeWithDOM(this.#view, this.#syntaxTree.topNode, this.#xmlTree);
    const { syntaxToDom, domToSyntax } = maps;
    this.#syntaxToDom = syntaxToDom;
    this.#domToSyntax = domToSyntax;
  }
}


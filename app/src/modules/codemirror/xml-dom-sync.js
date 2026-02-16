/**
 * CodeMirror v6 extension that synchronizes the editor's Lezer syntax tree
 * with a DOM XML tree parsed by DOMParser. Provides bidirectional maps between
 * syntax node positions and DOM nodes, tracks XML well-formedness, and detects
 * processing instructions.
 *
 * @example
 * import { EditorView } from "@codemirror/view";
 * import { EditorState, Compartment } from "@codemirror/state";
 * import { xmlDomSync, xmlDomSyncField, xmlTree, syntaxToDomMap, requestSyncEffect } from "./xml-dom-sync.js";
 *
 * // Add the extension (optionally via a Compartment for reconfiguration)
 * const syncCompartment = new Compartment();
 * const view = new EditorView({
 *   state: EditorState.create({
 *     doc: '<root><child/></root>',
 *     extensions: [
 *       syncCompartment.of(xmlDomSync({ debounceMs: 1000 })),
 *       // Observe sync state transitions
 *       EditorView.updateListener.of(update => {
 *         const oldSync = update.startState.field(xmlDomSyncField);
 *         const newSync = update.state.field(xmlDomSyncField);
 *         if (newSync.syncVersion !== oldSync.syncVersion) {
 *           console.log("Sync completed, well-formed:", newSync.isWellFormed);
 *           console.log("DOM tree:", xmlTree(update.view));
 *           console.log("Map entries:", syntaxToDomMap(update.view).size);
 *         }
 *       })
 *     ]
 *   })
 * });
 *
 * // Force an immediate sync (bypasses debounce)
 * view.dispatch({ effects: requestSyncEffect() });
 *
 * @module xml-dom-sync
 */

/**
 * @import {SyntaxNode, Tree} from '@lezer/common'
 * @import {Extension} from '@codemirror/state'
 * @import {ViewUpdate} from '@codemirror/view'
 * @import {Diagnostic} from '@codemirror/lint'
 */

/**
 * @typedef {Diagnostic & {line?: number, column?: number}} ExtendedDiagnostic
 */

/**
 * @typedef {object} ProcessingInstructionData
 * @property {string} target
 * @property {string} data
 * @property {Number} position
 * @property {string} fullText
 */

/**
 * @typedef {Object} XmlDomSyncMetadata
 * @property {boolean} isWellFormed - Whether the current XML is well-formed
 * @property {ExtendedDiagnostic[]} diagnostics - Parse error diagnostics (empty when valid)
 * @property {number} syncVersion - Incremented on each successful sync
 */

/**
 * @typedef {Object} XmlDomSyncConfig
 * @property {number} [debounceMs] - Debounce delay in ms (default 1000)
 */

import { StateField, StateEffect, Facet } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { syntaxTree, syntaxParserRunning } from "@codemirror/language";

// ─── StateEffects ───────────────────────────────────────────────────────────

/** @type {StateEffect<{syncVersion: number}>} */
const syncSucceeded = StateEffect.define();

/** @type {StateEffect<{diagnostics: ExtendedDiagnostic[]}>} */
const syncFailed = StateEffect.define();

/** @type {StateEffect<null>} */
const requestSync = StateEffect.define();

// ─── Facet (configuration) ──────────────────────────────────────────────────

/** @type {Facet<Partial<XmlDomSyncConfig>, XmlDomSyncConfig>} */
const xmlDomSyncConfig = Facet.define({
  combine(configs) {
    return {
      debounceMs: configs.reduce((a, c) => c.debounceMs ?? a, 1000),
    };
  }
});

// ─── StateField (immutable metadata) ────────────────────────────────────────

/** @type {StateField<XmlDomSyncMetadata>} */
export const xmlDomSyncField = StateField.define({
  create() {
    return {
      isWellFormed: false,
      diagnostics: [],
      syncVersion: 0
    };
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(syncSucceeded)) {
        return {
          isWellFormed: true,
          diagnostics: [],
          syncVersion: effect.value.syncVersion
        };
      }
      if (effect.is(syncFailed)) {
        return {
          ...value,
          isWellFormed: false,
          diagnostics: effect.value.diagnostics
        };
      }
    }
    return value;
  }
});

// ─── ViewPlugin (mutable state + sync engine) ───────────────────────────────

const xmlDomSyncPlugin = ViewPlugin.fromClass(
  class {
    /** @type {Document | null} */
    xmlTree = null;

    /** @type {Map<number, Node>} */
    syntaxToDom = new Map();

    /** @type {Map<Node, number>} */
    domToSyntax = new Map();

    /** @type {ProcessingInstructionData[]} */
    processingInstructions = [];

    /** @type {number} */
    syncVersion = 0;

    /** @type {ReturnType<typeof setTimeout> | null} */
    debounceTimer = null;

    /** @type {boolean} */
    syncInProgress = false;

    /**
     * @param {EditorView} view
     */
    constructor(view) {
      // Perform initial sync if there's content
      if (view.state.doc.length > 0) {
        setTimeout(() => this.performSync(view), 0);
      }
    }

    /**
     * @param {ViewUpdate} update
     */
    update(update) {
      // Check for requestSync effect — schedule immediate sync
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(requestSync)) {
            this.cancelDebounce();
            setTimeout(() => this.performSync(update.view), 0);
            return;
          }
        }
      }

      // Debounce on document changes
      if (update.docChanged) {
        this.cancelDebounce();
        const config = update.state.facet(xmlDomSyncConfig);
        this.debounceTimer = setTimeout(
          () => this.performSync(update.view),
          config.debounceMs
        );
      }
    }

    /**
     * @param {EditorView} view
     */
    async performSync(view) {
      if (this.syncInProgress) return;
      this.syncInProgress = true;

      try {
        const content = view.state.doc.toString();

        if (content.trim() === '') {
          this.xmlTree = null;
          this.syntaxToDom = new Map();
          this.domToSyntax = new Map();
          this.processingInstructions = [];
          view.dispatch({ effects: syncFailed.of({ diagnostics: [] }) });
          return;
        }

        // Parse XML
        const doc = new DOMParser().parseFromString(content, 'application/xml');
        const errorNode = doc.querySelector('parsererror');

        if (errorNode) {
          const diagnostics = parseErrorNode(errorNode, view.state.doc);
          this.xmlTree = null;
          this.syntaxToDom = new Map();
          this.domToSyntax = new Map();
          this.processingInstructions = [];
          view.dispatch({ effects: syncFailed.of({ diagnostics }) });
          return;
        }

        // XML is well-formed
        this.xmlTree = doc;

        // Wait for syntax parser to finish
        if (syntaxParserRunning(view)) {
          await waitForSyntaxParser(view);
        }

        // Build maps
        const tree = syntaxTree(view.state);
        try {
          const maps = linkSyntaxTreeWithDOM(view, tree.topNode, doc);
          this.syntaxToDom = maps.syntaxToDom;
          this.domToSyntax = maps.domToSyntax;
        } catch (error) {
          console.warn('Linking DOM and syntax tree failed:', String(error));
          this.syntaxToDom = new Map();
          this.domToSyntax = new Map();
        }

        // Detect processing instructions
        this.processingInstructions = detectProcessingInstructions(doc);

        this.syncVersion++;
        view.dispatch({
          effects: syncSucceeded.of({ syncVersion: this.syncVersion })
        });
      } finally {
        this.syncInProgress = false;
      }
    }

    cancelDebounce() {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
    }

    destroy() {
      this.cancelDebounce();
    }
  }
);

// ─── Accessor functions ─────────────────────────────────────────────────────

/**
 * Get the XML DOM tree from the view.
 * @param {EditorView} view
 * @returns {Document | null}
 */
export function xmlTree(view) {
  return view.plugin(xmlDomSyncPlugin)?.xmlTree ?? null;
}

/**
 * Get the syntax-to-DOM map from the view.
 * @param {EditorView} view
 * @returns {Map<number, Node>}
 */
export function syntaxToDomMap(view) {
  return view.plugin(xmlDomSyncPlugin)?.syntaxToDom ?? new Map();
}

/**
 * Get the DOM-to-syntax map from the view.
 * @param {EditorView} view
 * @returns {Map<Node, number>}
 */
export function domToSyntaxMap(view) {
  return view.plugin(xmlDomSyncPlugin)?.domToSyntax ?? new Map();
}

/**
 * Get processing instructions from the view.
 * @param {EditorView} view
 * @returns {ProcessingInstructionData[]}
 */
export function xmlSyncProcessingInstructions(view) {
  return view.plugin(xmlDomSyncPlugin)?.processingInstructions ?? [];
}

/**
 * Create a requestSync StateEffect for dispatching.
 * @returns {StateEffect<null>}
 */
export function requestSyncEffect() {
  return requestSync.of(null);
}

// ─── Extension factory ──────────────────────────────────────────────────────

/**
 * Creates the XML DOM sync extension.
 * @param {Partial<XmlDomSyncConfig>} [config]
 * @returns {Extension}
 */
export function xmlDomSync(config = {}) {
  return [
    xmlDomSyncConfig.of(config),
    xmlDomSyncField,
    xmlDomSyncPlugin
  ];
}

// ─── Helper functions ───────────────────────────────────────────────────────

/**
 * Parse a DOMParser error node into diagnostics.
 * @param {Node} errorNode The error node containing parse errors
 * @param {import("@codemirror/state").Text} doc The editor document (for line resolution)
 * @returns {ExtendedDiagnostic[]}
 */
function parseErrorNode(errorNode, doc) {
  const severity = "error";
  const textContent = errorNode.firstChild?.textContent;
  if (!textContent) {
    return [];
  }
  const [message, _, location] = textContent.split("\n");
  const regex = /\d+/g;
  const matches = location?.match(regex);
  if (matches && matches.length >= 2) {
    const line = parseInt(matches[0], 10);
    const column = parseInt(matches[1], 10);
    let { from, to } = doc.line(line);
    from = from + column - 1;
    return [{ message, severity, line, column, from, to }];
  }
  return [{ message: textContent, severity, from: 0, to: 0 }];
}

/**
 * Detect processing instructions in an XML document.
 * @param {Document} xmlDoc
 * @returns {ProcessingInstructionData[]}
 */
function detectProcessingInstructions(xmlDoc) {
  /** @type {ProcessingInstructionData[]} */
  const result = [];
  for (let i = 0; i < xmlDoc.childNodes.length; i++) {
    const node = xmlDoc.childNodes[i];
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      const piNode = /** @type {ProcessingInstruction} */ (node);
      result.push({
        target: piNode.target,
        data: piNode.data,
        position: i,
        fullText: `<?${piNode.target}${piNode.data ? ' ' + piNode.data : ''}?>`
      });
    }
  }
  return result;
}

/**
 * Wait for the CodeMirror syntax parser to finish.
 * @param {EditorView} view
 * @returns {Promise<void>}
 */
async function waitForSyntaxParser(view) {
  console.log('Waiting for syntax tree to be ready...');
  while (syntaxParserRunning(view)) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  console.log('Syntax tree is ready.');
}

// ─── linkSyntaxTreeWithDOM ──────────────────────────────────────────────────

/**
 * Links CodeMirror's syntax tree nodes representing XML elements with their corresponding DOM elements
 * parsed by DOMParser by traversing both trees recursively and storing references to each other in
 * two Maps. Enhanced to handle XML processing instructions and other non-element nodes.
 *
 * @param {EditorView} view The CodeMirror EditorView instance.
 * @param {SyntaxNode} syntaxNode The root syntax node of the CodeMirror XML editor's syntax tree.
 * @param {Element|Document} domNode The (root) DOM element parsed by DOMParser.
 * @throws {Error} If the tags of the syntax tree node and the DOM node do not match.
 * @returns {{syntaxToDom: Map<number, Node>, domToSyntax: Map<Node, number> }} An object containing two Maps:
 *                  - syntaxToDom: Maps the position of syntax tree nodes to DOM nodes.
 *                  - domToSyntax: Maps DOM nodes to syntax tree nodes' positions.
 */
function linkSyntaxTreeWithDOM(view, syntaxNode, domNode) {
  /** @type {Map<number, Node>} */
  const syntaxToDom = new Map();
  /** @type {Map<Node, number>} */
  const domToSyntax = new Map();

  /**
   * @param {SyntaxNode} node
   */
  const getText = node => view.state.doc.sliceString(node.from, node.to);

  /**
   * Helper to find the first element node in a tree
   * @param {SyntaxNode|Node} node Starting node
   * @param {boolean} [isDOM=false] Whether this is a DOM node (true) or syntax node (false)
   * @returns {SyntaxNode|Element|null} First element node found or null
   */
  function findFirstElement(node, isDOM = false) {
    while (node) {
      if (isDOM) {
        /** @type {Node} */
        const domNode = /** @type {Node} */ (node);
        if (domNode.nodeType === Node.ELEMENT_NODE) return /** @type {Element} */ (domNode);
      } else {
        /** @type {SyntaxNode} */
        const syntaxNode = /** @type {SyntaxNode} */ (node);
        if (syntaxNode.name === "Element") return syntaxNode;
      }
      const nextNode = node.nextSibling;
      if (!nextNode) break;
      node = nextNode;
    }
    return null;
  }

  /**
   * Collects all element children from a parent node
   * @param {SyntaxNode|Node} parent Parent node
   * @param {boolean} [isDOM=false] Whether this is a DOM node (true) or syntax node (false)
   * @returns {Array<SyntaxNode|Element>} Array of element nodes
   */
  function collectElementChildren(parent, isDOM = false) {
    const elements = [];
    let child = parent.firstChild;

    while (child) {
      const element = findFirstElement(child, isDOM);
      if (element) {
        elements.push(element);
        child = element.nextSibling;
      } else {
        break;
      }
    }
    return elements;
  }

  /**
   * @param {SyntaxNode} syntaxNode
   * @param {Element} domNode
   */
  function recursiveLink(syntaxNode, domNode) {

    if (!syntaxNode || !domNode) {
      throw new Error("Invalid arguments. Syntax node and DOM node must not be null.");
    }

    // Enhanced: Find the first element in each tree, handling processing instructions
    const syntaxElement = /** @type {SyntaxNode|null} */ (findFirstElement(syntaxNode, false));
    const domElement = /** @type {Element|null} */ (findFirstElement(domNode, true));

    // If we couldn't find matching element nodes, return empty maps
    if (!syntaxElement || !domElement) {
      return {
        syntaxToDom: new Map(),
        domToSyntax: new Map()
      };
    }

    // Check if the found elements are valid
    if (!syntaxElement || syntaxElement.name !== "Element") {
      throw new Error(`Unexpected node type: ${syntaxElement?.name}. Expected "Element".`);
    }

    // make sure we have a tag name child
    let syntaxTagNode = syntaxElement.firstChild?.firstChild?.nextSibling;
    if (!syntaxTagNode || syntaxTagNode.name !== "TagName") {
      const text = getText(syntaxElement);
      if (text === "<") {
        // hack
        syntaxTagNode = syntaxTagNode?.nextSibling;
      } else {
        throw new Error(`Expected a TagName child node in syntax tree. Found: ${text}`);
      }
    }

    if (!syntaxTagNode) {
      throw new Error('Could not find TagName node after processing');
    }
    const syntaxTagName = getText(syntaxTagNode);
    const domTagName = /** @type {Element} */ (domElement).tagName;

    // Verify that the tag names match
    if (syntaxTagName !== domTagName) {
      throw new Error(`Tag mismatch: Syntax tree has ${syntaxTagName}, DOM has ${domTagName}`);
    }

    // Store references to each other - since the syntax tree is regenerated on each lookup,
    // we need to store the unique positions of each node as reference
    syntaxToDom.set(/** @type {SyntaxNode} */ (syntaxElement).from, domElement);
    domToSyntax.set(domElement, /** @type {SyntaxNode} */ (syntaxElement).from);

    // Enhanced: Use robust child collection and pairing
    const syntaxChildren = collectElementChildren(syntaxElement, false);
    const domChildren = collectElementChildren(domElement, true);

    // Recursively link the children by pairs
    const minChildren = Math.min(syntaxChildren.length, domChildren.length);
    for (let i = 0; i < minChildren; i++) {
      recursiveLink(/** @type {SyntaxNode} */ (syntaxChildren[i]), /** @type {Element} */ (domChildren[i]));
    }

    // Check for mismatched child counts
    if (syntaxChildren.length > domChildren.length) {
      const extraSyntax = syntaxChildren.slice(domChildren.length);
      throw new Error(`Syntax tree has more child elements than the DOM tree: ${extraSyntax.map(n => getText(/** @type {SyntaxNode} */ (n))).join(', ')}`);
    }
    if (domChildren.length > syntaxChildren.length) {
      const extraDOM = domChildren.slice(syntaxChildren.length);
      throw new Error(`DOM tree has more child elements than the syntax tree: ${extraDOM.map(n => /** @type {Element} */ (n).tagName).join(', ')}`);
    }
    return {
      syntaxToDom,
      domToSyntax
    };
  }

  if (syntaxNode.name !== "Document" || domNode.nodeType !== Node.DOCUMENT_NODE) {
    throw new Error("Invalid arguments. The root syntax node must be the top Document node and the DOM node must be a document. Received: " +
      `syntaxNode: ${syntaxNode.name}, domNode: ${Object.keys(Node)[domNode.nodeType - 1]}`);
  }

  // Enhanced: Find root elements, skipping processing instructions and other non-element nodes
  const syntaxRoot = syntaxNode.firstChild ? /** @type {SyntaxNode|null} */ (findFirstElement(syntaxNode.firstChild, false)) : null;
  const domRoot = domNode.firstChild ? /** @type {Element|null} */ (findFirstElement(domNode.firstChild, true)) : null;

  if (!syntaxRoot || !domRoot) {
    console.warn("Could not find root elements in one or both trees");
    return {
      syntaxToDom: new Map(),
      domToSyntax: new Map()
    };
  }

  return recursiveLink(syntaxRoot, domRoot);
}

/**
 * Pure tree-linking logic for matching Lezer syntax tree nodes with DOM elements.
 * No CodeMirror dependencies — can be imported in Node.js tests.
 *
 * @module xml-dom-link
 */

/**
 * @import {SyntaxNode} from '@lezer/common'
 */

// ─── Tree traversal helpers ─────────────────────────────────────────────────

/**
 * Find the first Lezer Element node starting from the given node, walking siblings.
 * @param {SyntaxNode} node
 * @returns {SyntaxNode|null}
 */
export function findFirstSyntaxElement(node) {
  while (node) {
    if (node.name === "Element") return node;
    const next = node.nextSibling;
    if (!next) break;
    node = next;
  }
  return null;
}

/**
 * Find the first DOM Element node starting from the given node, walking siblings.
 * @param {Node} node
 * @returns {Element|null}
 */
export function findFirstDomElement(node) {
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) return /** @type {Element} */ (node);
    const next = node.nextSibling;
    if (!next) break;
    node = next;
  }
  return null;
}

/**
 * Collect all Lezer Element children of a parent syntax node.
 * @param {SyntaxNode} parent
 * @returns {SyntaxNode[]}
 */
export function collectSyntaxElementChildren(parent) {
  /** @type {SyntaxNode[]} */
  const elements = [];
  let child = parent.firstChild;
  while (child) {
    const element = findFirstSyntaxElement(child);
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
 * Collect all DOM Element children of a parent node.
 * @param {Node} parent
 * @returns {Element[]}
 */
export function collectDomElementChildren(parent) {
  /** @type {Element[]} */
  const elements = [];
  let child = parent.firstChild;
  while (child) {
    const element = findFirstDomElement(child);
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
 * Find the TagName node within a Lezer Element's OpenTag or SelfClosingTag.
 * Walks children instead of assuming a fixed structure.
 * @param {SyntaxNode} syntaxElement
 * @returns {SyntaxNode|null}
 */
export function findTagNameNode(syntaxElement) {
  const tagContainer = syntaxElement.firstChild;
  if (!tagContainer) return null;
  let child = tagContainer.firstChild;
  while (child) {
    if (child.name === "TagName") return child;
    child = child.nextSibling;
  }
  return null;
}

// ─── linkSyntaxTreeWithDOM ──────────────────────────────────────────────────

/**
 * Links Lezer syntax tree nodes with their corresponding DOM elements by
 * traversing both trees recursively. Accepts a getText callback instead of
 * an EditorView for testability.
 *
 * @param {(from: number, to: number) => string} getText Callback to read text from the document.
 * @param {SyntaxNode} syntaxNode The root Document syntax node.
 * @param {Element|Document} domNode The DOM document parsed by DOMParser.
 * @throws {Error} If the tags of the syntax tree node and the DOM node do not match.
 * @returns {{syntaxToDom: Map<number, Node>, domToSyntax: Map<Node, number>}}
 */
export function linkSyntaxTreeWithDOM(getText, syntaxNode, domNode) {
  /** @type {Map<number, Node>} */
  const syntaxToDom = new Map();
  /** @type {Map<Node, number>} */
  const domToSyntax = new Map();

  /**
   * @param {SyntaxNode} syntaxNode
   * @param {Element} domNode
   */
  function recursiveLink(syntaxNode, domNode) {
    if (!syntaxNode || !domNode) {
      throw new Error("Invalid arguments. Syntax node and DOM node must not be null.");
    }

    const syntaxElement = findFirstSyntaxElement(syntaxNode);
    const domElement = findFirstDomElement(domNode);

    if (!syntaxElement || !domElement) {
      return;
    }

    if (syntaxElement.name !== "Element") {
      throw new Error(`Unexpected node type: ${syntaxElement.name}. Expected "Element".`);
    }

    const syntaxTagNode = findTagNameNode(syntaxElement);
    if (!syntaxTagNode) {
      throw new Error(`Could not find TagName in syntax element at position ${syntaxElement.from}`);
    }

    const syntaxTagName = getText(syntaxTagNode.from, syntaxTagNode.to);
    const domTagName = domElement.tagName;

    if (syntaxTagName !== domTagName) {
      throw new Error(`Tag mismatch: Syntax tree has ${syntaxTagName}, DOM has ${domTagName}`);
    }

    syntaxToDom.set(syntaxElement.from, domElement);
    domToSyntax.set(domElement, syntaxElement.from);

    const syntaxChildren = collectSyntaxElementChildren(syntaxElement);
    const domChildren = collectDomElementChildren(domElement);

    const minChildren = Math.min(syntaxChildren.length, domChildren.length);
    for (let i = 0; i < minChildren; i++) {
      recursiveLink(syntaxChildren[i], domChildren[i]);
    }

    if (syntaxChildren.length > domChildren.length) {
      const extra = syntaxChildren.slice(domChildren.length);
      throw new Error(`Syntax tree has more child elements than the DOM tree: ${extra.map(n => getText(n.from, n.to)).join(', ')}`);
    }
    if (domChildren.length > syntaxChildren.length) {
      const extra = domChildren.slice(syntaxChildren.length);
      throw new Error(`DOM tree has more child elements than the syntax tree: ${extra.map(n => n.tagName).join(', ')}`);
    }
  }

  if (syntaxNode.name !== "Document" || domNode.nodeType !== Node.DOCUMENT_NODE) {
    throw new Error("Invalid arguments. The root syntax node must be the top Document node and the DOM node must be a document. Received: " +
      `syntaxNode: ${syntaxNode.name}, domNode: ${Object.keys(Node)[domNode.nodeType - 1]}`);
  }

  const syntaxRoot = syntaxNode.firstChild ? findFirstSyntaxElement(syntaxNode.firstChild) : null;
  const domRoot = domNode.firstChild ? findFirstDomElement(domNode.firstChild) : null;

  if (!syntaxRoot || !domRoot) {
    console.warn("Could not find root elements in one or both trees");
    return { syntaxToDom, domToSyntax };
  }

  recursiveLink(syntaxRoot, domRoot);
  return { syntaxToDom, domToSyntax };
}

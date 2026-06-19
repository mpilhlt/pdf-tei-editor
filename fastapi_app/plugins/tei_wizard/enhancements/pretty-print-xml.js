/**
 * @file Enhancement: Pretty-prints an XML DOM Document by inserting whitespace text nodes.
 *
 * Indentation is added dynamically based on content: a node's children are indented only
 * when the node contains block-level child elements AND no significant free-floating text
 * between them. Nodes that contain only text and inline elements (e.g. a `<listBibl>` in
 * a training document that holds raw text, or a `<note>` with only `<lb/>`-separated lines)
 * are left untouched so text flow is preserved.
 *
 * The `tei.pretty-print.no-indent-inside` config list provides explicit overrides for
 * elements where the heuristic would be wrong (e.g. `bibl`, whose `author`/`title`
 * children are not in the inline list but should still not be indented). The
 * `tei.pretty-print.inline-elements` list names elements that never receive a leading
 * indent text node and are treated as leaf nodes for the block/inline heuristic.
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Pretty Print XML";

/**
 * Description shown in the UI
 */
export const description = "Pretty-prints the XML DOM by inserting whitespace text nodes for structural elements while preserving text flow inside inline/mixed-content nodes.";

/**
 * Elements whose children are never indented regardless of their content, used as an
 * explicit override when the dynamic heuristic would produce wrong results (e.g. `bibl`
 * contains `author`/`title` that aren't inline elements but whose content is still inline).
 * Configurable via `tei.pretty-print.no-indent-inside`.
 * @type {string[]}
 */
const DEFAULT_NO_INDENT_INSIDE = ['bibl', 'p', 'ab'];

/**
 * Elements that are always inline: they are excluded from the block-child heuristic,
 * never receive a leading indent text node, and their own children are not indented.
 * Configurable via `tei.pretty-print.inline-elements`.
 * @type {string[]}
 */
const DEFAULT_INLINE_ELEMENTS = [
  'lb', 'pb', 'cb', 'milestone',
  'hi', 'ref', 'ptr', 'seg',
  'choice', 'corr', 'sic', 'abbr', 'expan',
  'add', 'del', 'gap', 'supplied', 'unclear'
];

/**
 * Returns the local name of a DOM node, stripping any namespace prefix.
 * @param {Node} node
 * @returns {string}
 */
function getLocalName(node) {
  return /** @type {Element} */ (node).localName || node.nodeName.split(':').pop() || '';
}

/**
 * Removes all pure-whitespace text node descendants from `node`.
 * @param {Node} node
 */
function removeWhitespaceNodes(node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (/^\s*$/.test(child.nodeValue || '')) {
        node.removeChild(child);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      removeWhitespaceNodes(child);
    }
  }
}

/**
 * Returns true if `node` has at least one element child that is not in `inlineElements`.
 * @param {Node} node
 * @param {Set<string>} inlineElements
 * @returns {boolean}
 */
function hasBlockChildren(node, inlineElements) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && !inlineElements.has(getLocalName(child))) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if indentation should be added to `node`'s block-level children.
 *
 * Indent whenever the node has block-level element children (elements not in
 * `inlineElements`). Stray text nodes between block children are preserved as-is;
 * indentation is only inserted before/after block elements. Nodes that have NO
 * block children (only text and inline elements) are left untouched.
 *
 * @param {Node} node
 * @param {Set<string>} noIndentInside
 * @param {Set<string>} inlineElements
 * @returns {boolean}
 */
function shouldIndentChildren(node, noIndentInside, inlineElements) {
  const name = getLocalName(node);
  if (noIndentInside.has(name) || inlineElements.has(name)) return false;
  return hasBlockChildren(node, inlineElements);
}

/**
 * Recursively inserts indentation text nodes into `node`'s subtree.
 *
 * Indentation is skipped entirely when `shouldIndentChildren` returns false for `node`
 * (static override via `noIndentInside`/`inlineElements`, or dynamic: node has only
 * text/inline content, or has mixed block + text content).
 *
 * @param {Node} node
 * @param {number} depth - Current nesting depth (0 = direct children of root)
 * @param {string} spacing - Indentation unit (e.g. two spaces)
 * @param {Document} doc
 * @param {Set<string>} noIndentInside - Local names of explicit inline-content overrides
 * @param {Set<string>} inlineElements - Local names of always-inline elements
 */
function addIndentation(node, depth, spacing, doc, noIndentInside, inlineElements) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (!shouldIndentChildren(node, noIndentInside, inlineElements)) return;

  const indent = '\n' + spacing.repeat(depth);
  let lastBlockChild = null;

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const isInline = inlineElements.has(getLocalName(child));
    if (!isInline) {
      node.insertBefore(doc.createTextNode(indent + spacing), child);
      lastBlockChild = child;
    }
    addIndentation(child, depth + 1, spacing, doc, noIndentInside, inlineElements);
  }

  if (lastBlockChild !== null) {
    node.insertBefore(doc.createTextNode(indent), lastBlockChild.nextSibling);
  }
}

/**
 * Core pretty-print logic applied to a `root` element.
 *
 * @param {Element} root - The element to pretty-print in place
 * @param {Document} xmlDoc
 * @param {string} spacing
 * @param {Set<string>} noIndentInside
 * @param {Set<string>} inlineElements
 */
function prettyPrintElement(root, xmlDoc, spacing, noIndentInside, inlineElements) {
  removeWhitespaceNodes(root);

  const rootChildren = Array.from(root.childNodes);
  let lastProcessedRootNode = null;

  for (const child of rootChildren) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const isInline = inlineElements.has(getLocalName(child));
      if (!isInline) {
        root.insertBefore(xmlDoc.createTextNode('\n' + spacing), child);
        lastProcessedRootNode = child;
      }
      addIndentation(child, 1, spacing, xmlDoc, noIndentInside, inlineElements);
    } else if (child.nodeType === Node.PROCESSING_INSTRUCTION_NODE || child.nodeType === Node.COMMENT_NODE) {
      const nextSibling = child.nextSibling;
      if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE) {
        if (!(nextSibling.previousSibling && nextSibling.previousSibling.nodeType === Node.TEXT_NODE && nextSibling.previousSibling.nodeValue?.includes('\n'))) {
          root.insertBefore(xmlDoc.createTextNode('\n'), nextSibling);
        }
      }
      lastProcessedRootNode = child;
    } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.trim() !== '') {
      lastProcessedRootNode = child;
    }
  }

  const actualLastChild = root.lastChild;
  if (lastProcessedRootNode && !(actualLastChild && actualLastChild.nodeType === Node.TEXT_NODE && actualLastChild.nodeValue?.endsWith('\n'))) {
    root.appendChild(xmlDoc.createTextNode('\n'));
  }
}

/**
 * Pretty-prints an XML DOM Document by inserting whitespace text nodes.
 * This modifies the original document in place and returns it.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {object} currentState - The current application state (unused)
 * @param {Map<string, any>} configMap - The application configuration map
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  const spacing = '  ';
  const noIndentInside = new Set(configMap?.get('tei.pretty-print.no-indent-inside') ?? DEFAULT_NO_INDENT_INSIDE);
  const inlineElements = new Set(configMap?.get('tei.pretty-print.inline-elements') ?? DEFAULT_INLINE_ELEMENTS);

  prettyPrintElement(xmlDoc.documentElement, xmlDoc, spacing, noIndentInside, inlineElements);

  return xmlDoc;
}

/**
 * Standalone utility function for pretty-printing XML DOM.
 * Can be used independently of the enhancement system.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {string|null} selector - A selector for querySelector() that targets a sub-node
 * @param {string} [spacing='  '] - The string to use for each level of indentation
 * @param {Map<string, any>} [configMap] - Optional configuration map
 * @returns {Document} - The modified XML DOM Document object
 */
export function prettyPrintXmlDom(xmlDoc, selector = null, spacing = '  ', configMap = undefined) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  let root;
  if (selector) {
    root = xmlDoc.querySelector(selector);
    if (!root) {
      throw new Error(`Invalid selector: no node found for "${selector}"`);
    }
  } else {
    root = xmlDoc.documentElement;
  }

  const noIndentInside = new Set(configMap?.get('tei.pretty-print.no-indent-inside') ?? DEFAULT_NO_INDENT_INSIDE);
  const inlineElements = new Set(configMap?.get('tei.pretty-print.inline-elements') ?? DEFAULT_INLINE_ELEMENTS);

  prettyPrintElement(root, xmlDoc, spacing, noIndentInside, inlineElements);

  return xmlDoc;
}

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
 *
 * Some elements are kept: their content is left exactly as it is, including whitespace-only text
 * nodes, so that the space between two inline elements survives:
 *
 * - the review units of the document's variant (from the `findUnits` function of the execution
 *   environment); each unit starts on its own line and its ancestors are indented as block
 *   elements,
 * - in the `teiHeader`, the elements of `tei.pretty-print.header-keep` (default `desc`) and every
 *   element with mixed content (child elements and text that is not whitespace only).
 */

/**
 * @typedef {object} EnhancementEnv
 * @property {string|null} variant - Variant id of the document
 * @property {string|null} unitPath - Configured review unit path of the variant
 * @property {(doc: Document) => Element[]} findUnits - The review unit elements of a document
 */

/**
 * The elements that are treated differently from the generic heuristic
 * @typedef {object} PrettyPrintRules
 * @property {Set<string>} noIndentInside - Local names whose children are never indented
 * @property {Set<string>} inlineElements - Local names of always-inline elements
 * @property {Set<Node>} keep - Elements whose content is left untouched
 * @property {Set<Node>} units - Review units: kept, and always placed on their own line
 * @property {Set<Node>} forceBlock - Ancestors of units, whose children are always indented
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
 * Elements of the `teiHeader` whose content is never reformatted.
 * Configurable via `tei.pretty-print.header-keep`.
 * @type {string[]}
 */
const DEFAULT_HEADER_KEEP = ['desc'];

/**
 * Returns the local name of a DOM node, stripping any namespace prefix.
 * @param {Node} node
 * @returns {string}
 */
function getLocalName(node) {
  return /** @type {Element} */ (node).localName || node.nodeName.split(':').pop() || '';
}

/**
 * Removes all pure-whitespace text node descendants from `node`, except inside kept elements.
 * @param {Node} node
 * @param {Set<Node>} keep
 */
function removeWhitespaceNodes(node, keep) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (/^\s*$/.test(child.nodeValue || '')) {
        node.removeChild(child);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE && !keep.has(child)) {
      removeWhitespaceNodes(child, keep);
    }
  }
}

/**
 * Returns true if an element has mixed content: at least one child element and at least one text
 * child that is not whitespace only (whitespace as defined by XML: space, tab, CR, LF).
 * @param {Element} element
 * @returns {boolean}
 */
function hasMixedContent(element) {
  if (element.children.length === 0) return false;
  return Array.from(element.childNodes).some(child =>
    child.nodeType === Node.TEXT_NODE && /[^ \t\r\n]/.test(child.nodeValue || ''));
}

/**
 * Collects the elements of the `teiHeader` below `root` whose content is kept: those named in
 * `headerKeep` and those with mixed content. A kept element is not searched further.
 * @param {Element} root
 * @param {Set<string>} headerKeep
 * @param {Set<Node>} keep - Receives the kept elements
 */
function collectHeaderKeep(root, headerKeep, keep) {
  /** @param {Element} element */
  const walk = element => {
    for (const child of Array.from(element.children)) {
      if (headerKeep.has(getLocalName(child)) || hasMixedContent(child)) {
        keep.add(child);
      } else {
        walk(child);
      }
    }
  };
  /** @type {Element[]} */
  const headers = getLocalName(root) === 'teiHeader'
    ? [root]
    : Array.from(root.getElementsByTagNameNS('*', 'teiHeader'));
  headers.forEach(walk);
}

/**
 * Builds the rules of a pretty-print run.
 * @param {Element} root - The element that is pretty-printed
 * @param {Map<string, any>|undefined} configMap
 * @param {Element[]} units - The review units of the document
 * @returns {PrettyPrintRules}
 */
function buildRules(root, configMap, units) {
  const unitSet = new Set(units.filter(unit => root.contains(unit) && unit !== root));
  /** @type {Set<Node>} */
  const keep = new Set(unitSet);
  collectHeaderKeep(root, new Set(configMap?.get('tei.pretty-print.header-keep') ?? DEFAULT_HEADER_KEEP), keep);
  /** @type {Set<Node>} */
  const forceBlock = new Set();
  for (const unit of unitSet) {
    for (let node = unit.parentNode; node && node !== root.parentNode; node = node.parentNode) {
      forceBlock.add(node);
    }
  }
  return {
    noIndentInside: new Set(configMap?.get('tei.pretty-print.no-indent-inside') ?? DEFAULT_NO_INDENT_INSIDE),
    inlineElements: new Set(configMap?.get('tei.pretty-print.inline-elements') ?? DEFAULT_INLINE_ELEMENTS),
    keep,
    units: unitSet,
    forceBlock
  };
}

/**
 * Returns true if `child` is placed inline (without an indent text node before it).
 * @param {Node} child
 * @param {PrettyPrintRules} rules
 * @returns {boolean}
 */
function isInline(child, rules) {
  return rules.inlineElements.has(getLocalName(child)) && !rules.units.has(child);
}

/**
 * Returns true if `node` has at least one element child that is not inline.
 * @param {Node} node
 * @param {PrettyPrintRules} rules
 * @returns {boolean}
 */
function hasBlockChildren(node, rules) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && !isInline(child, rules)) {
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
 * Kept elements are never indented inside; the ancestors of review units always are.
 *
 * @param {Node} node
 * @param {PrettyPrintRules} rules
 * @returns {boolean}
 */
function shouldIndentChildren(node, rules) {
  if (rules.keep.has(node)) return false;
  if (rules.forceBlock.has(node)) return true;
  const name = getLocalName(node);
  if (rules.noIndentInside.has(name) || rules.inlineElements.has(name)) return false;
  return hasBlockChildren(node, rules);
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
 * @param {PrettyPrintRules} rules
 */
function addIndentation(node, depth, spacing, doc, rules) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (!shouldIndentChildren(node, rules)) return;

  const indent = '\n' + spacing.repeat(depth);
  let lastBlockChild = null;

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    if (!isInline(child, rules)) {
      node.insertBefore(doc.createTextNode(indent + spacing), child);
      lastBlockChild = child;
    }
    addIndentation(child, depth + 1, spacing, doc, rules);
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
 * @param {PrettyPrintRules} rules
 */
function prettyPrintElement(root, xmlDoc, spacing, rules) {
  removeWhitespaceNodes(root, rules.keep);

  const rootChildren = Array.from(root.childNodes);
  let lastProcessedRootNode = null;

  for (const child of rootChildren) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      if (!isInline(child, rules)) {
        root.insertBefore(xmlDoc.createTextNode('\n' + spacing), child);
        lastProcessedRootNode = child;
      }
      addIndentation(child, 1, spacing, xmlDoc, rules);
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
 * @param {EnhancementEnv} [env] - The execution environment, which provides the review units
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap, env) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  const root = xmlDoc.documentElement;
  const units = env?.findUnits ? env.findUnits(xmlDoc) : [];
  prettyPrintElement(root, xmlDoc, '  ', buildRules(root, configMap, units));

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
 * @param {Element[]} [units] - Review unit elements, see {@link execute}
 * @returns {Document} - The modified XML DOM Document object
 */
export function prettyPrintXmlDom(xmlDoc, selector = null, spacing = '  ', configMap = undefined, units = []) {
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

  prettyPrintElement(root, xmlDoc, spacing, buildRules(root, configMap, units));

  return xmlDoc;
}

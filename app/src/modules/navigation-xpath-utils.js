/**
 * Helpers for the XPath expressions of the node navigation (see the xpath-navigation plugin).
 */

/** Local names of the TEI milestone elements, which mark a position in the text instead of enclosing it */
export const MILESTONE_ELEMENTS = Object.freeze(['pb', 'cb', 'gb', 'lb', 'milestone'])

/**
 * Whether a node is an empty milestone element (see {@link MILESTONE_ELEMENTS}), such as `<pb/>`.
 * The navigation treats the text from a milestone to the next one of the same name as its range
 * (see `XMLEditor#getNodeRange()`).
 * @param {Node} node
 * @returns {boolean}
 */
export function isMilestone(node) {
  return node.nodeType === 1 /* Node.ELEMENT_NODE */ && !node.hasChildNodes()
    && MILESTONE_ELEMENTS.includes(/** @type {Element} */ (node).localName)
}

/** Namespace prefixes that navigation XPath expressions can use, as resolved by the XML editor */
export const NAVIGATION_XPATH_NAMESPACES = Object.freeze({
  tei: 'http://www.tei-c.org/ns/1.0',
  xml: 'http://www.w3.org/XML/1998/namespace'
})

/**
 * Checks that an XPath expression can be used for the node navigation: it must be an absolute
 * XPath 1.0 expression that selects nodes, using only the prefixes in `NAVIGATION_XPATH_NAMESPACES`.
 * @param {string} xpath
 * @param {Document} [doc] - Document whose XPath engine is used; defaults to `document`
 * @returns {string|null} The error message, or null if the expression is valid
 */
export function checkNavigationXpath(xpath, doc = document) {
  const expression = xpath.trim()
  if (!expression) return 'Enter an XPath expression'
  if (!expression.startsWith('/')) return "The XPath expression must start with '/'"
  const unknownPrefix = namespacePrefixes(expression).find(prefix => !(prefix in NAVIGATION_XPATH_NAMESPACES))
  if (unknownPrefix) {
    return `Unknown namespace prefix "${unknownPrefix}". Use ${Object.keys(NAVIGATION_XPATH_NAMESPACES).map(p => `"${p}:"`).join(' or ')}`
  }
  const xmlDoc = doc.implementation.createDocument(NAVIGATION_XPATH_NAMESPACES.tei, 'TEI', null)
  /** @param {string|null} prefix */
  const resolver = prefix => (prefix && NAVIGATION_XPATH_NAMESPACES[/** @type {'tei'|'xml'} */ (prefix)]) || null
  let result
  try {
    result = xmlDoc.evaluate(expression, xmlDoc, resolver, 0 /* XPathResult.ANY_TYPE */, null)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message ? `Invalid XPath expression: ${message}` : 'Invalid XPath expression'
  }
  // ANY_TYPE yields a node iterator for node-sets and a number, string or boolean result otherwise
  if (result.resultType !== 4 /* XPathResult.UNORDERED_NODE_ITERATOR_TYPE */) {
    return 'The XPath expression must select elements'
  }
  return null
}

/**
 * The namespace prefixes used in an XPath expression, outside of string literals
 * @param {string} xpath
 * @returns {string[]}
 */
export function namespacePrefixes(xpath) {
  const withoutLiterals = xpath.replace(/"[^"]*"|'[^']*'/g, '""')
  return [...withoutLiterals.matchAll(/(?<![\w.\-])([A-Za-z_][\w.\-]*):(?![:])/g)].map(match => match[1])
}

/**
 * The plain text of an HTML-escaped label, e.g. `&lt;bibl&gt;` → `<bibl>`
 * @param {string} html
 * @param {Document} [doc] - defaults to `document`
 * @returns {string}
 */
export function labelToText(html, doc = document) {
  const el = doc.createElement('textarea')
  el.innerHTML = html
  return el.value
}

/**
 * The 1-based index of the node to select when the navigation switches to another XPath expression,
 * so that it keeps its position in the document. If the new expression selects the current node or
 * one of its ancestors, that is the innermost of them; otherwise it is the first node, in document
 * order, after the start of the current node (which includes its descendants). If there is none, the
 * navigation wraps around to the first node.
 * For milestones (see {@link isMilestone}), it is the last one at or before the current node,
 * whose range holds it, or the first one if there is none.
 * @param {Node[]} nodes - The nodes of the new expression in document order
 * @param {Node} current - The current node, e.g. the element at the cursor
 * @returns {number} The index, or 0 if there are no nodes
 */
export function indexAtOrAfterNode(nodes, current) {
  if (nodes.length === 0) return 0
  if (isMilestone(nodes[0])) {
    // the milestone whose range holds the current node: the last one at or before it
    let index = 0
    nodes.forEach((node, i) => {
      if (node === current || Boolean(current.compareDocumentPosition(node) & 2 /* Node.DOCUMENT_POSITION_PRECEDING */)) index = i + 1
    })
    return index || 1
  }
  const positions = new Map(nodes.map((node, i) => [node, i + 1]))
  for (let node = /** @type {Node|null} */ (current); node; node = node.parentNode) {
    const position = positions.get(node)
    if (position) return position
  }
  const index = nodes.findIndex(node =>
    Boolean(current.compareDocumentPosition(node) & 4 /* Node.DOCUMENT_POSITION_FOLLOWING */))
  return index < 0 ? 1 : index + 1
}

/**
 * The xpath of the n-th node, in document order, of all nodes that a navigation expression selects,
 * in the form `(path)[n]` that the `xpath` state uses. Unlike `path[n]`, which counts siblings, this
 * is the n-th node of the whole document.
 * @param {string} path - The navigation expression, e.g. `//tei:listBibl/tei:bibl`
 * @param {number} index - 1-based
 * @returns {string} e.g. `(//tei:listBibl/tei:bibl)[3]`
 */
export function navigationXpath(path, index) {
  return `(${path})[${index}]`
}

/**
 * Splits a navigation xpath of the form `(path)[n]` into the expression and the index
 * @param {string|null|undefined} xpath
 * @returns {{path: string, index: number}|null} null if the xpath does not have this form or the
 *   expression is not absolute
 */
export function parseNavigationXpath(xpath) {
  const match = /^\((\/[\s\S]*)\)\[(\d+)\]$/.exec(xpath ?? '')
  if (!match) return null
  const index = parseInt(match[2], 10)
  return index > 0 ? { path: match[1], index } : null
}

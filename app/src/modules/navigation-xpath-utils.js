/**
 * Helpers for the XPath expressions of the node navigation (see the xpath-navigation plugin).
 */

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

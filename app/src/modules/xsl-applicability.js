/**
 * Decides whether a registered XSL stylesheet applies to a given XML document.
 *
 * A stylesheet applies when the document's root element is in the stylesheet's namespace and, if the
 * registration has an `appliesTo` test, that test passes. The test is either an XPath expression,
 * whose result is converted to a boolean (XPath `boolean()` semantics), or a function that receives
 * the document and returns a boolean.
 */

/**
 * Applicability test of a stylesheet: an XPath expression (prefixes `tei` and `xml` are bound) or
 * a function that receives the document.
 * @typedef {string | ((xmlDoc: Document) => boolean)} XslAppliesTo
 */

/**
 * The part of a stylesheet registration the applicability check reads
 * @typedef {object} XslApplicabilityRule
 * @property {string} label - Display label, used in warnings
 * @property {string} xmlns - Namespace of the root element the stylesheet applies to
 * @property {XslAppliesTo} [appliesTo] - Additional test; without it, every document in the namespace qualifies
 */

/** @type {Record<string, string>} */
const NAMESPACES = {
  tei: 'http://www.tei-c.org/ns/1.0',
  xml: 'http://www.w3.org/XML/1998/namespace'
};

/**
 * @param {string|null} prefix
 * @returns {string|null}
 */
function resolveNamespace(prefix) {
  return (prefix && NAMESPACES[prefix]) || null;
}

/**
 * Evaluates an XPath expression against a document and converts the result to a boolean
 * @param {Document} xmlDoc
 * @param {string} xpath
 * @returns {boolean}
 */
function evaluateXpathTest(xmlDoc, xpath) {
  const result = xmlDoc.evaluate(xpath, xmlDoc, resolveNamespace, XPathResult.ANY_TYPE, null);
  switch (result.resultType) {
    case XPathResult.BOOLEAN_TYPE:
      return result.booleanValue;
    case XPathResult.NUMBER_TYPE:
      return result.numberValue !== 0 && !Number.isNaN(result.numberValue);
    case XPathResult.STRING_TYPE:
      return result.stringValue.length > 0;
    default:
      return result.iterateNext() !== null;
  }
}

/**
 * Checks whether a stylesheet applies to a document. A failing test (invalid XPath, throwing
 * function) counts as "does not apply" and is logged.
 * @param {XslApplicabilityRule} rule
 * @param {Document|null} xmlDoc
 * @returns {boolean}
 */
export function stylesheetAppliesTo(rule, xmlDoc) {
  if (!xmlDoc?.documentElement) return false;
  if (xmlDoc.documentElement.namespaceURI !== rule.xmlns) return false;
  const test = rule.appliesTo;
  if (test === undefined || test === null) return true;
  try {
    return typeof test === 'function' ? test(xmlDoc) === true : evaluateXpathTest(xmlDoc, test);
  } catch (error) {
    console.warn(`XSL stylesheet "${rule.label}": applicability test failed:`, error);
    return false;
  }
}

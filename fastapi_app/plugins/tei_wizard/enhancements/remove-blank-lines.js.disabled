/**
 * @file Enhancement: Remove blank lines from an XML DOM Document.
 * Note: This enhancement is currently disabled as it needs more testing.
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Remove blank lines";

/**
 * Description shown in the UI
 */
export const description = "Remove blank lines from an XML DOM Document.";

/**
 * Removes blank lines from an XML DOM Document.
 * This modifies the original document object in place and returns it.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {Object} currentState - The current application state (unused)
 * @param {Map<string, any>} configMap - The application configuration map (unused)
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  if (!xmlDoc || typeof xmlDoc.documentElement === 'undefined') {
    console.error("Invalid XML Document object provided.");
    return xmlDoc;
  }

  /**
   * Recursively traverses the XML document and removes blank lines
   * from the tailing text nodes of each element.
   *
   * @param {Node} node The current node to process.
   */
  function traverse(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      let nextSibling = node.nextSibling;
      while (nextSibling && nextSibling.nodeType === Node.TEXT_NODE && nextSibling.nodeValue) {
        // Remove blank lines from the text node's content
        nextSibling.nodeValue = nextSibling.nodeValue.replaceAll(/[\r\n]+\s*[\r\n]+/gm, '');
        nextSibling = nextSibling.nextSibling;
      }
    }

    // Recursively call traverse for all child nodes
    for (const childNode of node.childNodes) {
      traverse(childNode);
    }
  }

  traverse(xmlDoc.documentElement);
  return xmlDoc;
}

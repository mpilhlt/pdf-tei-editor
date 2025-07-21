/**
 * @file Enhancement: remove blank lines from an XML DOM Document.
 */

/**
 * This modifies the original document object in place and returns it.
 *
 * @param {Document} xmlDoc - The XML DOM Document object.
 * @returns {Document} - The modified XML DOM Document object.
 */
export function removeBlankLines(xmlDoc) {
    if (!xmlDoc || typeof xmlDoc.documentElement === 'undefined') {
        console.error("Invalid XML Document object provided.");
        return xmlDoc; // Return unchanged if input is invalid
    }
    let counter = 0;
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
            
                // Remove blank lines from the text node's content, isn't working as expected
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
    // Return the document (which has been modified in place)
    return xmlDoc;
}

export default {
    name: "Remove blank lines",
    description: "Remove blank lines from an XML DOM Document.",
    execute: removeBlankLines
};
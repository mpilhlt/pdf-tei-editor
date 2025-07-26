/**
 * @file Enhancement: Pretty-prints an XML DOM Document by inserting whitespace text nodes.
 */

/**
 * This modifies the original document or node object in place and returns it.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {string|null} selector - A selector for `querySelector()` that targets a sub-node for pretty-printing
 * @param {string} [spacing='  '] - The string to use for each level of indentation (e.g., '  ' or '\t').
 * @returns {Document|Node} - The modified XML DOM Document object.
 */
export function prettyPrintXmlDom(xmlDoc, selector = null, spacing = '  ') {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`)
  }
  let root;
  if (selector) {
    root = xmlDoc.querySelector(selector)
    if (!root) {
      throw new Error(`Invalid selector: no node found for "${selector}"`) 
    }
  } else {
    root = xmlDoc.documentElement
  }

  // Helper function to remove existing pure whitespace text nodes
  // This cleans up any previous formatting or accidental whitespace
  function removeWhitespaceNodes(node) {
    // Iterate over children array because we might remove nodes
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        // Check if the text node consists only of whitespace characters (spaces, tabs, newlines, etc.)
        if (/^\s*$/.test(child.nodeValue)) {
          node.removeChild(child);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        removeWhitespaceNodes(child); // Recurse into elements
      }
      // Ignore other node types like comments, processing instructions for removal
    }
  }

  // Helper recursive function to add indentation
  function addIndentation(node, depth, spacing, doc) {
    // Only process Element nodes
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    // Create the indentation string for this depth level
    const indent = '\n' + spacing.repeat(depth);

    // Get a static list of children before we start modifying the list
    const children = Array.from(node.childNodes);

    let lastElementChild = null;
    let firstNonWsChild = null;

    // Find the first non-whitespace child (useful for deciding if to indent *after* the start tag)
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        firstNonWsChild = child;
        break;
      } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim() !== '') {
        firstNonWsChild = child;
        break;
      } else if (child.nodeType === Node.COMMENT_NODE || child.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
        firstNonWsChild = child; // Treat comments/PIs as breaking text flow
        break;
      }
    }


    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        // Add indentation *before* the element child
        // Only if it's the first child element OR if the previous sibling wasn't already a newline
        // Simpler approach: Just always add it if it's an element child. removeWhitespaceNodes cleans up duplicates later if needed, but our adding logic should prevent that.
        node.insertBefore(doc.createTextNode(indent + spacing), child);

        // Recursively indent the child's content
        addIndentation(child, depth + 1, spacing, doc);

        lastElementChild = child; // Keep track of the last element child processed
      }
      // Note: Text, Comment, PI nodes are not processed by this adding loop's main logic
      // They are handled implicitly by where we insert whitespace around elements
    }

    // After iterating through children, if there were any element children,
    // add indentation *before* the closing tag of the current node.
    // This is inserted after the last element child, or where the first non-element child was,
    // or at the end if only elements were children.
    if (lastElementChild !== null) {
      // Insert the closing tag indent *after* the last element child
      // Using insertBefore with null or lastChild.nextSibling appends
      node.insertBefore(doc.createTextNode(indent), lastElementChild.nextSibling);
    }
    // If there were no element children, the node will remain on one line with its text content
    // e.g., <desc>Corrections</desc> - this is standard pretty printing behavior.
  }

  // --- Main pretty-printing logic ---

  // Start by cleaning up any existing mixed whitespace/indentation
  removeWhitespaceNodes(root);

  // Add indentation for children of the root element
  // The root itself doesn't get preceding indentation (relative to nothing)
  const rootChildren = Array.from(root.childNodes); // Capture state before modification

  let lastProcessedRootNode = null; // Track the last significant node to decide on the final newline

  for (const child of rootChildren) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      // Add indent before root element children (relative to the root)
      root.insertBefore(xmlDoc.createTextNode('\n' + spacing), child);
      // Recursively indent the child and its descendants
      addIndentation(child, 1, spacing, xmlDoc); // Start recursion at depth 1 for children of root
      lastProcessedRootNode = child;
    } else if (child.nodeType === Node.PROCESSING_INSTRUCTION_NODE || child.nodeType === Node.COMMENT_NODE) {
      // Handle <?xml?> and comments at the top level.
      // Ensure they are followed by a newline if the next sibling is an element.
      const nextSibling = child.nextSibling;
      if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE) {
        // Check if there isn't already a text node immediately following that contains a newline
        if (!(nextSibling.previousSibling && nextSibling.previousSibling.nodeType === Node.TEXT_NODE && nextSibling.previousSibling.nodeValue?.includes('\n'))) {
          root.insertBefore(xmlDoc.createTextNode('\n'), nextSibling);
        }
      }
      lastProcessedRootNode = child; // These count as processed for the final newline
    } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.trim() !== '') {
      // Handle non-whitespace text nodes directly under root (uncommon in TEI, but possible)
      // We don't add indent before or after these typically in simple pretty-printing
      lastProcessedRootNode = child;
    }
    // Pure whitespace text nodes were removed by removeWhitespaceNodes
  }

  // Add a final newline before the root's closing tag IF there was any content
  // (Element, non-whitespace text, PI, or Comment) processed at the root level.
  // Check if the last child of the root after modifications is a text node ending in newline
  let actualLastChild = root.lastChild;
  if (lastProcessedRootNode && !(actualLastChild && actualLastChild.nodeType === Node.TEXT_NODE && actualLastChild.nodeValue?.endsWith('\n'))) {
    root.appendChild(xmlDoc.createTextNode('\n')); // Append newline before </root>
  }


  // Return the document (which has been modified in place)
  return xmlDoc;
}

export default {
  name: "Pretty Print XML",
  description: "Pretty-prints the XML DOM by inserting whitespace text nodes.",
  execute: prettyPrintXmlDom
};
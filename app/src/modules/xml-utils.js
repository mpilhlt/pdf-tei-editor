/**
 * @file XML utility functions shared across the application.
 */

/**
 * Pretty-prints an XML DOM Document by inserting whitespace text nodes.
 * This modifies the original document or node object in place and returns it.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {string|null} selector - A selector for querySelector() that targets a sub-node for pretty-printing
 * @param {string} [spacing='  '] - The string to use for each level of indentation (e.g., '  ' or '\t').
 * @returns {Document} - The modified XML DOM Document object.
 */
export function prettyPrintXmlDom(xmlDoc, selector = null, spacing = '  ') {
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

  // Helper function to remove existing pure whitespace text nodes
  function removeWhitespaceNodes(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (/^\s*$/.test(child.nodeValue)) {
          node.removeChild(child);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        removeWhitespaceNodes(child);
      }
    }
  }

  // Helper recursive function to add indentation
  function addIndentation(node, depth, spacing, doc) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const indent = '\n' + spacing.repeat(depth);
    const children = Array.from(node.childNodes);

    let lastElementChild = null;

    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        node.insertBefore(doc.createTextNode(indent + spacing), child);
        addIndentation(child, depth + 1, spacing, doc);
        lastElementChild = child;
      }
    }

    if (lastElementChild !== null) {
      node.insertBefore(doc.createTextNode(indent), lastElementChild.nextSibling);
    }
  }

  // Clean up existing whitespace
  removeWhitespaceNodes(root);

  // Add indentation
  const rootChildren = Array.from(root.childNodes);
  let lastProcessedRootNode = null;

  for (const child of rootChildren) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      root.insertBefore(xmlDoc.createTextNode('\n' + spacing), child);
      addIndentation(child, 1, spacing, xmlDoc);
      lastProcessedRootNode = child;
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

  // Add final newline before closing tag
  const actualLastChild = root.lastChild;
  if (lastProcessedRootNode && !(actualLastChild && actualLastChild.nodeType === Node.TEXT_NODE && actualLastChild.nodeValue?.endsWith('\n'))) {
    root.appendChild(xmlDoc.createTextNode('\n'));
  }

  return xmlDoc;
}

/**
 * @file Enhancement: Pretty-prints an XML DOM Document by inserting whitespace text nodes.
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "Pretty Print XML";

/**
 * Description shown in the UI
 */
export const description = "Pretty-prints the XML DOM by inserting whitespace text nodes.";

/**
 * Pretty-prints an XML DOM Document by inserting whitespace text nodes.
 * This modifies the original document in place and returns it.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {Object} currentState - The current application state (unused)
 * @param {Map<string, any>} configMap - The application configuration map (unused)
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  if (!(xmlDoc instanceof Document)) {
    throw new Error(`Invalid parameter: Expected document, got ${xmlDoc}`);
  }

  const spacing = '  ';
  const root = xmlDoc.documentElement;

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

/**
 * Standalone utility function for pretty-printing XML DOM.
 * Can be used independently of the enhancement system.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {string|null} selector - A selector for querySelector() that targets a sub-node
 * @param {string} [spacing='  '] - The string to use for each level of indentation
 * @returns {Document} - The modified XML DOM Document object
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
